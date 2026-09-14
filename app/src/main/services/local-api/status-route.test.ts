import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRegistry } from "../agents/registry";
import type { WakeTransport } from "../scheduler/wake/types";
import { LocalApiServer } from "./index";

/** Every side effect the status route can have, in call order. */
const calls: string[] = [];

const registry = {
  get: (id: string) => (id === "a1" ? ({ id: "a1", harness: "claude" } as never) : undefined),
  markAgentTurn: (id: string) => calls.push(`turn:${id}`),
  setLastSessionId: (id: string, sid: string) => calls.push(`session:${id}:${sid}`),
} as unknown as AgentRegistry;
const arbiter = {
  setNeedsInput: (id: string, on: boolean) => calls.push(`needsInput:${id}:${on}`),
};
const wake = {
  onTurnEnded: (id: string) => calls.push(`ended:${id}`),
  onTurnFailed: (id: string, category: string) => calls.push(`failed:${id}:${category}`),
} as unknown as WakeTransport;

// biome-ignore lint/suspicious/noExplicitAny: stubs stand in for the real services
const server = new LocalApiServer({ registry, arbiter } as any);
server.setWake(wake);
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
beforeEach(() => {
  calls.length = 0;
});

/** POST a Claude Code hook payload as the agent's status hook script would. */
async function hook(body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${base}/hook/status`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(body),
  });
  return res.status;
}

describe("/hook/status", () => {
  test("Notification: needs-input on, last-active stamped, no wake settlement", async () => {
    expect(await hook({ hook_event_name: "Notification", session_id: "s1" })).toBe(200);
    expect(calls).toEqual(["turn:a1", "needsInput:a1:true"]);
  });

  test("Stop: clears needs-input, settles the wake succeeded, captures the session", async () => {
    expect(await hook({ hook_event_name: "Stop", session_id: "s1" })).toBe(200);
    expect(calls).toEqual(["turn:a1", "needsInput:a1:false", "ended:a1", "session:a1:s1"]);
  });

  test("StopFailure: same turn-ended bookkeeping, wake settles failed with the mapped category", async () => {
    // The payload's `error` field is Claude Code's enum; the route maps it (billing_error → billing).
    expect(
      await hook({ hook_event_name: "StopFailure", error: "billing_error", session_id: "s1" }),
    ).toBe(200);
    expect(calls).toEqual(["turn:a1", "needsInput:a1:false", "failed:a1:billing", "session:a1:s1"]);
  });

  test("StopFailure without an error field still settles the wake (category other)", async () => {
    expect(await hook({ hook_event_name: "StopFailure" })).toBe(200);
    expect(calls).toContain("failed:a1:other");
  });

  test("an unknown agent is rejected before any bookkeeping", async () => {
    const res = await fetch(`${base}/hook/status`, {
      method: "POST",
      headers: { ...hdrs, "x-opentrade-agent": "nope" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(res.status).toBe(200); // the route answers ok to the hook regardless…
    expect(calls).toEqual([]); // …but touches nothing for an agent it doesn't know
  });
});
