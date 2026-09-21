import type { WakeFailureCategory } from "@shared/analytics";
import type { WakeFailureReason, WakeOutcome } from "@shared/schedule";

/**
 * The wake-delivery seam. `Scheduler` enqueues via `enqueue`; the `/wake-stream`
 * long-poll consumes via `awaitPoll`; `TerminalService` reports PTY up/down. The
 * coordinator owns one per-agent wake queue, drained through one of two transports —
 * the `claude/channel` (interactive) or a `claude --resume -p` child (headless) —
 * behind this interface, so the delivery mechanism stays decoupled from its callers.
 */
export interface WakeTransport {
  /** Enqueue a wake for an agent. Drained via the channel (a live PTY exists) or a
   *  headless `-p` child (none). Never blocks, never throws. Nothing is recorded here:
   *  the history row is written by the coordinator the moment the wake actually
   *  starts (`SchedulerControl.wakeStarted`), so a wake that never runs leaves no row. */
  enqueue(agentId: string, wake: PendingWake): void;
  /** The agent's turn ended (the Stop status hook, §6.7). Settles every warm wake
   *  delivered into the live session as `succeeded`. No-op when none is outstanding. */
  onTurnEnded(agentId: string): void;
  /** The agent's turn ended in an API error (Claude Code's `StopFailure` hook, which
   *  fires INSTEAD of Stop). Settles every outstanding warm wake as `failed`; for a
   *  headless run still in flight, the failure is held so the child's exit settles
   *  `failed` rather than `succeeded`. No-op when nothing is outstanding. */
  onTurnFailed(agentId: string, failureCategory: WakeFailureCategory): void;
  /** Would a wake for this agent be dropped rather than delivered (session BROKEN, or
   *  out of background turns)? The Scheduler checks this to skip firing a paused agent —
   *  no wake notification, history row, or enqueue — instead of firing then dropping. */
  wouldDropWake(agentId: string): boolean;
  /** The `/wake-stream` consumer (channel transport): hand the queued head to the
   *  live interactive session, or park until one is offered / the hold elapses / the
   *  request aborts. Returns the wake prompt or null. */
  awaitPoll(agentId: string, signal: AbortSignal, holdMs: number): Promise<string | null>;
  /** A live interactive PTY came up (GUI opened/selected the agent). `push` is the
   *  harness's interactive wake delivery when it is NOT the claude channel: codex
   *  wakes are pushed as `turn/start` on the agent's app-server (the attached TUI
   *  renders them via event fanout). With a push set, the parked `/wake-stream`
   *  poll is never served (it belongs to the channel transport only). */
  onInteractiveUp(agentId: string, push?: InteractivePush): void;
  /** The interactive PTY went down (exit / GUI-close blanket kill); the head + any
   *  queued wakes re-route to the headless transport. */
  onInteractiveDown(agentId: string): void;
  /** EC1 "Stop task" / archive: clear the agent's queued wakes and end any active
   *  headless run. Returns whether a headless run was actually stopped. */
  stop(agentId: string): boolean;
  /** Clean host shutdown: end every active headless run and clear its crash marker, so
   *  the next boot doesn't mistake an in-flight run for a crash orphan. */
  stopAll(): void;
}

/**
 * The slice of the `Scheduler` the wake coordinator drives when an agent's
 * resumability changes. A `broken` (unresumable) agent can't run wakes, so its crons
 * and monitors are **paused** (disarmed, but left `enabled` in the DB) rather than
 * left firing into a dead session — otherwise every tick spams a wake notification and
 * a "dropping wake" log. A manual Restart clears `broken` and re-arms them. Late-bound
 * (`WakeCoordinator.setScheduler`) because the scheduler is built after the coordinator.
 */
export interface SchedulerControl {
  /** Disarm this agent's cron timers + stop its monitor children (DB `enabled` untouched). */
  disarmAgent(agentId: string): void;
  /** Re-arm this agent's still-enabled crons + monitors (Restart / recovery). */
  rearmAgent(agentId: string): void;
  /** The wake actually started: a headless child spawned, or the live session accepted
   *  it. Writes the History row (`outcome = running`) + the wake notification. */
  wakeStarted(wake: PendingWake, background: boolean): void;
  /** The started wake settled. Called exactly once per `wakeStarted`. `run` carries
   *  facts about a headless run that aren't part of its outcome (absent for warm). */
  wakeFinished(wake: PendingWake, result: WakeResult, run?: HeadlessRunInfo): void;
}

/** What a headless run had, independent of how it ended. */
export interface HeadlessRunInfo {
  /** The run held an idle-sleep assertion for its lifetime (`sleep-guard.ts`). */
  sleepGuardHeld: boolean;
}

/** A wake produced by the scheduler, carried through the coordinator's queue. `id` is
 *  minted at fire time and becomes the History row's id once the wake starts. */
export interface PendingWake {
  id: string;
  agentId: string;
  prompt: string;
  sourceKind: "cron" | "monitor";
  /** The originating schedule/monitor id (joined with `sourceKind`). */
  sourceId: string;
}

/** How a started wake settled (see `WakeOutcome` in `@shared/schedule`). */
export interface WakeResult {
  outcome: Exclude<WakeOutcome, "running">;
  failureReason?: WakeFailureReason;
  failureCategory?: WakeFailureCategory;
}

/** A headless strategy's exit report: how the child ended and, for a failure, the
 *  category classified from its error text (when one was recognized). */
export type HeadlessExit = (
  reason: HeadlessExitReason,
  failureCategory?: WakeFailureCategory,
) => void;

/**
 * Interactive wake delivery for a non-channel harness (codex): deliver the RAW wake
 * prompt into the live session (the implementation prefixes/format as needed).
 * Resolves `true` once the wake is confirmed accepted (advance-on-ack — the head may
 * then be shifted), `false`/reject when delivery failed and should be retried.
 */
export type InteractivePush = (prompt: string) => Promise<boolean>;

/** How a headless `-p` run terminated, reported by the strategy to the coordinator:
 *  - `ok`         — the child exited (clean, or killed by the max-runtime backstop)
 *  - `resumeFail` — a `--resume` exited non-zero almost immediately (unresumable session)
 *  - `spawnFail`  — the child failed to spawn at all (a config fault) */
export type HeadlessExitReason = "ok" | "resumeFail" | "spawnFail";

/** Autonomy backbone: spawn a headless `claude --resume <uuid> -p "<prompt>"`. */
export interface HeadlessWakeStrategy {
  /** Spawn the headless child for the head wake. Reports its terminal outcome via
   *  `onExit` (called exactly once). Never blocks — the run is fire-and-forget; the
   *  coordinator owns the max-runtime kill timer. */
  run(agentId: string, prompt: string, onExit: HeadlessExit): void;
  /** SIGTERM the active headless run for an agent, if any. Returns whether one died. */
  stop(agentId: string): boolean;
  /** SIGTERM every live headless child + clear its marker (clean host shutdown). */
  stopAll(): void;
}
