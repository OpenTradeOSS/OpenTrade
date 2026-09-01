import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PreToolUseDecision } from "@shared/approval";
import { CronCreateInput, MonitorCreateInput } from "@shared/schedule";
import type { AgentRegistry } from "../agents/registry";
import type { ApprovalService } from "../approvals";
import type { BrokerService } from "../broker";
import type { Scheduler } from "../scheduler";
import type { WakeTransport } from "../scheduler/wake/types";
import type { StatusArbiter } from "../status/arbiter";

/** How long a `/wake-stream` long-poll is held open before returning empty (the
 *  agent's channel poller then immediately re-polls). */
const WAKE_STREAM_HOLD_MS = 60_000;

interface Deps {
  broker: BrokerService;
  approvals: ApprovalService;
  registry: AgentRegistry;
  arbiter: StatusArbiter;
  /** Desired bind port. Stable (home-derived) in the app; omit (→ ephemeral) in tests. */
  port?: number;
  /** Persisted bearer token. Reused across restarts; omit (→ random) in tests. */
  token?: string;
}

/** EADDRINUSE retries before falling back to an ephemeral port. Covers the dev
 *  HMR window where the previous process hasn't released the port yet. */
const BIND_RETRIES = 5;
const BIND_RETRY_MS = 300;

/**
 * Localhost HTTP server injected into agent PTYs as OPENTRADE_PORT/OPENTRADE_TOKEN.
 *
 * - Market-data faucet (M2): a pull-through cache over the broker so agents'
 *   Monitor watch-scripts can poll prices/positions without hammering Robinhood:
 *     GET /quotes/:symbol?maxAge=5   GET /positions?maxAge=30
 *     GET /option-positions?maxAge=30   GET /crypto-positions?maxAge=30
 * - Hook endpoints (M3): the PreToolUse approval gate and the Notification/Stop
 *   status feed, called by the scaffolded hook scripts in each agent folder:
 *     POST /hook/pretool-approval   POST /hook/status
 *
 * Bound to 127.0.0.1 with a per-launch bearer token (x-opentrade-token). The
 * hook scripts fail CLOSED if this server is unreachable, so a manually-launched
 * `claude` can't place orders while the app is gone.
 */
export class LocalApiServer {
  readonly token: string;
  private server: Server | null = null;
  private _port = 0;
  private desiredPort: number;
  /** Late-bound: the scheduler is constructed after the LocalApiServer (it depends
   *  on the wake transport, which depends on this server's port/token). */
  private scheduler: Scheduler | null = null;
  /** Late-bound: the wake transport backing the `/wake-stream` long-poll (the single
   *  wake authority — owns the queue + the parked-poll rendezvous). */
  private wake: WakeTransport | null = null;

  constructor(private deps: Deps) {
    this.token = deps.token ?? randomBytes(24).toString("hex");
    this.desiredPort = deps.port ?? 0;
  }

  /** Wire the scheduler in once it's built (enables the /schedules/* routes). */
  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
  }

  /** Wire the wake transport in once built (enables the /wake-stream route). */
  setWake(wake: WakeTransport): void {
    this.wake = wake;
  }

  private get broker(): BrokerService {
    return this.deps.broker;
  }

  get port(): number {
    return this._port;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => json(res, 502, { error: String(err) }));
    });
    return this.listen(this.desiredPort, BIND_RETRIES);
  }

  /**
   * Bind, retrying on EADDRINUSE. A stale process (e.g. a dev HMR restart) may
   * briefly hold the stable port; we retry, then fall back to an ephemeral port
   * as a last resort so the app still starts (degraded — staleness can return
   * until the next clean launch; the single-instance lock prevents the common
   * collision).
   */
  private listen(port: number, retries: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("error", onError);
        if (err.code !== "EADDRINUSE") return reject(err);
        if (retries > 0) {
          setTimeout(() => this.listen(port, retries - 1).then(resolve, reject), BIND_RETRY_MS);
        } else if (port !== 0) {
          console.error(`[local-api] port ${port} in use after retries; falling back to ephemeral`);
          this.listen(0, 0).then(resolve, reject);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        server.on("error", (err) => console.error("[local-api] server error", err));
        const addr = server.address();
        if (addr && typeof addr === "object") this._port = addr.port;
        resolve();
      });
    });
  }

  stop() {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);

    if (url.pathname === "/health") return json(res, 200, { ok: true });

    if (req.headers["x-opentrade-token"] !== this.token) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (req.method === "POST" && url.pathname === "/hook/pretool-approval") {
      return this.handleApproval(req, res);
    }
    if (req.method === "POST" && url.pathname === "/hook/status") {
      return this.handleStatus(req, res);
    }
    if (req.method === "POST" && url.pathname === "/hook/order-result") {
      return this.handleOrderResult(req, res);
    }

    if (req.method === "GET" && url.pathname === "/wake-stream") {
      return this.handleWakeStream(req, res);
    }
    if (url.pathname.startsWith("/schedules")) {
      return this.handleSchedules(req, res, url);
    }

    const quoteMatch = url.pathname.match(/^\/quotes\/([A-Za-z0-9.-]+)$/);
    if (quoteMatch) {
      const symbol = quoteMatch[1].toUpperCase();
      const maxAge = (Number(url.searchParams.get("maxAge")) || 5) * 1000;
      const quote = await this.broker.getQuote(symbol, maxAge);
      return quote ? json(res, 200, quote) : json(res, 404, { error: "no quote" });
    }
    if (url.pathname === "/positions") {
      const maxAge = (Number(url.searchParams.get("maxAge")) || 30) * 1000;
      return json(res, 200, await this.broker.getPositionsLive(maxAge));
    }
    if (url.pathname === "/option-positions") {
      const maxAge = (Number(url.searchParams.get("maxAge")) || 30) * 1000;
      return json(res, 200, await this.broker.getOptionPositionsLive(maxAge));
    }
    if (url.pathname === "/crypto-positions") {
      const maxAge = (Number(url.searchParams.get("maxAge")) || 30) * 1000;
      return json(res, 200, await this.broker.getCryptoPositionsLive(maxAge));
    }
    return json(res, 404, { error: "not found" });
  }

  /**
   * PreToolUse gate. The hook POSTs the Claude Code hook payload
   * (`{ tool_name, tool_input, session_id, ... }`); we register an approval and
   * long-poll until decided/timeout, then return the verbatim PreToolUse decision
   * the script echoes back to Claude Code.
   */
  private async handleApproval(req: IncomingMessage, res: ServerResponse) {
    const agentId = header(req, "x-opentrade-agent");
    const body = await readJson(req);
    const toolName = String(body?.tool_name ?? "unknown");
    const rawInput = body?.tool_input ?? {};

    if (!agentId || !this.registry.get(agentId)) {
      // Unknown agent → fail closed.
      return json(res, 200, deny("OpenTrade could not identify this agent; order blocked."));
    }

    // Abandon the pending approval if the agent's session drops mid-poll.
    const ac = new AbortController();
    req.on("close", () => ac.abort());

    const decision = await this.deps.approvals.request(
      { agentId, toolName, rawInput },
      { signal: ac.signal },
    );
    if (!res.writableEnded) json(res, 200, decision);
  }

  /**
   * PostToolUse outcome feed (fire-and-forget). The order tool already RAN — this
   * reports what the broker actually did with it (accepted / rejected), which is
   * distinct from the approval decision. We never block here.
   */
  private async handleOrderResult(req: IncomingMessage, res: ServerResponse) {
    const agentId = header(req, "x-opentrade-agent");
    const body = await readJson(req);
    const toolName = String(body?.tool_name ?? "unknown");
    const rawInput = body?.tool_input ?? {};
    // Claude Code has used both keys across versions; accept either.
    const result = body?.tool_response ?? body?.tool_output ?? body?.result ?? null;
    if (agentId && this.registry.get(agentId)) {
      this.deps.approvals.recordOutcome({ agentId, toolName, rawInput, result });
    }
    json(res, 200, { ok: true });
  }

  /**
   * Status feed (drives the needs-input dot via the StatusArbiter — independent of the
   * wake layer, which no longer tracks turns). Notification → the agent is waiting on
   * the user (needs-input); Stop → the turn ended (clears needs-input, captures the
   * session_id so a later headless `--resume` targets the right conversation).
   */
  private async handleStatus(req: IncomingMessage, res: ServerResponse) {
    const agentId = header(req, "x-opentrade-agent");
    const body = await readJson(req);
    const event = String(body?.hook_event_name ?? "");
    const agent = agentId ? this.registry.get(agentId) : undefined;
    if (agentId && agent) {
      // Both events are the AGENT speaking (it asked for input / finished its turn),
      // which is exactly what "last active" should track — a user message produces
      // neither, so typing at an agent never moves its timestamp (§12.6). Codex
      // fires Stop only (it has no Notification event); claude fires both.
      if (event === "Notification" || event === "Stop") {
        this.registry.markAgentTurn(agentId);
      }
      if (event === "Notification") {
        this.deps.arbiter.setNeedsInput(agentId, true);
      } else if (event === "Stop") {
        this.deps.arbiter.setNeedsInput(agentId, false);
        // Session capture is claude-only: for codex, `lastSessionId` is the
        // app-server THREAD id (minted by thread/start and adopted from the TUI,
        // §13) — codex's hook `session_id` is not verified to match it, and an
        // overwrite here would break `thread/resume` for every later wake.
        const sessionId = body?.session_id;
        if (agent.harness === "claude" && typeof sessionId === "string" && sessionId) {
          this.registry.setLastSessionId(agentId, sessionId);
        }
      }
    }
    json(res, 200, { ok: true });
  }

  /**
   * Interactive-wake long-poll (channel transport). The agent's `opentrade` channel
   * server holds this open; the wake coordinator resolves it with `{ prompt }` when a
   * wake for this agent is at the queue head (the server then injects it as a
   * `<channel>` event), or `{}` after ~60s (the poller re-polls). The coordinator hands
   * over a queued head straight away if one is already waiting.
   */
  private async handleWakeStream(req: IncomingMessage, res: ServerResponse) {
    const agentId = header(req, "x-opentrade-agent");
    if (!agentId || !this.registry.get(agentId)) return json(res, 404, { error: "unknown agent" });
    if (!this.wake) return json(res, 503, { error: "wake transport not ready" });
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const prompt = await this.wake.awaitPoll(agentId, ac.signal, WAKE_STREAM_HOLD_MS);
    if (res.writableEnded) return;
    json(res, 200, prompt == null ? {} : { prompt });
  }

  /**
   * Durable cron/monitor CRUD, called by the agent's `opentrade` MCP server (which
   * mirrors Claude Code's native CronCreate/Monitor surface). The agent id rides
   * the `x-opentrade-agent` header; an unknown agent is rejected.
   *   GET    /schedules           → { cron, monitors } for this agent
   *   POST   /schedules/cron      { cron, prompt, recurring } → Schedule
   *   DELETE /schedules/cron/:id  → { ok }
   *   POST   /schedules/monitor   { command, description? }   → Monitor
   *   DELETE /schedules/monitor/:id → { ok }
   */
  private async handleSchedules(req: IncomingMessage, res: ServerResponse, url: URL) {
    const scheduler = this.scheduler;
    if (!scheduler) return json(res, 503, { error: "scheduler not ready" });
    const agentId = header(req, "x-opentrade-agent");
    if (!agentId || !this.registry.get(agentId)) {
      return json(res, 404, { error: "unknown agent" });
    }

    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/schedules") {
        return json(res, 200, {
          cron: scheduler.listCron(agentId),
          monitors: scheduler.listMonitors(agentId),
        });
      }
      if (req.method === "POST" && path === "/schedules/cron") {
        const input = CronCreateInput.parse(await readJson(req));
        return json(res, 200, scheduler.createCron(agentId, input));
      }
      if (req.method === "POST" && path === "/schedules/monitor") {
        const input = MonitorCreateInput.parse(await readJson(req));
        return json(res, 200, scheduler.createMonitor(agentId, input));
      }
      const cronDel = path.match(/^\/schedules\/cron\/(.+)$/);
      if (req.method === "DELETE" && cronDel) {
        return json(res, 200, { ok: scheduler.deleteCron(agentId, cronDel[1]) });
      }
      const monDel = path.match(/^\/schedules\/monitor\/(.+)$/);
      if (req.method === "DELETE" && monDel) {
        return json(res, 200, { ok: scheduler.stopMonitor(agentId, monDel[1]) });
      }
    } catch (err) {
      return json(res, 400, { error: String(err instanceof Error ? err.message : err) });
    }
    return json(res, 404, { error: "not found" });
  }

  private get registry(): AgentRegistry {
    return this.deps.registry;
  }
}

function deny(reason: string): PreToolUseDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}
