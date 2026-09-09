import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentRegistry } from "../agents/registry";
import type { Scheduler } from "../scheduler";
import { LocalApiServer } from "./index";

const registry = {
  get: (id: string) => (id === "a1" ? ({ id: "a1" } as never) : undefined),
} as unknown as AgentRegistry;

const scheduler = {
  createCron: (_a: string, input: { cron: string; prompt: string }) => ({
    id: "s1",
    cronExpr: input.cron,
    timezone: "America/New_York", // host-owned; must never reach the agent
    prompt: input.prompt,
  }),
  listCron: () => [{ id: "s1", timezone: "America/New_York" }],
  listMonitors: () => [],
  deleteCron: () => true,
  createMonitor: (_a: string, input: { command: string }) => ({ id: "m1", command: input.command }),
  stopMonitor: () => true,
} as unknown as Scheduler;

// biome-ignore lint/suspicious/noExplicitAny: stubs stand in for the real services
const server = new LocalApiServer({ registry } as any);
server.setScheduler(scheduler);
let base = "";

const hdrs = {
  "x-opentrade-token": "",
  "x-opentrade-agent": "a1",
  "content-type": "application/json",
};

beforeAll(async () => {
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
  hdrs["x-opentrade-token"] = server.token;
});
afterAll(() => server.stop());

describe("/schedules routes", () => {
  test("rejects a missing token", async () => {
    const res = await fetch(`${base}/schedules`, { headers: { "x-opentrade-agent": "a1" } });
    expect(res.status).toBe(401);
  });

  test("rejects an unknown agent", async () => {
    const res = await fetch(`${base}/schedules`, {
      headers: { "x-opentrade-token": server.token, "x-opentrade-agent": "nope" },
    });
    expect(res.status).toBe(404);
  });

  test("creates a cron schedule", async () => {
    const res = await fetch(`${base}/schedules/cron`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ cron: "0 9 * * *", prompt: "review", recurring: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("s1");
    expect(body.cronExpr).toBe("0 9 * * *");
    expect(body).not.toHaveProperty("timezone"); // host-owned, hidden from the agent
  });

  test("rejects a malformed cron body (zod)", async () => {
    const res = await fetch(`${base}/schedules/cron`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ prompt: "missing cron" }),
    });
    expect(res.status).toBe(400);
  });

  test("lists cron + monitors", async () => {
    const res = await fetch(`${base}/schedules`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cron: Record<string, unknown>[]; monitors: unknown[] };
    expect(body.cron).toHaveLength(1);
    expect(body.cron[0]).not.toHaveProperty("timezone"); // hidden from the agent's CronList
    expect(body.monitors).toEqual([]);
  });

  test("deletes a cron schedule", async () => {
    const res = await fetch(`${base}/schedules/cron/s1`, { method: "DELETE", headers: hdrs });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});
