import { randomUUID } from "node:crypto";
import type { Agent, ExecutionState } from "@shared/agent";
import { TerminalWsServer } from "../../pty-daemon/ws-server";
import { buildTerminalWsUrl } from "../../pty-daemon/ws-url";
import type { AgentRegistry } from "../agents/registry";
import { analytics } from "../analytics";
import { bus } from "../event-bus";
import { harnessFor } from "../harness";
import type { LocalApiServer } from "../local-api";
import type { InteractivePush, WakeTransport } from "../scheduler/wake/types";
import type { StatusArbiter } from "../status/arbiter";
import { buildAgentEnv } from "./env";
import { TerminalManager } from "./manager";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const IDLE_AFTER_MS = 1500;

/**
 * A `claude --resume` launch that exits within this window almost always means
 * there was no resumable conversation (the user killed/exited the prior session),
 * so Claude Code printed "no conversation to continue" and bailed. We detect that
 * and transparently respawn a fresh `claude` instead of stranding a dead pane.
 */
const RESPAWN_GUARD_MS = 8000;

/** What we last launched for a session, used to decide on auto-respawn. */
interface LaunchInfo {
  continued: boolean;
  at: number;
}

/**
 * Owns each agent's persistent Claude Code PTY (in-process in the backend host)
 * and drives its working/idle status. The renderer streams terminal output over a
 * direct WebSocket to the host's terminal data plane (see `wsEndpointFor`); the
 * status heuristic rides the TerminalManager's `output`/`exit` events.
 *
 * Interactive PTYs exist only while the GUI is open. The host detects the GUI going
 * away (`gui:gone`, reliable across window-close / Cmd-Q / crash) and **blanket-kills**
 * every interactive PTY immediately — no graceful, turn-aware deferral. Each kill's
 * exit reports `onInteractiveDown` to the wake coordinator, which re-routes any queued
 * wakes to the headless transport (`HeadlessRunStrategy`), so autonomy continues
 * outside the GUI with nothing stranded.
 */
export class TerminalService {
  private manager = new TerminalManager();
  private wsServer: TerminalWsServer;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  /** Most recent launch per session, to detect a dead `--resume` resume. */
  private launches = new Map<string, LaunchInfo>();
  /** In-flight `openOrAttach` spawn per agent. The spawn is now async (codex brings
   *  its app-server up first — seconds), so two rapid opens (pane re-mount) both pass
   *  the `isLive` check and run the spawn body twice: double kickoff, double
   *  onInteractiveUp, a second minted session id (B7). Concurrent opens await one spawn. */
  private opening = new Map<string, Promise<void>>();
  /** True between `gui:gone` and the next `openOrAttach` — an async respawn that lands
   *  in this window would orphan a PTY with no GUI, so it self-kills (E1). */
  private guiGone = false;

  constructor(
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
    private arbiter: StatusArbiter,
    private wake: WakeTransport,
    /** Harness-specific interactive wake delivery (codex app-server push); undefined
     *  for channel harnesses (claude). Built in host wiring. */
    private interactivePushFor?: (agent: Agent) => InteractivePush | undefined,
  ) {
    // Terminal bytes ride a WS sharing the host's bearer token.
    this.wsServer = new TerminalWsServer(this.manager.store, this.localApi.token);
    this.manager.on("output", ({ id }: { id: string }) => this.markWorking(id));
    this.manager.on("exit", ({ id }: { id: string }) => {
      this.clearIdleTimer(id);
      this.arbiter.setPty(id, "idle");
      // A dead `--resume` is transparently respawned (the writer stays up); otherwise the
      // interactive writer is gone — tell the coordinator so it re-routes queued wakes
      // (now eligible to run headless) and republishes `executionState`.
      if (!this.maybeRespawnFresh(id)) this.wake.onInteractiveDown(id);
    });
    // The GUI went away (window-close / Cmd-Q / crash, detected host-side) → blanket-kill
    // every interactive PTY so none is maintained outside the GUI (EC5/BUG-1). Quitting
    // mid-turn interrupts that turn (accepted: the conversation resumes and crons re-fire).
    bus.onEvent("gui:gone", () => this.teardownOnGuiGone());
  }

  /** Bring up the terminal WebSocket data plane (called once by the host). */
  async start(): Promise<void> {
    await this.wsServer.listen();
  }

  /**
   * Ensure the agent's persistent session exists (spawn on first run / resume).
   * The renderer attaches separately over its WebSocket (with replay); status is
   * tracked from the manager's output/exit events, so there's no extra attach here.
   */
  async openOrAttach(
    agent: Agent,
    cols = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
    intent: "auto" | "resume" | "attach" = "auto",
  ): Promise<{ alive: boolean; state: ExecutionState }> {
    const state = this.registry.executionStateOf(agent.id);
    // I1 single-writer: never spawn an interactive PTY alongside a headless run
    // (EC1) or for an unresumable session (EC13) — the renderer shows an overlay
    // for these, driven by `executionState` from the agents subscription.
    if (state === "headless" || state === "broken") return { alive: false, state };
    // The GUI is interacting again — clear the teardown guard.
    this.guiGone = false;
    if (!this.manager.isLive(agent.id)) {
      // `attach` never spawns: it's the post-respawn reconnect, whose contract is
      // "the PTY is already alive". If it died in the meantime, spawning here would
      // relaunch the stored id as a resume and re-arm the respawn guard — the exact
      // reattach leg of the cascade. Report dead; the pane offers Resume.
      if (intent === "attach") return { alive: false, state };
      // Coalesce concurrent opens onto ONE spawn (B7): a second call arriving during
      // the multi-second async spawn awaits the same promise instead of re-running it.
      let inflight = this.opening.get(agent.id);
      if (!inflight) {
        inflight = this.spawn(agent, intent, cols, rows).finally(() =>
          this.opening.delete(agent.id),
        );
        this.opening.set(agent.id, inflight);
      }
      await inflight;
    }
    return { alive: true, state: "interactive" };
  }

  /**
   * Spawn the agent's interactive PTY (its harness CLI). OpenTrade owns the
   * session id (I3): it mints a UUID at first start and resumes it thereafter;
   * the harness turns that decision into argv. `intent`:
   *  - `auto`   first run → start a new session (+ kickoff); otherwise resume
   *  - `resume` resume the stored session (the Resume button); mints if none yet
   *  - `fresh`  brand-new session, no kickoff (auto-respawn / restart)
   *
   * Claude PTYs load the `opentrade` channel (wake injection into the live
   * session); codex wakes arrive via the agent's app-server instead — both are
   * encoded in the harness's argv/env builders, not here.
   */
  private async spawn(
    agent: Agent,
    intent: "auto" | "resume" | "fresh",
    cols: number,
    rows: number,
  ): Promise<void> {
    const dir = this.registry.agentDir(agent);
    const harness = harnessFor(agent.harness);
    // Self-heal the harness's generated config (codex: config.toml, hooks, gate
    // anchors) before every launch — agent tampering doesn't survive a spawn —
    // then bring the harness engine up (codex app-server) so the TUI's
    // auto-attach finds it at boot.
    harness.writeConfig?.(dir, agent.id);
    await harness.prepareInteractive?.(agent, dir);

    // Resolve intent → (mode, sessionId, kickoff). OpenTrade persists the id and
    // owns the first-run marker; who MINTS it is per-harness — locally (claude,
    // kickoff rides the argv) or by the harness's engine (codex: a bare `start`
    // launch lets the TUI create the thread, and `adoptInteractiveSession`
    // discovers/persists its id afterwards + delivers the kickoff as a turn).
    const adopts = !!harness.adoptInteractiveSession;
    /** argv for a session-starting launch. An adoption harness (codex) launches BARE
     *  and its engine mints the id (adopted post-spawn), so we must NOT mint locally —
     *  the guard is explicit here rather than hidden in an un-invoked lambda. A
     *  local-mint harness (claude) reuses `reuseId` if given, else mints now, and
     *  passes the id + kickoff as argv positionals. */
    const startArgs = (reuseId: string | null, kickoff: string | null): string[] => {
      if (adopts) return harness.interactiveArgs("start", "");
      return harness.interactiveArgs("start", reuseId ?? this.mintSessionId(agent.id), kickoff);
    };
    // An adoption harness resumes any existing conversation even before the
    // interactive first-run marker (a headless-first thread already has history
    // the TUI can resume); replaying a kickoff into it would be wrong anyway.
    const resumable =
      agent.lastSessionId !== null && (this.registry.hasStarted(agent.id) || adopts);

    let args: string[];
    let continued: boolean;
    let adoptKickoff: string | null = null;
    let starting = false;
    if (intent === "fresh") {
      // Brand-new conversation: always a fresh id (never resurrect the dead one).
      args = startArgs(null, null);
      continued = false;
      starting = true;
    } else if (intent === "resume") {
      continued = agent.lastSessionId !== null;
      if (continued) {
        args = harness.interactiveArgs("resume", agent.lastSessionId as string);
      } else {
        args = startArgs(null, null);
        starting = true;
      }
    } else if (resumable) {
      args = harness.interactiveArgs("resume", agent.lastSessionId as string);
      continued = true;
    } else {
      adoptKickoff = this.registry.readKickoff(agent);
      args = startArgs(agent.lastSessionId, adoptKickoff);
      continued = false;
      starting = true;
      this.registry.markStarted(agent.id);
    }

    const env = buildAgentEnv(agent.id, {
      OPENTRADE_PORT: String(this.localApi.port),
      OPENTRADE_TOKEN: this.localApi.token,
      ...harness.interactiveEnv({ agentDir: dir }),
    });
    this.manager.open(agent.id, { command: harness.binary, args, cwd: dir, env, cols, rows });
    this.launches.set(agent.id, { continued, at: Date.now() });
    // A live PTY is the interactive transport — tell the coordinator (it publishes
    // `executionState = interactive`). Synchronous, so it's set before the agent's MCP
    // could poll `/wake-stream`. A push-transport harness (codex) also hands over its
    // delivery closure here; channel harnesses (claude) pass none.
    this.wake.onInteractiveUp(agent.id, this.interactivePushFor?.(agent));
    // Engine-minted sessions: discover + persist the thread the TUI just created
    // (and deliver the kickoff into it). Fire-and-forget by design.
    if (starting && harness.adoptInteractiveSession) {
      harness.adoptInteractiveSession(agent, dir, adoptKickoff, (sid) =>
        this.registry.setLastSessionId(agent.id, sid),
      );
    } else if (!starting && agent.lastSessionId) {
      // A resume launch: assert the TUI actually attached to our engine (not a split
      // embedded session). Fire-and-forget; surfaces a warning + notify if not (E4).
      harness.verifyResumedSession?.(agent, dir, agent.lastSessionId);
    }
    analytics.track("terminal_session_started", { intent });
  }

  /** Mint and persist a fresh session id OpenTrade owns for this agent (I3). */
  private mintSessionId(agentId: string): string {
    const sid = randomUUID();
    this.registry.setLastSessionId(agentId, sid);
    return sid;
  }

  /**
   * If a resumed launch died almost immediately, there was no conversation to
   * resume — respawn a fresh session and tell the renderer to reattach. Loop
   * safety is causal: a fresh launch (`continued:false`) that dies is left
   * alone, and the renderer's post-respawn reconnect is attach-only (it cannot
   * relaunch the stored id as a resume), so a harness that exits on launch
   * can't ping-pong between our respawn and the reattach.
   * Returns whether a respawn was undertaken (the exit handler keeps the lock held
   * if so); the spawn itself is async (codex mints its session server-side) and
   * reports `onInteractiveDown` if it ultimately fails, so nothing is stranded.
   */
  private maybeRespawnFresh(agentId: string): boolean {
    const launch = this.launches.get(agentId);
    // A fresh launch that dies is left alone — respawning it would just repeat it.
    if (!launch || !launch.continued) return false;
    // It stayed up long enough to be a real session, not a dead `--resume`.
    if (Date.now() - launch.at > RESPAWN_GUARD_MS) return false;
    // A user-driven open is already spawning: let it bring the session up rather
    // than racing it with a second, uncoalesced spawn (double onInteractiveUp,
    // `launches` describing the wrong PTY).
    if (this.opening.has(agentId)) return false;

    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return false;
    // Register in `opening` so a concurrent openOrAttach (pane remount during the
    // multi-second codex spawn) awaits THIS spawn instead of starting its own (B7).
    const inflight = this.spawn(agent, "fresh", DEFAULT_COLS, DEFAULT_ROWS)
      .then(() => {
        // The GUI may have gone away DURING this async respawn (codex spawn takes
        // seconds); teardown already ran and won't see this PTY, so kill it now rather
        // than leave an interactive PTY alive with no GUI (E1).
        if (this.guiGone) {
          this.killForTeardown(agentId);
          return;
        }
        bus.emitEvent("terminal:respawned", { agentId });
        analytics.track("terminal_respawned");
      })
      .catch((err) => {
        console.error("[terminal] auto-respawn failed", err);
        this.wake.onInteractiveDown(agentId); // the writer is gone after all
      })
      .finally(() => this.opening.delete(agentId));
    this.opening.set(agentId, inflight);
    return true;
  }

  /**
   * EC13 restart: the agent's session was unresumable (broken). Start a brand-new
   * session (fresh id) and tell the renderer to reattach. The agent loses chat
   * history but re-reads STRATEGY.md on startup, so strategy continuity survives.
   */
  async restart(agentId: string): Promise<{ alive: boolean }> {
    const agent = this.registry.get(agentId);
    if (!agent) return { alive: false };
    this.manager.close(agentId, "SIGTERM");
    this.launches.delete(agentId);
    // `spawn` reports `onInteractiveUp`, which clears BROKEN → interactive on the
    // coordinator (and resets its resume-fail streak for the fresh session).
    await this.spawn(agent, "fresh", DEFAULT_COLS, DEFAULT_ROWS);
    bus.emitEvent("terminal:respawned", { agentId });
    analytics.track("agent_restarted");
    return { alive: true };
  }

  /** The WebSocket URL the renderer connects to for this agent's live terminal. */
  async wsEndpointFor(agentId: string): Promise<string> {
    // Opaque to the renderer by contract — a future cloud host returns a
    // different URL (wss://…) and the renderer transport is unchanged.
    return buildTerminalWsUrl(
      `ws://127.0.0.1:${this.wsServer.port}`,
      agentId,
      this.wsServer.token,
      true,
    );
  }

  kill(agentId: string) {
    // Drop launch tracking first so the resulting exit doesn't trigger an
    // auto-respawn (this is a deliberate kill, e.g. the agent was deleted). The exit
    // reports `onInteractiveDown`, which sets `executionState = offline`.
    this.launches.delete(agentId);
    this.arbiter.forget(agentId);
    this.manager.close(agentId, "SIGTERM");
  }

  /**
   * The GUI went away (`gui:gone`): blanket-kill every interactive PTY so none runs
   * outside the GUI. No deferral, no turn-awareness — quitting mid-turn interrupts that
   * turn, accepted because the conversation resumes on the next run and recurring crons
   * re-fire. Each kill's exit reports `onInteractiveDown` → the agent goes offline and
   * any queued wakes re-route to the headless transport.
   */
  private teardownOnGuiGone() {
    this.guiGone = true;
    for (const info of this.manager.list()) this.killForTeardown(info.id);
  }

  /** Kill a PTY as part of teardown — deliberate, so clear its launch (no auto-respawn).
   *  The exit handler then reports `onInteractiveDown` (re-routes any pending wakes). */
  private killForTeardown(id: string) {
    this.launches.delete(id);
    this.manager.close(id, "SIGTERM");
  }

  /** Tear down all PTYs + the WS server (host shutdown). */
  stop() {
    this.manager.closeAll();
    this.wsServer.close();
  }

  private markWorking(id: string) {
    this.arbiter.setPty(id, "working");
    this.clearIdleTimer(id);
    this.idleTimers.set(
      id,
      setTimeout(() => {
        this.arbiter.setPty(id, "idle");
        this.idleTimers.delete(id);
      }, IDLE_AFTER_MS),
    );
  }

  private clearIdleTimer(id: string) {
    const t = this.idleTimers.get(id);
    if (t) clearTimeout(t);
    this.idleTimers.delete(id);
  }
}
