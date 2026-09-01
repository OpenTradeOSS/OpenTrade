import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WakeFailureCategory } from "@shared/analytics";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import { analytics } from "../../analytics";
import { harnessFor } from "../../harness";
import type { LocalApiServer } from "../../local-api";
import { buildAgentEnv } from "../../terminal/env";
import { classifyWakeFailure } from "./failure-category";
import { formatWakePrompt } from "./prompt";
import { clearSpawnMarker, writeSpawnMarker } from "./spawn-marker";
import type { HeadlessExitReason, HeadlessWakeStrategy } from "./types";

/** A `--resume` of an unresumable session errors out almost immediately; a
 *  non-zero exit within this window is reported as a resume failure (→ the
 *  coordinator's resume-fail streak). */
const RESUME_FAIL_MS = 10_000;
/** How many trailing chars of a failed child's stderr to keep for the host log. Enough
 *  to carry claude's error line (e.g. "Credit balance is too low", an auth/network
 *  failure) without unbounded buffering. */
const STDERR_TAIL_CHARS = 2000;

/**
 * The headless transport (the autonomy backbone). Spawns a one-shot
 * `claude --resume <uuid> -p "<prompt>"` backend child: it resumes the agent's
 * on-disk conversation, does the task, and exits. No PTY, no output capture — the
 * run's detail lives in the resumable transcript; only the wake row in the Run
 * History feed is recorded.
 *
 * Runs with `--dangerously-skip-permissions` so the agent's non-order tools
 * (journaling, watch scripts, reads) execute without an interactive prompt — the
 * order-placing tools stay gated by the PreToolUse approval hook, which fires and can
 * `deny` even under this flag (validated in Phase 0).
 *
 * The strategy doesn't own state or timers: it spawns, classifies the exit, and
 * reports `ok | resumeFail | spawnFail` to the coordinator (which owns the queue, the
 * resume-fail streak, and the max-runtime kill timer).
 */
export class HeadlessRunStrategy implements HeadlessWakeStrategy {
  /** Active headless children by agent id, so the "Stop task" button + the
   *  coordinator's max-runtime kill can SIGTERM one. */
  private children = new Map<string, ChildProcess>();

  constructor(
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
    /** Whether a background run should use the Claude subscription (strip
     *  `ANTHROPIC_API_KEY` from its env) rather than bill the API. Read live from
     *  settings so a toggle applies to the next run without a restart. Defaults to
     *  subscription (the safe, no-surprise-bill default). */
    private useSubscriptionAuth: () => boolean = () => true,
  ) {}

  /** EC1 "Stop task" / max-runtime kill: SIGTERM the running headless child; its exit
   *  reports the outcome. Returns whether a child was actually signalled. */
  stop(agentId: string): boolean {
    const child = this.children.get(agentId);
    if (!child) return false;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    return true;
  }

  /**
   * Clean host shutdown: SIGTERM every live headless child and clear its marker, so the
   * next boot doesn't mistake an in-flight run for a crash orphan (which would flip the
   * agent to `broken`). Markers are cleared eagerly here because the host exits right
   * after — the children's own exit handlers may not run in time.
   */
  stopAll(): void {
    for (const [agentId, child] of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      clearSpawnMarker(agentId);
    }
    this.children.clear();
  }

  run(agentId: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    const agent = this.registry.get(agentId);
    // Archived/missing agent — nothing to run; report a clean completion so the
    // coordinator releases the head and returns to OFFLINE.
    if (!agent || agent.archivedAt !== null) {
      onExit("ok");
      return;
    }

    const harness = harnessFor(agent.harness);
    // Self-heal the harness's generated gate config before an unattended run (parity with
    // the interactive spawn): a claude agent created by an ungated build gets its
    // `.claude/settings.json` regenerated here, so headless orders are gated too (the
    // PreToolUse hook fires even under --dangerously-skip-permissions).
    harness.writeConfig?.(this.registry.agentDir(agent), agentId);
    // I3: OpenTrade owns the session id. Resume the known one, or mint+store one for a
    // never-started agent (begins the conversation headlessly).
    let resuming = false;
    let sessionId: string;
    if (agent.lastSessionId) {
      sessionId = agent.lastSessionId;
      resuming = true;
    } else {
      sessionId = randomUUID();
      this.registry.setLastSessionId(agentId, sessionId);
    }

    // A headless wake lands as a plain user turn — indistinguishable from a real
    // user message. Prefix it (with the fire timestamp) so the agent knows the system woke
    // it and when (the agent instructions explain the marker). The claude interactive path
    // needs no prefix: it self-identifies as `<channel source="opentrade">`.
    const startedAt = Date.now();
    const wakePrompt = formatWakePrompt(prompt, startedAt);
    const stripEnvKeys = this.useSubscriptionAuth() ? harness.subscriptionAuthStrip : [];
    // This strategy is the CLI-child transport; the routing strategy only sends it
    // harnesses whose headless transport IS a CLI child (i.e. defines headlessArgs).
    if (!harness.headlessArgs) {
      throw new Error(`harness ${harness.id} has no CLI headless transport`);
    }
    const args = harness.headlessArgs(resuming ? "resume" : "start", sessionId, wakePrompt);
    const env = buildAgentEnv(
      agentId,
      {
        OPENTRADE_PORT: String(this.localApi.port),
        OPENTRADE_TOKEN: this.localApi.token,
      },
      { stripEnvKeys },
    );

    // stdout is ignored (the transcript on disk is the run's record), but stderr is
    // piped and tail-buffered: it's the ONLY place the CLI reports why a run failed
    // (billing, auth, network, a genuinely-unresumable session), and without it a
    // failure is an opaque `code=1` (the "Credit balance is too low" incident).
    const child = spawn(harness.binary, args, {
      cwd: this.registry.agentDir(agent),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    this.children.set(agentId, child);
    // Durable single-writer marker (crash recovery, E1): exists while this child is
    // live. A surviving marker on the next boot ⇒ the host crashed mid-wake.
    if (child.pid) writeSpawnMarker({ agentId, pid: child.pid, sessionId, startedAt });

    // Report the outcome exactly once (error and exit can't both meaningfully fire).
    let settled = false;
    const settle = (reason: HeadlessExitReason, failureCategory?: WakeFailureCategory) => {
      if (settled) return;
      settled = true;
      this.children.delete(agentId);
      clearSpawnMarker(agentId);
      analytics.track("headless_run_finished", {
        result: reason === "ok" ? "ok" : reason === "resumeFail" ? "resume_fail" : "spawn_fail",
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(failureCategory ? { failure_category: failureCategory } : {}),
      });
      onExit(reason);
    };

    child.on("error", (err) => {
      hostLog.error("headless spawn failed", agentId, String(err));
      analytics.trackError("wake", err, "caught");
      settle("spawnFail");
    });
    child.on("exit", (code) => {
      // Log the stderr tail on any non-zero exit so failures are diagnosable (a fast
      // resume-fail from a real billing/auth error otherwise reads as a bare `code=1`).
      if (code !== 0) {
        const tail = stderrTail.trim();
        hostLog.warn(
          "headless run exited non-zero",
          agentId,
          `code=${code}`,
          tail ? `stderr: ${tail}` : "(no stderr)",
        );
      }
      if (resuming && code !== 0 && Date.now() - startedAt < RESUME_FAIL_MS) {
        // EC13: a `--resume` that dies this fast is treated as an unresumable session —
        // reported as a resume-fail, so the coordinator drops the wake and, after 3 in a
        // row, flips the agent to `broken` (which pauses its scheduling). This is also the
        // heuristic that fires on a valid transient error like an exhausted credit balance:
        // that legitimately stops the agent until the user intervenes (top up + Restart).
        settle("resumeFail", classifyWakeFailure(stderrTail));
      } else {
        settle("ok");
      }
    });
  }
}
