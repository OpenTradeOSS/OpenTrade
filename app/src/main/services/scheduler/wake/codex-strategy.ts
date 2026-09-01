import { basename } from "node:path";
import type { WakeFailureCategory } from "@shared/analytics";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import { analytics } from "../../analytics";
import { harnessFor } from "../../harness";
import {
  type CodexAppServerManager,
  CodexServerUnavailableError,
  codexHomeFor,
} from "../../harness/codex-app-server";
import { classifyWakeFailure } from "./failure-category";
import { formatWakePrompt } from "./prompt";
import { clearSpawnMarker, writeSpawnMarker } from "./spawn-marker";
import type { HeadlessExitReason, HeadlessWakeStrategy } from "./types";

/**
 * The codex headless transport: instead of spawning a one-shot CLI child, a wake
 * runs as ONE TURN on the agent's supervised app-server (`thread/resume` +
 * `turn/start`, await `turn/completed`) — the same engine the TUI attaches to, so
 * single-writer holds by construction. Exit-reason mapping mirrors claude's:
 * a failed turn / unresumable thread → `resumeFail` (3 strikes → broken), a server
 * that can't come up → `spawnFail` (one-strike broken), everything else `ok`.
 * "Stop task" / the coordinator's kill timer abort via `turn/interrupt`.
 */
export class CodexHeadlessStrategy implements HeadlessWakeStrategy {
  private active = new Map<string, AbortController>();

  constructor(
    private registry: AgentRegistry,
    private manager: CodexAppServerManager,
  ) {}

  run(agentId: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) {
      onExit("ok");
      return;
    }
    const agentDir = this.registry.agentDir(agent);
    // Self-heal the generated config before an unattended run, same as spawn.
    harnessFor(agent.harness).writeConfig?.(agentDir, agentId);
    const codexHome = codexHomeFor(basename(agentDir));
    const ac = new AbortController();
    this.active.set(agentId, ac);
    const startedAt = Date.now();

    let settled = false;
    const settle = (reason: HeadlessExitReason, failureCategory?: WakeFailureCategory) => {
      if (settled) return;
      settled = true;
      this.active.delete(agentId);
      clearSpawnMarker(agentId);
      analytics.track("headless_run_finished", {
        result: reason === "ok" ? "ok" : reason === "resumeFail" ? "resume_fail" : "spawn_fail",
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(failureCategory ? { failure_category: failureCategory } : {}),
      });
      onExit(reason);
    };

    void (async () => {
      try {
        // Bring the server up FIRST so the crash-recovery marker records a real pid.
        // On the resume path (lastSessionId already set) nothing has started the server
        // yet, so reading serverPid before this would yield 0 — and a marker with pid 0
        // makes the boot reconcile SIGTERM the host's own process group (B1). ensureServer
        // is idempotent; runTurn/createThread below reuse the same child.
        await this.manager.ensureServer(agentId, codexHome);
        let threadId = agent.lastSessionId;
        if (!threadId) {
          threadId = await this.manager.createThread(agentId, codexHome, agentDir);
          this.registry.setLastSessionId(agentId, threadId);
        }
        // Crash-recovery marker (E1): records the SERVER pid — after a host crash the
        // orphaned server must be terminated before a fresh host spawns a second one
        // on the same CODEX_HOME. Cleared on settle / clean shutdown. Skip the marker
        // entirely if we somehow have no live pid rather than persist a poisonous 0.
        const serverPid = this.manager.serverPid(agentId);
        if (serverPid && serverPid > 0) {
          writeSpawnMarker({ agentId, pid: serverPid, sessionId: threadId, startedAt });
        }
        // Did turn/start ACK? If a kill/Stop interrupts BEFORE the wake was ever
        // delivered (e.g. the kill timer fires while we're parked waiting for a prior
        // turn to end), the prompt never entered the session — that must NOT settle
        // "ok" (which shifts the head and silently loses the wake, E2).
        let acked = false;
        const result = await this.manager.runTurn(
          agentId,
          codexHome,
          threadId,
          formatWakePrompt(prompt, startedAt),
          { signal: ac.signal, events: { onAccepted: () => (acked = true) } },
        );
        if (result.outcome === "failed") {
          hostLog.warn("codex wake turn failed", agentId, result.error);
          settle("resumeFail", classifyWakeFailure(String(result.error)));
        } else if (result.outcome === "interrupted" && !acked) {
          // Killed before delivery. A deliberate user Stop is handled by the
          // coordinator's `stopping` short-circuit regardless of reason; for the
          // kill-timer case, resumeFail keeps the wake from being marked delivered.
          hostLog.warn("codex wake interrupted before delivery", agentId);
          settle("resumeFail");
        } else {
          settle("ok"); // completed, or interrupted AFTER delivery (parity with SIGTERM)
        }
      } catch (err) {
        hostLog.warn("codex wake run errored", agentId, String(err));
        analytics.trackError("wake", err, "caught");
        if (err instanceof CodexServerUnavailableError) {
          settle("spawnFail");
        } else {
          settle("resumeFail", classifyWakeFailure(String(err)));
        }
      }
    })();
  }

  stop(agentId: string): boolean {
    const ac = this.active.get(agentId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  stopAll(): void {
    for (const [agentId, ac] of this.active) {
      ac.abort();
      clearSpawnMarker(agentId); // host is exiting — don't rely on async settles
    }
    this.active.clear();
  }
}

/**
 * Routes each agent's wake runs to its harness's transport — claude's one-shot
 * CLI child or codex's app-server turn — so the coordinator keeps exactly one
 * `HeadlessWakeStrategy` and stays harness-blind.
 */
export class HarnessRoutingHeadlessStrategy implements HeadlessWakeStrategy {
  constructor(
    private registry: AgentRegistry,
    private claude: HeadlessWakeStrategy,
    private codex: HeadlessWakeStrategy,
  ) {}

  private pick(agentId: string): HeadlessWakeStrategy {
    return this.registry.get(agentId)?.harness === "codex" ? this.codex : this.claude;
  }

  run(agentId: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    this.pick(agentId).run(agentId, prompt, onExit);
  }

  stop(agentId: string): boolean {
    // At most one transport has an active run; both stops are safe no-ops otherwise.
    return this.claude.stop(agentId) || this.codex.stop(agentId);
  }

  stopAll(): void {
    this.claude.stopAll();
    this.codex.stopAll();
  }
}
