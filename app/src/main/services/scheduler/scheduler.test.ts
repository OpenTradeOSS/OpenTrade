import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Agent } from "@shared/agent";
import { Cron } from "croner";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import type { AgentRegistry } from "../agents/registry";
import { bus } from "../event-bus";
import type { LocalApiServer } from "../local-api";
import { Scheduler } from "./index";
import type { PendingWake, WakeTransport } from "./wake/types";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
      timezone TEXT, prompt TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, next_fire_at INTEGER,
      last_fired_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE monitors (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, command TEXT NOT NULL,
      description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE wakes (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      source_id TEXT, prompt TEXT NOT NULL, background INTEGER NOT NULL,
      fired_at INTEGER NOT NULL, outcome TEXT, finished_at INTEGER,
      failure_reason TEXT, failure_category TEXT);
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AGENT: Agent = {
  id: "agent1",
  slug: "agent1",
  name: "Agent One",
  template: "default",
  approvalMode: "auto",
  lastSessionId: null,
  status: "idle",
  executionState: "offline",
  createdAt: 0,
  archivedAt: null,
};

/** Standard test stubs: a wake transport that "starts" every wake immediately as a
 *  background run (so a fire lands in the wakes table synchronously, the way the
 *  coordinator's `wakeStarted` callback does in prod), a registry that only knows AGENT,
 *  and a dummy localApi. `bind` wires the transport to the scheduler once built. */
function stdDeps() {
  let scheduler: Scheduler | undefined;
  const wakes: PendingWake[] = []; // every wake handed to the transport, in order
  const wake: WakeTransport = {
    enqueue: (_agentId, w) => {
      wakes.push(w);
      scheduler?.wakeStarted(w, true);
    },
    onTurnEnded: () => {},
    onTurnFailed: () => {},
    awaitPoll: async () => null,
    onInteractiveUp: () => {},
    onInteractiveDown: () => {},
    wouldDropWake: () => false,
    stop: () => false,
    stopAll: () => {},
  };
  const registry = {
    get: (id: string) => (id === AGENT.id ? AGENT : undefined),
    agentDir: () => tmpdir(),
    executionStateOf: () => "offline" as const,
    markAgentTurn: () => {},
  } as unknown as AgentRegistry;
  const localApi = { port: 12345, token: "tok" } as unknown as LocalApiServer;
  const bind = (s: Scheduler) => {
    scheduler = s;
    return s;
  };
  return { wake, wakes, registry, localApi, bind };
}

/** Build a Scheduler over a caller-supplied db so the test can inspect raw rows
 *  (e.g. assert a retired row survives). */
function makeSchedulerOn(db: Db): Scheduler {
  return makeSchedulerWithWakes(db).s;
}

/** As `makeSchedulerOn`, also exposing the wakes the transport received. */
function makeSchedulerWithWakes(db: Db): { s: Scheduler; wakes: PendingWake[] } {
  const { wake, wakes, registry, localApi, bind } = stdDeps();
  return { s: bind(new Scheduler(db, wake, registry, localApi)), wakes };
}

function makeScheduler() {
  return makeSchedulerOn(memDb());
}

describe("Scheduler CRUD", () => {
  let scheduler: Scheduler;
  afterEach(() => scheduler?.stop());

  test("createCron persists, lists, computes next fire, and retires", () => {
    scheduler = makeScheduler();
    const created = scheduler.createCron("agent1", {
      cron: "30 9 * * 1-5",
      prompt: "review positions",
      recurring: true,
    });
    expect(created.cronExpr).toBe("30 9 * * 1-5");
    expect(created.enabled).toBe(true);
    expect(created.nextFireAt).not.toBeNull();
    expect(created.nextFireAt!).toBeGreaterThan(Date.now());

    expect(scheduler.listCron("agent1").map((s) => s.id)).toEqual([created.id]);

    expect(scheduler.deleteCron("agent1", created.id)).toBe(true);
    expect(scheduler.listCron("agent1")).toEqual([]);
  });

  test("createCron rejects an invalid expression", () => {
    scheduler = makeScheduler();
    expect(() =>
      scheduler.createCron("agent1", { cron: "nope", prompt: "x", recurring: true }),
    ).toThrow();
  });

  test("deleteCron refuses an id owned by another agent", () => {
    scheduler = makeScheduler();
    const created = scheduler.createCron("agent1", {
      cron: "0 0 * * *",
      prompt: "x",
      recurring: true,
    });
    expect(scheduler.deleteCron("other", created.id)).toBe(false);
    expect(scheduler.listCron("agent1")).toHaveLength(1);
  });

  test("monitor create/list/stop round-trips", () => {
    scheduler = makeScheduler();
    const m = scheduler.createMonitor("agent1", { command: "sleep 30", description: "watch" });
    expect(m.command).toBe("sleep 30");
    expect(m.description).toBe("watch");
    expect(scheduler.listMonitors("agent1").map((x) => x.id)).toEqual([m.id]);
    expect(scheduler.stopMonitor("agent1", m.id)).toBe(true);
    expect(scheduler.listMonitors("agent1")).toEqual([]);
  });

  test("removeAgent disarms and RETIRES all of an agent's schedules + monitors (rows kept, hidden)", () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    scheduler.createCron("agent1", { cron: "0 9 * * *", prompt: "a", recurring: true });
    scheduler.createCron("agent1", { cron: "0 17 * * *", prompt: "b", recurring: true });
    scheduler.createMonitor("agent1", { command: "sleep 30" });
    expect(scheduler.listCron("agent1")).toHaveLength(2);
    expect(scheduler.listMonitors("agent1")).toHaveLength(1);

    scheduler.removeAgent("agent1");

    // Hidden from the live lists…
    expect(scheduler.listCron("agent1")).toEqual([]);
    expect(scheduler.listMonitors("agent1")).toEqual([]);
    // …but the rows survive, retired (enabled=false) rather than deleted, so history
    // can still resolve them.
    const crons = db.select().from(schema.schedules).all();
    expect(crons).toHaveLength(2);
    expect(crons.every((r) => r.enabled === false)).toBe(true);
    const mons = db.select().from(schema.monitors).all();
    expect(mons).toHaveLength(1);
    expect(mons[0].enabled).toBe(false);
  });

  test("start() self-heals schedules orphaned by an archived/deleted agent", () => {
    const db = memDb();
    // Two pre-existing rows: one for the live agent, one for a now-gone agent.
    db.insert(schema.schedules)
      .values({
        id: "live",
        agentId: "agent1",
        cronExpr: "0 9 * * *",
        prompt: "keep",
        recurring: true,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    db.insert(schema.schedules)
      .values({
        id: "orphan",
        agentId: "ghost",
        cronExpr: "0 9 * * *",
        prompt: "drop",
        recurring: true,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    const wake: WakeTransport = {
      enqueue: () => {},
      onTurnEnded: () => {},
      onTurnFailed: () => {},
      awaitPoll: async () => null,
      onInteractiveUp: () => {},
      onInteractiveDown: () => {},
      wouldDropWake: () => false,
      stop: () => false,
      stopAll: () => {},
    };
    const registry = {
      get: (id: string) => (id === AGENT.id ? AGENT : undefined),
      agentDir: () => tmpdir(),
      executionStateOf: () => "offline" as const,
      markAgentTurn: () => {},
    } as unknown as AgentRegistry;
    const localApi = { port: 1, token: "t" } as unknown as LocalApiServer;
    scheduler = new Scheduler(db, wake, registry, localApi);
    scheduler.start();

    expect(scheduler.listCron("agent1").map((s) => s.id)).toEqual(["live"]);
    expect(scheduler.listCron("ghost")).toEqual([]); // orphan deleted
  });

  test("start() skips catch-up + arming for a broken agent, but keeps the rows", () => {
    const seedPastCron = (db: Db) =>
      db
        .insert(schema.schedules)
        .values({
          id: "c",
          agentId: "agent1",
          cronExpr: "0 9 * * *",
          prompt: "p",
          recurring: true,
          enabled: true,
          nextFireAt: 1, // in the past → would catch-up fire if armed
          lastFiredAt: null,
          createdAt: 1,
        })
        .run();
    const makeWith = (execState: "offline" | "broken") => {
      const db = memDb();
      seedPastCron(db);
      let enqueued = 0;
      const wake: WakeTransport = {
        enqueue: () => {
          enqueued += 1;
        },
        onTurnEnded: () => {},
        onTurnFailed: () => {},
        awaitPoll: async () => null,
        onInteractiveUp: () => {},
        onInteractiveDown: () => {},
        wouldDropWake: () => false,
        stop: () => false,
        stopAll: () => {},
      };
      const registry = {
        get: (id: string) => (id === AGENT.id ? AGENT : undefined),
        agentDir: () => tmpdir(),
        executionStateOf: () => execState,
        markAgentTurn: () => {},
      } as unknown as AgentRegistry;
      const s = new Scheduler(db, wake, registry, {
        port: 1,
        token: "t",
      } as unknown as LocalApiServer);
      s.start();
      return { s, enqueued: () => enqueued };
    };

    const offline = makeWith("offline");
    expect(offline.enqueued()).toBe(1); // healthy agent catches up the missed fire
    offline.s.stop();

    const broken = makeWith("broken");
    expect(broken.enqueued()).toBe(0); // broken agent: no catch-up, not armed
    expect(broken.s.listCron("agent1")).toHaveLength(1); // …but the row is untouched
    scheduler = broken.s; // let afterEach stop it
  });

  test("disarmAgent pauses (keeps rows enabled) where removeAgent retires; rearm restores", () => {
    scheduler = makeScheduler();
    scheduler.createCron("agent1", { cron: "0 9 * * *", prompt: "a", recurring: true });
    scheduler.createMonitor("agent1", { command: "sleep 30" });

    scheduler.disarmAgent("agent1");
    // Unlike removeAgent, the rows survive and stay enabled — just unarmed.
    expect(scheduler.listCron("agent1")).toHaveLength(1);
    expect(scheduler.listCron("agent1")[0].enabled).toBe(true);
    expect(scheduler.listMonitors("agent1")).toHaveLength(1);

    // rearm is idempotent and keeps them (restart-recovery path).
    scheduler.rearmAgent("agent1");
    expect(scheduler.listCron("agent1")).toHaveLength(1);
    expect(scheduler.listMonitors("agent1")).toHaveLength(1);
  });

  test("a paused agent's fire is skipped: no wake row, no notify, one-shot not retired", () => {
    const db = memDb();
    // A one-shot cron whose fire time is already past → start() takes the catch-up path.
    db.insert(schema.schedules)
      .values({
        id: "os",
        agentId: "agent1",
        cronExpr: "0 9 * * *",
        prompt: "p",
        recurring: false,
        enabled: true,
        nextFireAt: 1, // past
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    let enqueued = 0;
    const wake: WakeTransport = {
      enqueue: () => {
        enqueued += 1;
      },
      onTurnEnded: () => {},
      onTurnFailed: () => {},
      awaitPoll: async () => null,
      onInteractiveUp: () => {},
      onInteractiveDown: () => {},
      wouldDropWake: () => true, // agent is paused (broken / out of turns)
      stop: () => false,
      stopAll: () => {},
    };
    const registry = {
      get: (id: string) => (id === AGENT.id ? AGENT : undefined),
      agentDir: () => tmpdir(),
      executionStateOf: () => "offline" as const,
      markAgentTurn: () => {},
    } as unknown as AgentRegistry;

    const notifies: unknown[] = [];
    const off = bus.onEvent("notify", (n) => notifies.push(n));
    scheduler = new Scheduler(db, wake, registry, {
      port: 1,
      token: "t",
    } as unknown as LocalApiServer);
    scheduler.start();
    off();

    expect(enqueued).toBe(0); // wake never handed to the coordinator
    expect(db.select().from(schema.wakes).all()).toEqual([]); // no history row
    expect(notifies).toEqual([]); // no wake notification
    // The one-shot is NOT retired — it stays enabled for a later catch-up once un-paused.
    expect(scheduler.listCron("agent1").map((s) => s.enabled)).toEqual([true]);
  });

  test("deleteCron retires the cron: disarmed, hidden from listCron, row kept enabled=false", () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    const c = scheduler.createCron("agent1", { cron: "0 9 * * *", prompt: "x", recurring: true });

    expect(scheduler.deleteCron("agent1", c.id)).toBe(true);
    expect(scheduler.listCron("agent1")).toEqual([]); // hidden from the live list

    const rows = db.select().from(schema.schedules).all();
    expect(rows).toHaveLength(1); // …but not deleted
    expect(rows[0].id).toBe(c.id);
    expect(rows[0].enabled).toBe(false); // retired
  });

  test("stopMonitor retires the monitor: hidden from listMonitors, row kept enabled=false", () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    const m = scheduler.createMonitor("agent1", { command: "sleep 30", description: "w" });

    expect(scheduler.stopMonitor("agent1", m.id)).toBe(true);
    expect(scheduler.listMonitors("agent1")).toEqual([]);

    const rows = db.select().from(schema.monitors).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(m.id);
    expect(rows[0].enabled).toBe(false);
  });

  test("a fired cron wake records source_id + source_kind linking back to its schedule", () => {
    const db = memDb();
    // Past-due one-shot → start()'s catch-up fires it synchronously (healthy agent).
    db.insert(schema.schedules)
      .values({
        id: "cron1",
        agentId: "agent1",
        cronExpr: "0 9 * * *",
        prompt: "p",
        recurring: false,
        enabled: true,
        nextFireAt: 1, // past
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    scheduler = makeSchedulerOn(db);
    scheduler.start();

    const wakes = db.select().from(schema.wakes).all();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].sourceKind).toBe("cron");
    expect(wakes[0].sourceId).toBe("cron1"); // links wake → (now retired) schedule
  });

  test("wakeStarted writes the row `running`; wakeFinished settles it once with the failure detail", () => {
    const db = memDb();
    db.insert(schema.schedules)
      .values({
        id: "cron1",
        agentId: "agent1",
        cronExpr: "0 9 * * *",
        prompt: "p",
        recurring: false,
        enabled: true,
        nextFireAt: 1, // past → start() catch-up fires it
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    const { s, wakes: handed } = makeSchedulerWithWakes(db);
    scheduler = s;
    scheduler.start();

    expect(handed).toHaveLength(1);
    let row = db.select().from(schema.wakes).get()!;
    expect(row.id).toBe(handed[0].id); // the fire-time id IS the History row's id
    expect(row.outcome).toBe("running");
    expect(row.finishedAt).toBeNull();

    scheduler.wakeFinished(handed[0], {
      outcome: "failed",
      failureReason: "resume_fail",
      failureCategory: "billing",
    });
    row = db.select().from(schema.wakes).get()!;
    expect(row.outcome).toBe("failed");
    expect(row.failureReason).toBe("resume_fail");
    expect(row.failureCategory).toBe("billing");
    expect(row.finishedAt).not.toBeNull();
    expect(db.select().from(schema.wakes).all()).toHaveLength(1); // updated, not re-inserted

    // Settling is exactly-once at the DB layer: a second settle for the same wake is a no-op.
    scheduler.wakeFinished(handed[0], { outcome: "succeeded" });
    row = db.select().from(schema.wakes).get()!;
    expect(row.outcome).toBe("failed");
    expect(row.failureCategory).toBe("billing");
  });

  test("start() marks wakes left `running` by the previous host as stopped", () => {
    const db = memDb();
    const base = {
      agentId: "agent1",
      sourceKind: "cron",
      sourceId: null,
      prompt: "p",
      background: true,
      firedAt: 1000,
      finishedAt: null,
      failureReason: null,
      failureCategory: null,
    } as const;
    db.insert(schema.wakes)
      .values({ ...base, id: "orphan", outcome: "running" })
      .run();
    db.insert(schema.wakes)
      .values({ ...base, id: "done", outcome: "succeeded", finishedAt: 2000 })
      .run();
    scheduler = makeSchedulerOn(db);
    scheduler.start();

    const rows = Object.fromEntries(
      db
        .select()
        .from(schema.wakes)
        .all()
        .map((r) => [r.id, r]),
    );
    expect(rows.orphan.outcome).toBe("stopped");
    expect(rows.orphan.finishedAt).not.toBeNull();
    expect(rows.done.outcome).toBe("succeeded"); // settled rows are untouched
    expect(rows.done.finishedAt).toBe(2000);
  });

  test("wakeStats counts outcomes in the window across agents, with the top failure category", () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    const now = Date.now();
    const row = (id: string, agentId: string, firedAt: number, extra: Record<string, unknown>) =>
      db
        .insert(schema.wakes)
        .values({
          id,
          agentId,
          sourceKind: "cron",
          sourceId: null,
          prompt: "p",
          background: true,
          firedAt,
          outcome: null,
          finishedAt: null,
          failureReason: null,
          failureCategory: null,
          ...extra,
        })
        .run();
    row("w1", "agent1", now - 1000, { outcome: "succeeded" });
    row("w2", "agent1", now - 2000, {
      outcome: "failed",
      failureReason: "resume_fail",
      failureCategory: "billing",
    });
    row("w3", "agent2", now - 3000, {
      outcome: "failed",
      failureReason: "api_error",
      failureCategory: "billing",
    });
    row("w4", "agent2", now - 4000, {
      outcome: "failed",
      failureReason: "api_error",
      failureCategory: "network",
    });
    row("w5", "agent1", now - 5000, { outcome: "stopped" });
    row("w6", "agent1", now - 6000, { outcome: "running" });
    row("old", "agent1", now - 10 * 86_400_000, { outcome: "failed", failureCategory: "auth" }); // outside

    expect(scheduler.wakeStats(now - 7 * 86_400_000)).toEqual({
      total: 6,
      failed: 3,
      stopped: 1,
      apiErrors: 2,
      topFailureCategory: "billing",
    });
    expect(scheduler.wakeStats(now).topFailureCategory).toBeNull(); // empty window
  });

  test("listTriggers returns the agent's retired crons/monitors too (History resolves them)", () => {
    scheduler = makeScheduler();
    const cron = scheduler.createCron("agent1", {
      cron: "30 9 * * 1-5",
      prompt: "p",
      recurring: true,
    });
    const mon = scheduler.createMonitor("agent1", { command: "sleep 5" });
    scheduler.deleteCron("agent1", cron.id);
    scheduler.stopMonitor("agent1", mon.id);

    expect(scheduler.listCron("agent1")).toEqual([]); // MCP-facing lists hide retired rows
    expect(scheduler.listMonitors("agent1")).toEqual([]);
    const all = scheduler.listTriggers("agent1");
    expect(all.schedules.map((s) => [s.id, s.enabled])).toEqual([[cron.id, false]]);
    expect(all.monitors.map((m) => [m.id, m.enabled])).toEqual([[mon.id, false]]);
  });

  test("a fired monitor wake records source_id + source_kind linking back to its monitor", async () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    // A command that emits one line immediately → one trigger → one fire.
    const m = scheduler.createMonitor("agent1", { command: "printf 'go\\n'; sleep 5" });
    await wait(300);

    const wakes = db.select().from(schema.wakes).all();
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    expect(wakes[0].sourceKind).toBe("monitor");
    expect(wakes[0].sourceId).toBe(m.id); // links wake → its monitor
  });
});

describe("Scheduler cron timezone pinning", () => {
  let scheduler: Scheduler;
  afterEach(() => scheduler?.stop());

  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  const nextIn = (expr: string, timezone: string) =>
    new Cron(expr, { timezone, paused: true }).nextRun()?.getTime();

  test("createCron stamps the machine's zone at creation and arms in it", () => {
    process.env.TZ = "Asia/Dubai"; // what `systemTimeZone()` resolves in this process
    scheduler = makeScheduler();
    const created = scheduler.createCron("agent1", {
      cron: "30 5 * * *",
      prompt: "premarket",
      recurring: true,
    });
    expect(created.timezone).toBe("Asia/Dubai");
    expect(created.nextFireAt).toBe(nextIn("30 5 * * *", "Asia/Dubai"));
  });

  test("a stored zone is honoured on boot even when the machine has since moved", () => {
    const db = memDb();
    db.insert(schema.schedules)
      .values({
        id: "pinned",
        agentId: "agent1",
        cronExpr: "30 5 * * *",
        timezone: "America/Los_Angeles", // authored in LA…
        prompt: "premarket",
        recurring: true,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: 1,
      })
      .run();
    process.env.TZ = "Asia/Dubai"; // …but the host now boots in Dubai
    scheduler = makeSchedulerOn(db);
    scheduler.start();
    const [row] = scheduler.listCron("agent1");
    expect(row.timezone).toBe("America/Los_Angeles"); // unchanged by the move
    expect(row.nextFireAt).toBe(nextIn("30 5 * * *", "America/Los_Angeles"));
    expect(row.nextFireAt).not.toBe(nextIn("30 5 * * *", "Asia/Dubai"));
  });

  test("start() backfills a pre-v6 row (NULL zone) with the machine's current zone", () => {
    const db = memDb();
    for (const [id, enabled] of [
      ["live", true],
      ["retired", false],
    ] as const) {
      db.insert(schema.schedules)
        .values({
          id,
          agentId: "agent1",
          cronExpr: "0 9 * * *",
          timezone: null,
          prompt: "p",
          recurring: true,
          enabled,
          nextFireAt: null,
          lastFiredAt: null,
          createdAt: 1,
        })
        .run();
    }
    process.env.TZ = "Asia/Tokyo";
    scheduler = makeSchedulerOn(db);
    scheduler.start();
    const rows = db.select().from(schema.schedules).all();
    expect(rows.map((r) => r.timezone)).toEqual(["Asia/Tokyo", "Asia/Tokyo"]); // both stamped
    const live = scheduler.listCron("agent1")[0];
    expect(live.nextFireAt).toBe(nextIn("0 9 * * *", "Asia/Tokyo")); // armed in the stamp
  });
});
