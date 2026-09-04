import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { Agent } from "@shared/agent";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import type { AgentRegistry } from "../agents/registry";
import { bus } from "../event-bus";
import type { LocalApiServer } from "../local-api";
import { Scheduler } from "./index";
import type { WakeTransport } from "./wake/types";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, next_fire_at INTEGER,
      last_fired_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE monitors (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, command TEXT NOT NULL,
      description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE wakes (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      source_id TEXT, prompt TEXT NOT NULL, background INTEGER NOT NULL,
      fired_at INTEGER NOT NULL);
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

/** Standard test stubs: a no-op wake transport (fires never dropped), a registry that
 *  only knows AGENT, and a dummy localApi. */
function stdDeps() {
  const wake: WakeTransport = {
    enqueue: () => {},
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
  return { wake, registry, localApi };
}

/** Build a Scheduler over a caller-supplied db so the test can inspect raw rows
 *  (e.g. assert a retired row survives). */
function makeSchedulerOn(db: Db): Scheduler {
  const { wake, registry, localApi } = stdDeps();
  return new Scheduler(db, wake, registry, localApi);
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

  test("a fired monitor wake records source_id + source_kind linking back to its monitor", async () => {
    const db = memDb();
    scheduler = makeSchedulerOn(db);
    // A command that emits one line immediately → one trigger → one fire.
    const m = scheduler.createMonitor("agent1", {
      command: `"${process.execPath}" -e "console.log('go'); setTimeout(() => {}, 5000)"`,
    });
    await wait(300);

    const wakes = db.select().from(schema.wakes).all();
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    expect(wakes[0].sourceKind).toBe("monitor");
    expect(wakes[0].sourceId).toBe(m.id); // links wake → its monitor
  });
});
