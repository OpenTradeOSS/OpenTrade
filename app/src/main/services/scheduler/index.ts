import { firstLine } from "@shared/notify";
import type {
  CronCreateInput,
  Monitor,
  MonitorCreateInput,
  Schedule,
  Wake,
} from "@shared/schedule";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db/client";
import {
  monitors as monitorsTable,
  schedules as schedulesTable,
  wakes as wakesTable,
} from "../../db/schema";
import { hostLog } from "../../host/log";
import type { AgentRegistry } from "../agents/registry";
import { analytics } from "../analytics";
import { bus } from "../event-bus";
import type { LocalApiServer } from "../local-api";
import { buildAgentEnv } from "../terminal/env";
import { CronTimer } from "./cron-timer";
import { MonitorRunner } from "./monitor-runner";
import { systemTimeZone } from "./system-timezone";
import type { WakeTransport } from "./wake/types";

/**
 * Durable autonomy scheduler, owned by the always-on backend host. Arms cron
 * timers and supervises monitor children that survive the GUI closing (unlike
 * Claude Code's session-scoped CronCreate/Monitor). When a trigger fires it
 * records a wake in the Run History feed and hands a wake to the `WakeTransport`, which delivers
 * it either warm (a `claude/channel` inject into the live PTY) or cold (a headless
 * `claude --resume -p` run) — the Scheduler doesn't care which.
 */
export class Scheduler {
  private cron = new CronTimer();
  private runners = new Map<string, MonitorRunner>();

  constructor(
    private db: Db,
    private wake: WakeTransport,
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
  ) {}

  /** Load enabled rows and arm their timers / monitor children. */
  start(): void {
    // Backfill pre-v6 rows with the machine's current zone: until the column existed they
    // were evaluated in the process's local zone, so this pins the behaviour they had.
    const bootZone = systemTimeZone();
    this.db
      .update(schedulesTable)
      .set({ timezone: bootZone })
      .where(isNull(schedulesTable.timezone))
      .run();
    for (const row of this.db.select().from(schedulesTable).all()) {
      if (!row.enabled) continue;
      // Self-heal a genuinely-orphaned row (agent no longer exists at all) by hard-deleting
      // it. Archival no longer reaches here: `removeAgent` now RETIRES an archived agent's
      // rows (`enabled=false`), so they're skipped by the guard above before this check.
      if (this.isAgentGone(row.agentId)) {
        this.db.delete(schedulesTable).where(eq(schedulesTable.id, row.id)).run();
        continue;
      }
      // A broken (unresumable) agent can't run wakes — leave its crons enabled but
      // unarmed (no catch-up, no arm). A manual Restart clears broken → `rearmAgent`.
      if (this.registry.executionStateOf(row.agentId) === "broken") continue;
      // Catch-up: if we were down past a recurring fire, run it once, then re-arm
      // from the expression (never trust the stored next_fire_at).
      if (row.nextFireAt != null && row.nextFireAt < Date.now()) {
        const fired = this.fireTracked(row.agentId, row.prompt, "cron", row.id);
        if (fired) this.markCronFired(row.id);
        if (!row.recurring) {
          // Retire a one-shot only if it ran; a skipped one (agent paused) stays enabled
          // so a later boot catch-up fires it once un-paused. Either way it's spent-in-time,
          // so don't arm it.
          if (fired) {
            this.db
              .update(schedulesTable)
              .set({ enabled: false })
              .where(eq(schedulesTable.id, row.id))
              .run();
          }
          continue;
        }
      }
      this.armRow(row);
    }

    for (const row of this.db.select().from(monitorsTable).all()) {
      if (!row.enabled) continue;
      if (this.isAgentGone(row.agentId)) {
        this.db.delete(monitorsTable).where(eq(monitorsTable.id, row.id)).run();
        continue;
      }
      if (this.registry.executionStateOf(row.agentId) === "broken") continue; // paused (see above)
      this.startMonitor(row.id, row.agentId, row.command);
    }
    hostLog.info(
      `scheduler started: ${this.runners.size} monitor(s), crons armed (machine tz ${bootZone})`,
    );
  }

  /**
   * Pause an agent's scheduling without deleting it: disarm every cron timer and stop
   * every monitor child for the agent, leaving the DB rows `enabled` so they survive.
   * Called by the `WakeCoordinator` when the agent goes `broken` — a dead session can't
   * run wakes, so firing into it only spams notifications and drops. `rearmAgent`
   * reverses it on Restart. (Distinct from `removeAgent`, which retires the rows so they
   * stay paused permanently and drop out of every list.)
   */
  disarmAgent(agentId: string): void {
    for (const row of this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.agentId, agentId))
      .all()) {
      this.cron.disarm(row.id);
    }
    // Clear next-fire on the disarmed crons so the Scheduled view doesn't advertise a run
    // that won't happen while paused; `rearmAgent` recomputes it. (Recurring rows only —
    // a one-shot's original fire time is kept for a later catch-up.)
    this.db
      .update(schedulesTable)
      .set({ nextFireAt: null })
      .where(and(eq(schedulesTable.agentId, agentId), eq(schedulesTable.recurring, true)))
      .run();
    for (const row of this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.agentId, agentId))
      .all()) {
      this.runners.get(row.id)?.stop();
      this.runners.delete(row.id);
    }
    bus.emitEvent("scheduler:changed", { agentId });
  }

  /**
   * Resume a previously-disarmed agent: re-arm its still-`enabled` crons and restart its
   * enabled monitors. Called when the agent recovers from `broken` (a manual Restart).
   * Idempotent: `armCron` re-arms in place and monitors already running are left alone.
   */
  rearmAgent(agentId: string): void {
    if (this.isAgentGone(agentId)) return;
    for (const row of this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.agentId, agentId))
      .all()) {
      if (!row.enabled) continue;
      this.armRow(row);
    }
    for (const row of this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.agentId, agentId))
      .all()) {
      if (!row.enabled || this.runners.has(row.id)) continue;
      this.startMonitor(row.id, row.agentId, row.command);
    }
  }

  /** True if the agent no longer exists or has been archived (orphaned schedules). */
  private isAgentGone(agentId: string): boolean {
    const agent = this.registry.get(agentId);
    return !agent || agent.archivedAt !== null;
  }

  /**
   * An agent was archived: disarm every cron and stop every monitor child so nothing
   * keeps ticking, then RETIRE the rows (`enabled=false`) rather than deleting them.
   * Timers/monitors are never hard-deleted — the rows are kept so the wake history can
   * still resolve a fired timer's details after the agent is gone. Retired rows are
   * hidden everywhere (filtered from every list) and never re-armed. Called from the
   * archive path.
   */
  removeAgent(agentId: string): void {
    for (const row of this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.agentId, agentId))
      .all()) {
      this.cron.disarm(row.id);
    }
    this.db
      .update(schedulesTable)
      .set({ enabled: false })
      .where(eq(schedulesTable.agentId, agentId))
      .run();

    for (const row of this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.agentId, agentId))
      .all()) {
      this.runners.get(row.id)?.stop();
      this.runners.delete(row.id);
    }
    this.db
      .update(monitorsTable)
      .set({ enabled: false })
      .where(eq(monitorsTable.agentId, agentId))
      .run();
    bus.emitEvent("scheduler:changed", { agentId });
  }

  // ---- list-all (across every agent) for the Scheduled view ----
  // Enabled-only: a spent one-shot cron is disabled but kept as a record; the
  // Scheduled view shows only what's still active, so it's filtered out here.

  /** Every enabled cron schedule on every agent, for the global Scheduled view. */
  listAllCron(): Schedule[] {
    return this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.enabled, true))
      .all()
      .map(rowToSchedule);
  }

  /** Every enabled monitor on every agent, for the global Scheduled view. */
  listAllMonitors(): Monitor[] {
    return this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.enabled, true))
      .all()
      .map(rowToMonitor);
  }

  // ---- cron CRUD ----

  createCron(agentId: string, input: CronCreateInput): Schedule {
    if (!CronTimer.isValid(input.cron)) {
      throw new Error(`invalid cron expression: ${input.cron}`);
    }
    const id = nanoid();
    const now = Date.now();
    // Pin the machine's zone the agent authored this in; the agent never names one (§12.2).
    const timezone = systemTimeZone();
    this.db
      .insert(schedulesTable)
      .values({
        id,
        agentId,
        cronExpr: input.cron,
        timezone,
        prompt: input.prompt,
        recurring: input.recurring,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: now,
      })
      .run();
    this.armCron(id, agentId, input.cron, timezone, input.prompt, input.recurring);
    bus.emitEvent("scheduler:changed", { agentId });
    analytics.track("schedule_created", { kind: "cron", recurring: input.recurring });
    return this.getCron(id)!;
  }

  /** This agent's LIVE crons (retired ones are hidden), for the agent's `CronList`
   *  and the Monitor "Active" panel. A fired one-shot / removed cron is retired
   *  (`enabled=false`) but kept in the DB — its fire stays in the wake history. */
  listCron(agentId: string): Schedule[] {
    return this.db
      .select()
      .from(schedulesTable)
      .where(and(eq(schedulesTable.agentId, agentId), eq(schedulesTable.enabled, true)))
      .all()
      .map(rowToSchedule);
  }

  /** Retire (not delete) a cron: disarm it and mark it `enabled=false`. The row is kept
   *  so its wake history stays resolvable; it's hidden from `listCron` and never re-armed. */
  deleteCron(agentId: string, id: string): boolean {
    const row = this.db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).get();
    if (!row || row.agentId !== agentId) return false;
    this.cron.disarm(id);
    this.db.update(schedulesTable).set({ enabled: false }).where(eq(schedulesTable.id, id)).run();
    bus.emitEvent("scheduler:changed", { agentId });
    return true;
  }

  // ---- monitor CRUD ----

  createMonitor(agentId: string, input: MonitorCreateInput): Monitor {
    const id = nanoid();
    const now = Date.now();
    this.db
      .insert(monitorsTable)
      .values({
        id,
        agentId,
        command: input.command,
        description: input.description ?? null,
        enabled: true,
        lastFiredAt: null,
        createdAt: now,
      })
      .run();
    this.startMonitor(id, agentId, input.command);
    bus.emitEvent("scheduler:changed", { agentId });
    analytics.track("schedule_created", { kind: "monitor" });
    return this.getMonitor(id)!;
  }

  /** This agent's LIVE monitors (retired ones are hidden), for the agent's
   *  `MonitorList` and the Monitor "Active" panel. A stopped monitor is retired
   *  (`enabled=false`) but kept in the DB so its fires stay resolvable in history. */
  listMonitors(agentId: string): Monitor[] {
    return this.db
      .select()
      .from(monitorsTable)
      .where(and(eq(monitorsTable.agentId, agentId), eq(monitorsTable.enabled, true)))
      .all()
      .map(rowToMonitor);
  }

  // ---- wake history ----

  /** This agent's recorded wakes, newest first, for the Run History pane. */
  listWakes(agentId: string, limit = 100): Wake[] {
    return this.db
      .select()
      .from(wakesTable)
      .where(eq(wakesTable.agentId, agentId))
      .orderBy(desc(wakesTable.firedAt))
      .limit(limit)
      .all()
      .map(rowToWake);
  }

  /** Retire (not delete) a monitor: stop its child and mark it `enabled=false`. The row is
   *  kept so its wake history stays resolvable; it's hidden from `listMonitors` and never restarted. */
  stopMonitor(agentId: string, id: string): boolean {
    const row = this.db.select().from(monitorsTable).where(eq(monitorsTable.id, id)).get();
    if (!row || row.agentId !== agentId) return false;
    this.runners.get(id)?.stop();
    this.runners.delete(id);
    this.db.update(monitorsTable).set({ enabled: false }).where(eq(monitorsTable.id, id)).run();
    bus.emitEvent("scheduler:changed", { agentId });
    return true;
  }

  /** Host shutdown: stop every timer and monitor child. */
  stop(): void {
    this.cron.disarmAll();
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
  }

  // ---- internals ----

  /** Arm a stored row in its pinned zone (the fallback only covers a not-yet-backfilled row). */
  private armRow(row: typeof schedulesTable.$inferSelect): void {
    const zone = row.timezone ?? systemTimeZone();
    this.armCron(row.id, row.agentId, row.cronExpr, zone, row.prompt, row.recurring);
  }

  private armCron(
    id: string,
    agentId: string,
    cronExpr: string,
    timezone: string,
    prompt: string,
    recurring: boolean,
  ): void {
    const next = this.cron.arm(id, cronExpr, timezone, recurring, () => {
      const fired = this.fireTracked(agentId, prompt, "cron", id);
      if (fired) this.markCronFired(id);
      if (recurring) {
        // Advance the stored next-fire whether or not it fired, so the Scheduled view
        // stays accurate — croner keeps ticking on schedule regardless.
        this.db
          .update(schedulesTable)
          .set({ nextFireAt: this.cron.nextRun(id) })
          .where(eq(schedulesTable.id, id))
          .run();
      } else if (fired) {
        // Retire a one-shot only when it ACTUALLY ran. If it was skipped (agent paused)
        // leave it enabled + in the past so a later boot catch-up fires it once the
        // agent is un-paused — otherwise a "run once at 9am" for a paused agent is lost.
        this.cron.disarm(id);
        this.db
          .update(schedulesTable)
          .set({ enabled: false })
          .where(eq(schedulesTable.id, id))
          .run();
      }
      // Re-broadcast after the post-fire writes land so the Scheduled view reflects
      // the final state (fresh next-fire, or a spent one-shot dropping out) rather
      // than the pre-write state fire() emitted. (fire() already emitted once; the
      // refetch is deduped, so the extra emit is harmless.)
      bus.emitEvent("scheduler:changed", { agentId });
    });
    this.db.update(schedulesTable).set({ nextFireAt: next }).where(eq(schedulesTable.id, id)).run();
  }

  private markCronFired(id: string): void {
    this.db
      .update(schedulesTable)
      .set({ lastFiredAt: Date.now() })
      .where(eq(schedulesTable.id, id))
      .run();
  }

  private startMonitor(id: string, agentId: string, command: string): void {
    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return;
    const runner = new MonitorRunner({
      command,
      cwd: this.registry.agentDir(agent),
      env: buildAgentEnv(agentId, {
        OPENTRADE_PORT: String(this.localApi.port),
        OPENTRADE_TOKEN: this.localApi.token,
      }),
      onTrigger: (line) => {
        // Only record the trigger if it actually woke the agent — a skipped fire
        // (paused agent) shouldn't advance the monitor's last-fired time.
        if (this.fireTracked(agentId, `Monitor triggered: ${line}`, "monitor", id)) {
          this.db
            .update(monitorsTable)
            .set({ lastFiredAt: Date.now() })
            .where(eq(monitorsTable.id, id))
            .run();
        }
      },
    });
    runner.start();
    this.runners.set(id, runner);
  }

  /**
   * Record the fire in the Monitor tab and hand the wake to the coordinator. The
   * coordinator owns routing (interactive via the channel / headless via `-p`) and
   * per-agent queueing, so a fire is fire-and-forget here — never blocks the timer/monitor.
   * Returns whether the fire actually happened: `false` means the agent is paused (broken /
   * out of turns) and the wake was skipped, so the caller must NOT consume the schedule
   * (advance last-fired, retire a one-shot) — see the callers in `armCron` / `start()`.
   * `sourceId` is the originating schedule/monitor id, stored on the wake (with `sourceKind`)
   * so history can resolve the timer's details even after it's retired — every caller
   * (`armCron`, `start()` catch-up, `startMonitor`'s trigger) has it in scope.
   */
  private fire(
    agentId: string,
    prompt: string,
    sourceKind: "cron" | "monitor",
    sourceId: string,
  ): boolean {
    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return false;
    // Skip the fire entirely if the coordinator would only drop this wake — the agent is
    // broken, or out of background turns. Otherwise a paused agent keeps emitting a wake
    // notification + history row on every cron tick / monitor trigger while nothing runs.
    // Re-checked live each fire, so a reset / toggle / GUI-open resumes with no re-arm.
    if (this.wake.wouldDropWake(agentId)) return false;
    // How this wake will be delivered: a live interactive session (the channel) takes it
    // warm; anything else (offline/headless) routes to a background `-p` run. The
    // coordinator decides this synchronously off the same execution state, so reading it
    // here — before enqueue — captures the routing the wake will get.
    const background = this.registry.executionStateOf(agentId) !== "interactive";
    // The wake row is the Monitor tab's record of this fire; the `scheduler:changed`
    // emit below re-queries it (and the upcoming schedules) — no separate bus event needed.
    this.db
      .insert(wakesTable)
      .values({
        id: nanoid(),
        agentId,
        sourceKind,
        sourceId,
        prompt,
        background,
        firedAt: Date.now(),
      })
      .run();
    analytics.track("schedule_fired", {
      source: sourceKind,
      path: background ? "headless" : "warm",
    });
    // Stamp `last_turn_at` at wake START, not just at the Stop hook: a run that dies
    // mid-flight (API error — Stop never fires) still moves the tray's "last active".
    this.registry.markAgentTurn(agentId);
    this.wake.enqueue(agentId, prompt);
    // Surface the new wake + updated last/next-fire times in the Monitor tab live.
    bus.emitEvent("scheduler:changed", { agentId });
    // Notify the user their agent just started working (the launcher shows it only
    // while OpenTrade is unfocused — see §12.4).
    bus.emitEvent("notify", {
      kind: "wake",
      title: `${agent.name} — ${sourceKind === "cron" ? "Scheduled run" : "Monitor fired"}`,
      body: `${agent.name} is now running: ${firstLine(prompt)}`,
      agentId,
    });
    return true;
  }

  /**
   * `fire()` wrapped so an unexpected throw off a timer/monitor tick (a DB write, the
   * coordinator enqueue) surfaces as a labeled `app_error` (subsystem "scheduler")
   * instead of vanishing into the croner/child callback. Treats an error as "did not
   * fire" (returns false) so the caller doesn't consume the schedule on a failed run.
   */
  private fireTracked(
    agentId: string,
    prompt: string,
    sourceKind: "cron" | "monitor",
    sourceId: string,
  ): boolean {
    try {
      return this.fire(agentId, prompt, sourceKind, sourceId);
    } catch (err) {
      hostLog.error("scheduler fire failed", sourceKind, String(err));
      analytics.trackError("scheduler", err, "caught");
      return false;
    }
  }

  private getCron(id: string): Schedule | undefined {
    const row = this.db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).get();
    return row ? rowToSchedule(row) : undefined;
  }

  private getMonitor(id: string): Monitor | undefined {
    const row = this.db.select().from(monitorsTable).where(eq(monitorsTable.id, id)).get();
    return row ? rowToMonitor(row) : undefined;
  }
}

function rowToSchedule(row: typeof schedulesTable.$inferSelect): Schedule {
  return {
    id: row.id,
    agentId: row.agentId,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    prompt: row.prompt,
    recurring: row.recurring,
    enabled: row.enabled,
    nextFireAt: row.nextFireAt,
    lastFiredAt: row.lastFiredAt,
    createdAt: row.createdAt,
  };
}

function rowToMonitor(row: typeof monitorsTable.$inferSelect): Monitor {
  return {
    id: row.id,
    agentId: row.agentId,
    command: row.command,
    description: row.description,
    enabled: row.enabled,
    lastFiredAt: row.lastFiredAt,
    createdAt: row.createdAt,
  };
}

function rowToWake(row: typeof wakesTable.$inferSelect): Wake {
  return {
    id: row.id,
    agentId: row.agentId,
    sourceKind: row.sourceKind as Wake["sourceKind"],
    sourceId: row.sourceId,
    prompt: row.prompt,
    background: row.background,
    firedAt: row.firedAt,
  };
}
