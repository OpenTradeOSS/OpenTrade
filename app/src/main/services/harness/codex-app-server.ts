import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { OPENTRADE_HOME } from "../../db/client";
import { hostLog } from "../../host/log";

/**
 * Per-agent `codex app-server` supervision + an episodic JSON-RPC client.
 *
 * The server is the durable engine for a codex agent: it owns the live thread,
 * executes turns (model calls, MCP tools, hooks), and fans events out to every
 * connected client. The stock codex TUI in the agent's PTY auto-attaches to it
 * via the control socket under the agent's `CODEX_HOME`; the backend connects
 * only when it has work (create a thread, deliver a wake, run a headless turn)
 * and disconnects when the episode ends — there is no standing connection to
 * babysit. `thread/resume` hot-rejoins with full state (including replay of
 * pending approval requests), so a late-connecting client misses nothing.
 *
 * Fail-closed property (verified in the Phase-0 spike): an order tool gated with
 * `approval_mode = "prompt"` raises a server→client `mcpServer/elicitation/request`;
 * if the answering client errors or disconnects, codex treats it as Decline.
 */

/** Control socket path for an agent's server, relative to its CODEX_HOME. */
export function controlSocketPath(codexHome: string): string {
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

/**
 * A codex agent's CODEX_HOME. NOT inside the agent dir: the TUI's auto-attach
 * connects to `$CODEX_HOME/app-server-control/app-server-control.sock` by its
 * literal path string, and unix sockets cap that string at ~104 bytes (SUN_LEN)
 * on macOS — an agent-dir-relative home overflows it for long slugs and for dev
 * worktree OPENTRADE_HOMEs. So codex state (config, sessions, auth link, the
 * socket) lives at a short, stable per-agent path under `~/.opentrade/cx/`,
 * keyed by a hash of (OPENTRADE_HOME, slug) so parallel dev homes never collide.
 * Parity note: claude keeps its transcripts outside the agent dir too
 * (`~/.claude/projects`), so the agent folder stays pure work product.
 */
export function codexHomeFor(agentSlug: string): string {
  const key = createHash("sha256").update(`${OPENTRADE_HOME}:${agentSlug}`).digest("hex");
  return join(homedir(), ".opentrade", "cx", key.slice(0, 10));
}

/** The server itself couldn't be brought up (spawn/socket/crash-loop) — a config
 *  fault, distinct from a thread that fails to resume. */
export class CodexServerUnavailableError extends Error {}

const CONNECT_TIMEOUT_MS = 10_000;
/** How long ensureServer waits for the socket to accept after spawning. */
const SPAWN_WAIT_MS = 15_000;
/** Consecutive fast server crashes before ensureServer refuses (broken install). */
const MAX_FAST_CRASHES = 3;
const FAST_CRASH_MS = 5_000;
/** After this long without a crash, the fast-crash breaker resets on its own so a
 *  user who fixed the cause (reinstalled codex) recovers without a host restart (B9). */
const CRASH_BREAKER_COOLDOWN_MS = 30_000;

export interface CodexTurnEvents {
  /** turn/start acknowledged (delivery confirmation) — the wake is in the session. */
  onAccepted?: (turnId: string) => void;
}

export type CodexTurnOutcome =
  | { outcome: "completed" }
  | { outcome: "failed"; error: string }
  | { outcome: "interrupted" };

/**
 * Answers server→client requests that arrive while the backend is driving a
 * turn (approvals/elicitations). Implemented by the harness glue: order tools
 * route to the ApprovalService card; everything else follows headless parity
 * (auto-allow, like claude's `--dangerously-skip-permissions`).
 */
export type ServerRequestAnswerer = (
  agentId: string,
  method: string,
  params: unknown,
  /** Aborts if the connection closes before the answer is produced, so a pending
   *  order card can be abandoned rather than lingering to its timeout. */
  signal?: AbortSignal,
) => Promise<unknown>;

interface ServerEntry {
  child: ChildProcess;
  codexHome: string;
  startedAt: number;
}

export class CodexAppServerManager {
  private servers = new Map<string, ServerEntry>();
  private fastCrashes = new Map<string, number>();
  /** When the agent's server last exited — drives the crash-breaker cooldown (B9). */
  private lastCrashAt = new Map<string, number>();
  /** In-flight `ensureServer` per agent — a concurrent caller must await the SAME
   *  bring-up (which only resolves once the socket is listening AND hooks are
   *  trusted), not get the socket path back before it's ready (B6). */
  private ensuring = new Map<string, Promise<string>>();
  private stopping = false;

  constructor(
    /** Env for the server child (buildAgentEnv + OPENTRADE_* + strip keys). */
    private envFor: (agentId: string, codexHome: string) => Record<string, string>,
    private answerer: ServerRequestAnswerer,
    /** Overridable for dev machines where `codex` on PATH is a wrapper that
     *  injects `-c` overrides (which would break TUI auto-attach). */
    private binary: string = process.env.OPENTRADE_CODEX_BIN ?? "codex",
  ) {}

  /** PID of the agent's live server child (for the crash-recovery spawn marker). */
  serverPid(agentId: string): number | null {
    return this.servers.get(agentId)?.child.pid ?? null;
  }

  /**
   * Ensure the agent's app-server is running; resolves to its control socket.
   * The child is host-owned (not detached): it dies with the host, and the
   * spawn-marker reconcile covers a host crash.
   */
  async ensureServer(agentId: string, codexHome: string): Promise<string> {
    const sock = controlSocketPath(codexHome);
    const entry = this.servers.get(agentId);
    if (entry && entry.child.exitCode === null && !entry.child.killed) return sock;
    // A concurrent bring-up is already running — share it (don't hand the socket
    // back before it's actually listening + hooks trusted).
    const inflight = this.ensuring.get(agentId);
    if (inflight) return inflight;
    const p = this.ensureServerInner(agentId, codexHome, sock).finally(() => {
      if (this.ensuring.get(agentId) === p) this.ensuring.delete(agentId);
    });
    this.ensuring.set(agentId, p);
    return p;
  }

  private async ensureServerInner(
    agentId: string,
    codexHome: string,
    sock: string,
  ): Promise<string> {
    // Never resurrect a server while the host is tearing down — a wake/adoption poll
    // racing shutdown would otherwise orphan a fresh child the exiting host won't kill (E3).
    if (this.stopping) {
      throw new CodexServerUnavailableError(`host is shutting down; not starting codex server`);
    }

    // Self-heal the breaker: if the last crash was a while ago, the underlying fault
    // may be fixed — give it a fresh set of attempts rather than requiring a host restart.
    const lastCrash = this.lastCrashAt.get(agentId) ?? 0;
    if (lastCrash && Date.now() - lastCrash > CRASH_BREAKER_COOLDOWN_MS) {
      this.fastCrashes.delete(agentId);
    }
    if ((this.fastCrashes.get(agentId) ?? 0) >= MAX_FAST_CRASHES) {
      throw new CodexServerUnavailableError(
        `codex app-server for ${agentId} keeps crashing; giving up`,
      );
    }

    mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
    // A stale socket file from a dead server blocks the new listener.
    try {
      rmSync(sock, { force: true });
    } catch {
      // best effort
    }

    const startedAt = Date.now();
    const child = spawn(this.binary, ["app-server", "--listen", `unix://${sock}`], {
      env: { ...this.envFor(agentId, codexHome), CODEX_HOME: codexHome },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    child.stderr?.on("data", (c) => {
      stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    child.on("exit", (code) => {
      this.servers.delete(agentId);
      if (this.stopping) return;
      const fast = Date.now() - startedAt < FAST_CRASH_MS;
      this.fastCrashes.set(agentId, fast ? (this.fastCrashes.get(agentId) ?? 0) + 1 : 0);
      this.lastCrashAt.set(agentId, Date.now());
      hostLog.warn(
        "codex app-server exited",
        agentId,
        `code=${code}`,
        stderrTail.trim() ? `stderr: ${stderrTail.trim()}` : "",
      );
    });
    child.on("error", (err) => {
      this.servers.delete(agentId);
      hostLog.error("codex app-server spawn failed", agentId, String(err));
    });
    this.servers.set(agentId, { child, codexHome, startedAt });

    await waitForSocket(sock, SPAWN_WAIT_MS);
    // Codex only executes TRUSTED hooks; our generated gate hooks must be
    // trusted the same way the TUI's /hooks command does it — a `hooks.state`
    // batchWrite keyed by each hook's current hash. Best-effort: a failure only
    // disables the REDUNDANT gate layer (the per-tool approval anchor is core-
    // enforced and cannot fail open), but log it loudly.
    await this.trustHooks(agentId, sock);
    return sock;
  }

  /** Pre-trust the generated hooks so they actually execute (hooks/list →
   *  config/batchWrite of `hooks.state` trusted hashes, as the TUI does). */
  private async trustHooks(agentId: string, sock: string): Promise<void> {
    try {
      const client = await CodexClient.connect(sock);
      try {
        // User-level hooks (CODEX_HOME/hooks.json) list for any cwd.
        const res = (await client.request("hooks/list", { cwds: [homedir()] })) as {
          data?: Array<{
            hooks?: Array<{ key: string; currentHash: string; trustStatus: string }>;
          }>;
        };
        const value: Record<string, { trusted_hash: string }> = {};
        for (const entry of res?.data ?? []) {
          for (const h of entry.hooks ?? []) {
            if (h.trustStatus !== "trusted") value[h.key] = { trusted_hash: h.currentHash };
          }
        }
        if (Object.keys(value).length > 0) {
          await client.request("config/batchWrite", {
            edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }],
            reloadUserConfig: true,
          });
        }
      } finally {
        client.close();
      }
    } catch (err) {
      // Loud, not a warn (F4): with hooks untrusted, the PreToolUse gate layer never
      // runs — and for USER-driven interactive orders (answered natively in the TUI,
      // where the elicitation anchor doesn't route through us) the hook is the ONLY
      // source of the OpenTrade approval card, audit row, and outcome record. A silent
      // failure means such an order executes with zero OpenTrade trace. Backend-driven
      // (wake/headless) orders are unaffected — the elicitation anchor still gates those.
      hostLog.error(
        "codex hook trust setup FAILED — user-driven interactive orders will have NO " +
          "OpenTrade approval card/audit/outcome (backend-driven orders still gated by the " +
          "per-tool approval anchor)",
        agentId,
        String(err),
      );
    }
  }

  /** SIGTERM the agent's server (archive / broken-restart). Also clears the fast-crash
   *  breaker: an explicit stop/restart is a deliberate "start clean" signal (B9). */
  stopServer(agentId: string): void {
    this.fastCrashes.delete(agentId);
    this.lastCrashAt.delete(agentId);
    const entry = this.servers.get(agentId);
    if (!entry) return;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    this.servers.delete(agentId);
  }

  /** Host shutdown: stop every server. */
  stopAll(): void {
    this.stopping = true;
    for (const [agentId] of this.servers) this.stopServer(agentId);
  }

  /**
   * Create a brand-new thread for the agent (first spawn / fresh restart).
   * Returns the server-minted thread id — the caller persists it as
   * `agents.last_session_id`.
   */
  async createThread(agentId: string, codexHome: string, cwd: string): Promise<string> {
    const sock = await this.ensureServer(agentId, codexHome);
    const client = await CodexClient.connect(sock, (m, p, signal) =>
      this.answerer(agentId, m, p, signal),
    );
    try {
      const res = (await client.request("thread/start", {
        cwd,
        approvalPolicy: "on-request",
      })) as { thread?: { id?: string } };
      const id = res?.thread?.id;
      if (!id) throw new Error("thread/start returned no thread id");
      return id;
    } finally {
      client.close();
    }
  }

  /** The thread ids currently loaded in the agent's server. Used for TUI-thread
   *  adoption (bare-start discovery) and the not-running-Embedded assertion. */
  async loadedThreads(agentId: string, codexHome: string): Promise<string[]> {
    const sock = await this.ensureServer(agentId, codexHome);
    const client = await CodexClient.connect(sock, (m, p, signal) =>
      this.answerer(agentId, m, p, signal),
    );
    try {
      const res = (await client.request("thread/loaded/list", {})) as { data?: string[] };
      return res?.data ?? [];
    } finally {
      client.close();
    }
  }

  /** Is this thread loaded in OUR server? (the not-running-Embedded assertion). */
  async isThreadLoaded(agentId: string, codexHome: string, threadId: string): Promise<boolean> {
    return (await this.loadedThreads(agentId, codexHome)).includes(threadId);
  }

  /**
   * Run one turn on the agent's thread and wait for it to finish. The episodic
   * connection lives exactly as long as the turn. If a turn is already in
   * flight (e.g. the user is mid-conversation in the TUI), we wait for its
   * `turn/completed` and then deliver — wakes queue for idle by design (no
   * steer). `signal` aborts via `turn/interrupt` (the max-runtime kill).
   */
  async runTurn(
    agentId: string,
    codexHome: string,
    threadId: string,
    prompt: string,
    opts?: { signal?: AbortSignal; events?: CodexTurnEvents },
  ): Promise<CodexTurnOutcome> {
    const sock = await this.ensureServer(agentId, codexHome);
    const client = await CodexClient.connect(sock, (m, p, signal) =>
      this.answerer(agentId, m, p, signal),
    );
    try {
      // thread/resume subscribes this connection AND consults the rollout store —
      // which doesn't exist yet for a freshly-created (turnless) thread, even
      // though the thread is loaded server-side. Tolerate that: turn/start is
      // thread-scoped and works regardless (it's what creates the rollout).
      let subscribed = false;
      let resumed: { thread?: { status?: { type?: string } } } | undefined;
      try {
        resumed = (await client.request("thread/resume", { threadId })) as typeof resumed;
        subscribed = true;
      } catch (err) {
        if (!/no rollout found/i.test(String(err))) throw err;
      }

      // Deliver on idle: if a turn is active, wait for the boundary first.
      if (resumed?.thread?.status?.type === "active") {
        await client.waitForTurnEnd(threadId, opts?.signal);
      }
      if (opts?.signal?.aborted) return { outcome: "interrupted" };

      const started = (await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      })) as { turn?: { id?: string } };
      const turnId = started?.turn?.id;
      if (!turnId) throw new Error("turn/start returned no turn id");
      opts?.events?.onAccepted?.(turnId);

      if (!subscribed) {
        // The turn just created the rollout — subscribe now so turn events flow.
        await client.request("thread/resume", { threadId }).catch(() => {});
      }

      const onAbort = () => {
        client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Notifications are the fast path; the thread/read poll is the safety
        // net for any subscription gap (a missed turn/completed must not hang a
        // wake forever — the coordinator's kill timer is the only other bound).
        return await Promise.race([
          client.waitForTurnOutcome(threadId, turnId),
          this.pollTurnOutcome(client, threadId, turnId, opts?.signal),
        ]);
      } finally {
        opts?.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      client.close();
    }
  }

  /** Poll thread/read until our turn reports a terminal status (subscription-free
   *  fallback; resolves slightly later than the notification path). */
  private async pollTurnOutcome(
    client: CodexClient,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<CodexTurnOutcome> {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2_500));
      if (signal?.aborted) return { outcome: "interrupted" };
      // The notification path won the race and `runTurn` closed the client — stop
      // polling instead of spinning forever on requests that now reject (B2). The
      // race is already settled, so this return value is discarded.
      if (client.isClosed) return { outcome: "completed" };
      try {
        const res = (await client.request("thread/read", {
          threadId,
          includeTurns: true,
        })) as {
          thread?: { status?: { type?: string }; turns?: Array<{ id: string; status?: string }> };
        };
        const turn = res?.thread?.turns?.find((t) => t.id === turnId);
        if (turn?.status === "completed") return { outcome: "completed" };
        if (turn?.status === "failed") return { outcome: "failed", error: "turn failed" };
        if (turn?.status === "interrupted") return { outcome: "interrupted" };
        // No per-turn record but the thread is idle again → treat as completed.
        if (!turn && res?.thread?.status?.type === "idle") return { outcome: "completed" };
      } catch {
        // transient read failure — keep polling (the connection close rejects
        // waitForTurnOutcome, which settles the race)
      }
    }
  }
}

/** Wait for the unix socket to accept a WS handshake. */
async function waitForSocket(sock: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (existsSync(sock)) {
      try {
        const probe = await CodexClient.rawConnect(sock, 2000);
        probe.close();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(250);
  }
  throw new CodexServerUnavailableError(
    `codex app-server socket never came up: ${sock} (${lastErr ?? "no socket"})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface PendingReq {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal JSON-RPC client over the app-server's WebSocket-over-UDS transport.
 * Spike-verified handshake quirks: `perMessageDeflate: false` and a plain
 * `Host: localhost` header are REQUIRED (the default `ws` handshake is dropped).
 */
export class CodexClient {
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private turnWaiters: Array<(msg: { method: string; params: unknown }) => void> = [];
  private closed = false;
  /** Abort controllers for in-flight server→client requests (approvals), so a
   *  connection close abandons any pending order card instead of stranding it. */
  private serverReqAborts = new Set<AbortController>();

  private constructor(
    private ws: WebSocket,
    private onServerRequest?: (
      method: string,
      params: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      this.closed = true;
      for (const ac of this.serverReqAborts) ac.abort();
      this.serverReqAborts.clear();
      this.failAll(new Error("codex app-server connection closed"));
    });
    ws.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  /** True once the socket has closed — lets background pollers stop instead of
   *  spinning on requests that will reject forever (B2). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Connect + initialize (the normal entry point). */
  static async connect(
    sock: string,
    onServerRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  ): Promise<CodexClient> {
    const client = await CodexClient.rawConnect(sock, CONNECT_TIMEOUT_MS, onServerRequest);
    await client.request("initialize", {
      clientInfo: { name: "opentrade", title: "OpenTrade", version: "1" },
    });
    client.notify("initialized", {});
    return client;
  }

  /** Connect without initializing (socket health probe). */
  static rawConnect(
    sock: string,
    timeoutMs: number,
    onServerRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>,
  ): Promise<CodexClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${sock}:/`, {
        perMessageDeflate: false,
        headers: { Host: "localhost" },
        handshakeTimeout: timeoutMs,
      });
      ws.once("open", () => resolve(new CodexClient(ws, onServerRequest)));
      ws.once("error", (err) => reject(err));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  /** Resolve when the active turn on `threadId` ends (completed OR failed). */
  waitForTurnEnd(threadId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = (msg: { method: string; params: unknown }) => {
        const p = msg.params as { threadId?: string } | undefined;
        if (p?.threadId !== threadId) return;
        if (msg.method === "turn/completed" || msg.method === "turn/failed") {
          remove();
          resolve();
        }
      };
      const remove = () => {
        this.turnWaiters = this.turnWaiters.filter((w) => w !== waiter);
      };
      signal?.addEventListener(
        "abort",
        () => {
          remove();
          resolve(); // caller checks signal.aborted
        },
        { once: true },
      );
      this.turnWaiters.push(waiter);
      // Connection death must not strand the wait.
      this.ws.once("close", () => {
        remove();
        reject(new Error("connection closed while waiting for turn end"));
      });
    });
  }

  /** Resolve with the outcome of a specific turn we started. */
  waitForTurnOutcome(threadId: string, turnId: string): Promise<CodexTurnOutcome> {
    return new Promise((resolve, reject) => {
      const waiter = (msg: { method: string; params: unknown }) => {
        const p = msg.params as
          | { threadId?: string; turn?: { id?: string; status?: string; error?: unknown } }
          | undefined;
        if (p?.threadId !== threadId || p?.turn?.id !== turnId) return;
        if (msg.method === "turn/completed") {
          remove();
          const status = p.turn?.status;
          if (status === "interrupted") resolve({ outcome: "interrupted" });
          else if (status === "failed")
            resolve({ outcome: "failed", error: String(p.turn?.error ?? "turn failed") });
          else resolve({ outcome: "completed" });
        } else if (msg.method === "turn/failed") {
          remove();
          resolve({ outcome: "failed", error: String(p.turn?.error ?? "turn failed") });
        }
      };
      const remove = () => {
        this.turnWaiters = this.turnWaiters.filter((w) => w !== waiter);
      };
      this.turnWaiters.push(waiter);
      this.ws.once("close", () => {
        remove();
        reject(new Error("connection closed while waiting for turn outcome"));
      });
    });
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // Server→client request (approval / elicitation). Unanswerable requests are
      // rejected with a JSON-RPC error, which codex treats as Decline — fail closed.
      const { id, method, params } = msg;
      if (!this.onServerRequest) {
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "opentrade: no handler for this request" },
          }),
        );
        return;
      }
      // Tie the answer to a signal aborted on connection close, so a pending order
      // card is abandoned (not left to its full timeout) if the connection drops.
      const ac = new AbortController();
      this.serverReqAborts.add(ac);
      this.onServerRequest(method, params, ac.signal)
        .then((result) => this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result })))
        .catch((err) =>
          this.ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: String(err) },
            }),
          ),
        )
        .finally(() => this.serverReqAborts.delete(ac));
    } else if (msg.method) {
      for (const w of [...this.turnWaiters]) w({ method: msg.method, params: msg.params });
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
