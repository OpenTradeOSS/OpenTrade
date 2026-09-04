import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Account, OrderStatus, Portfolio, Position, Quote } from "@shared/broker";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { analytics, type CaptureClient } from "../analytics";
import { SettingsService } from "../settings";
import { type BrokerAdapter, ConnectSuperseded } from "./adapter";
import { BrokerService } from "./index";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sqlite.exec(
    "CREATE TABLE broker_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
  );
  return drizzle(sqlite, { schema }) as unknown as Db;
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
  opts: { interactive?: boolean };
}

/**
 * The slice of BrokerAdapter `connect()` touches, with `connect` a hand-controlled
 * promise per call so tests can hold one in flight and land a second on top of it.
 * `cancelConnect` does what the real one does to a pending interactive flow: rejects
 * it with ConnectSuperseded. (No account → the poller never starts.)
 */
class FakeAdapter {
  calls: Deferred[] = [];
  cancels = 0;
  connected = false;

  connect(opts: { interactive?: boolean } = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.calls.push({ resolve, reject, opts });
    });
  }
  cancelConnect(): void {
    this.cancels++;
    const pending = this.calls.find((c) => c.opts.interactive && !("done" in c));
    if (pending) {
      Object.assign(pending, { done: true });
      pending.reject(new ConnectSuperseded());
    }
  }
  /** Land call #i as connected (and store tokens, as a real connect does). */
  succeed(i: number) {
    this.connected = true;
    this.tokens = true;
    Object.assign(this.calls[i], { done: true });
    this.calls[i].resolve();
  }
  /** Stored tokens, so `svc.isAuthorized()` means something: true after a connect
   *  lands, false after `reset()` drops them. */
  tokens = false;
  hasTokens() {
    return this.tokens;
  }
  fail(i: number, err: unknown) {
    Object.assign(this.calls[i], { done: true });
    this.calls[i].reject(err);
  }
  isConnected() {
    return this.connected;
  }
  resets = 0;
  reset() {
    this.resets++;
    this.cancelConnect();
    this.connected = false;
    this.tokens = false;
  }
  /** Set to make the service pick an account and start polling. */
  account: Account | null = null;
  async listAccounts(): Promise<Account[]> {
    return this.account ? [this.account] : [];
  }
  // ---- the poll's reads: `pollScript` decides whether a poll succeeds or how it fails ----
  pollScript: () => Promise<void> = async () => {};
  async getPortfolio(): Promise<Portfolio> {
    await this.pollScript();
    return {} as Portfolio;
  }
  async getPositions(): Promise<Position[]> {
    return [];
  }
  async getQuotes(): Promise<Quote[]> {
    return [];
  }
  async getAgenticOrders(): Promise<{ orders: OrderStatus[]; cursor: string | null }> {
    return { orders: [], cursor: null };
  }
}

interface Captured {
  event: string;
  properties?: Record<string, unknown>;
}
class FakeClient implements CaptureClient {
  events: Captured[] = [];
  capture(msg: Captured): void {
    this.events.push(msg);
  }
  async shutdown(): Promise<void> {}
}

// The service reports through the module singleton, which wires itself once
// (`start` is idempotent), so capture into one fake client for the whole file and
// clear it per test.
const client = new FakeClient();
analytics.start({ settings: new SettingsService(memDb()), client });
beforeEach(() => {
  client.events.length = 0;
});

const services: BrokerService[] = [];
afterEach(() => {
  while (services.length) services.pop()?.stopPolling();
});

function setup() {
  const db = memDb();
  const settings = new SettingsService(db);
  const adapter = new FakeAdapter();
  const svc = new BrokerService(db, adapter as unknown as BrokerAdapter, settings, {
    agentForOrder: () => null,
  });
  services.push(svc);
  return { svc, adapter, client };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BrokerService.connect — one connect at a time", () => {
  test("a silent connect joins the one in flight instead of starting another", async () => {
    const { svc, adapter } = setup();
    const first = svc.connect();
    await tick();
    const second = svc.connect();
    await tick();
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.cancels).toBe(0);
    adapter.succeed(0);
    await Promise.all([first, second]);
    expect(svc.getStatus()).toBe("connected");
  });

  test("an interactive connect supersedes a pending interactive one", async () => {
    const { svc, adapter, client } = setup();
    const first = svc.connect({ interactive: true });
    await tick();
    expect(svc.getStatus()).toBe("connecting");
    // The user clicks Connect again while the first is waiting on the browser.
    const second = svc.connect({ interactive: true });
    await tick();
    expect(adapter.cancels).toBe(1);
    // The abandoned call resolves quietly — no error to the caller, no failure event,
    // and the status is left to the attempt that took over.
    await first;
    expect(svc.getStatus()).toBe("connecting");
    expect(client.events.map((e) => e.event)).not.toContain("broker_connect_failed");
    // The second attempt is now the one in flight, and it can complete.
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].opts.interactive).toBe(true);
    adapter.succeed(1);
    await second;
    expect(svc.getStatus()).toBe("connected");
    expect(client.events.map((e) => e.event)).toContain("broker_connected");
  });

  test("an interactive connect waits for a pending silent one, then proceeds", async () => {
    const { svc, adapter } = setup();
    const silent = svc.connect();
    await tick();
    const click = svc.connect({ interactive: true });
    await tick();
    // Nothing to cancel on the silent path (no browser waiting); it just runs to its end.
    expect(adapter.calls).toHaveLength(1);
    adapter.fail(0, new Error("silent path: no session"));
    await silent.catch(() => {});
    await tick();
    // …and only then does the click get its own attempt.
    expect(adapter.calls).toHaveLength(2);
    adapter.succeed(1);
    await click;
    expect(svc.getStatus()).toBe("connected");
  });

  test("once connected, further connects are no-ops", async () => {
    const { svc, adapter } = setup();
    const c = svc.connect();
    await tick();
    adapter.succeed(0);
    await c;
    await svc.connect({ interactive: true });
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("BrokerService.disconnect — the user's Reset/Cancel", () => {
  test("while a consent is pending: abandons it, forgets the session, status → disconnected", async () => {
    const { svc, adapter, client } = setup();
    // The user clicked Connect and closed the browser tab: the flow is waiting on the
    // loopback with nothing to unstick it, the panel spinning on "connecting".
    const click = svc.connect({ interactive: true });
    await tick();
    expect(svc.getStatus()).toBe("connecting");
    await svc.disconnect();
    // The abandoned click resolves quietly (superseded), not as a failure…
    await click;
    expect(client.events.map((e) => e.event)).not.toContain("broker_connect_failed");
    // …the session is forgotten, and the Connect CTA is back.
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
    // A fresh Connect starts a new attempt rather than joining anything stale.
    const again = svc.connect({ interactive: true });
    await tick();
    expect(adapter.calls).toHaveLength(2);
    adapter.succeed(1);
    await again;
    expect(svc.getStatus()).toBe("connected");
  });

  test("while connected: forgets the session and stops polling", async () => {
    const { svc, adapter } = setup();
    const c = svc.connect();
    await tick();
    adapter.succeed(0);
    await c;
    expect(svc.getStatus()).toBe("connected");
    await svc.disconnect();
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
    expect(svc.getAccount()).toBeNull();
  });

  test("when idle: harmless", async () => {
    const { svc, adapter } = setup();
    await svc.disconnect();
    expect(adapter.resets).toBe(1);
    expect(svc.getStatus()).toBe("disconnected");
  });
});

describe("BrokerService.connect — failure telemetry", () => {
  test("broker_connect_failed carries the error's machine code when it has one", async () => {
    const { svc, adapter, client } = setup();
    const c = svc.connect({ interactive: true });
    await tick();
    adapter.fail(
      0,
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:8771"), {
        code: "EADDRINUSE",
      }),
    );
    await expect(c).rejects.toBeDefined();
    expect(svc.getStatus()).toBe("error");
    const failed = client.events.find((e) => e.event === "broker_connect_failed");
    expect(failed?.properties).toMatchObject({ error_name: "Error", error_code: "EADDRINUSE" });
    expect(JSON.stringify(failed?.properties)).not.toContain("127.0.0.1");
  });

  test("…and omits it when there is none", async () => {
    const { svc, adapter, client } = setup();
    const c = svc.connect({ interactive: true });
    await tick();
    adapter.fail(0, new TypeError("fetch failed"));
    await expect(c).rejects.toBeDefined();
    const failed = client.events.find((e) => e.event === "broker_connect_failed");
    expect(failed?.properties).toMatchObject({ error_name: "TypeError" });
    expect(failed?.properties).not.toHaveProperty("error_code");
  });
});

describe("BrokerService.connect — the funnel", () => {
  test("every attempt opens with broker_connect_started {mode}", async () => {
    const { svc, adapter, client } = setup();
    const silent = svc.connect();
    await tick();
    adapter.fail(0, new Error("no session"));
    await silent.catch(() => {});
    const click = svc.connect({ interactive: true });
    await tick();
    adapter.succeed(1);
    await click;
    const started = client.events.filter((e) => e.event === "broker_connect_started");
    expect(started.map((e) => e.properties?.mode)).toEqual(["silent", "interactive"]);
    // Outcomes still close the funnel as before.
    expect(client.events.map((e) => e.event)).toContain("broker_connect_failed");
    expect(client.events.map((e) => e.event)).toContain("broker_connected");
  });
});

/** The undici shape the poll loop actually catches on a network drop. */
const fetchFailed = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

/** Connect with an account so polling is live, then return the service + adapter. */
async function connectedWithAccount() {
  const s = setup();
  s.adapter.account = { accountNumber: "A1", agentic: true } as Account;
  const c = s.svc.connect();
  await tick();
  s.adapter.succeed(0);
  await c;
  expect(s.svc.getStatus()).toBe("connected");
  s.client.events.length = 0; // look only at what polling produces from here
  return s;
}
/** Drive one poll. (maxAge 0 is "cache older than now" — let the clock tick past the
 *  previous poll's write first, or it short-circuits to the cache within the same ms.) */
const poll = async (svc: BrokerService) => {
  await new Promise((r) => setTimeout(r, 2));
  await svc.getPositionsLive(0);
};
const events = (client: { events: { event: string }[] }) => client.events.map((e) => e.event);

describe("BrokerService poll loop — network outages are not app errors", () => {
  test("a transient network failure → one broker_offline, no app_error", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    adapter.pollScript = async () => {
      throw fetchFailed("ECONNRESET");
    };
    await poll(svc);
    expect(events(client)).toEqual(["broker_offline"]);
    expect(client.events[0].properties).toMatchObject({ error_code: "ECONNRESET" });
    // Status is untouched: the panel keeps showing cached data.
    expect(svc.getStatus()).toBe("connected");
  });

  test("a sleep-interrupted poll (MCP RequestTimeout) is broker_offline, labelled by enum name", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // The POST connected, then the machine froze mid-request → the SDK's 60 s timer.
    adapter.pollScript = async () => {
      throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
    };
    await poll(svc);
    expect(events(client)).toEqual(["broker_offline"]);
    // The numeric MCP code becomes its enum name instead of being dropped.
    expect(client.events[0].properties).toMatchObject({ error_code: "RequestTimeout" });
    expect(svc.getStatus()).toBe("connected");
  });

  test("consecutive failures in one outage stay one event; recovery emits broker_online with counts", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // Last night's shape: 5 failed polls in a row while the laptop's Wi‑Fi came back.
    adapter.pollScript = async () => {
      throw fetchFailed("ENOTFOUND");
    };
    for (let i = 0; i < 5; i++) await poll(svc);
    expect(events(client)).toEqual(["broker_offline"]);
    // Network is back.
    adapter.pollScript = async () => {};
    await poll(svc);
    expect(events(client)).toEqual(["broker_offline", "broker_online"]);
    expect(client.events[1].properties).toMatchObject({ failed_polls: 5 });
    expect(client.events[1].properties?.offline_ms).toBeGreaterThanOrEqual(0);
    // A second, separate outage reports again.
    adapter.pollScript = async () => {
      throw fetchFailed("ECONNREFUSED");
    };
    await poll(svc);
    expect(events(client)).toEqual(["broker_offline", "broker_online", "broker_offline"]);
    expect(client.events[2].properties).toMatchObject({ error_code: "ECONNREFUSED" });
  });

  test("healthy polls emit nothing", async () => {
    const { svc, client } = await connectedWithAccount();
    await poll(svc);
    await poll(svc);
    expect(events(client)).toEqual([]);
  });

  test("a non-network failure is still an app_error — every time", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // e.g. a mapping bug thrown from our own code.
    adapter.pollScript = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'equity')");
    };
    await poll(svc);
    await poll(svc);
    expect(events(client)).toEqual(["app_error", "app_error"]);
    expect(client.events[0].properties).toMatchObject({
      subsystem: "broker",
      error_name: "TypeError",
      source: "caught",
    });
  });

  test("an unprintable thrown value still reports — logging must not eat the telemetry", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // A null-prototype object makes `String()` throw. The failure description is built
    // first in the catch, so an unguarded throw there would skip trackError entirely and
    // turn a handled poll failure into an unhandled rejection.
    adapter.pollScript = async () => {
      throw Object.create(null);
    };
    await poll(svc);
    expect(events(client)).toEqual(["app_error"]);
    expect(client.events[0].properties).toMatchObject({ subsystem: "broker", source: "caught" });
  });

  test("a server-side McpError app_error is labelled by enum name, not left bare", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // Not one of the transient MCP codes, so it stays an app_error — the bucket that in
    // production arrived as `McpError` with no code at all, because an McpError's `code`
    // is numeric (-32603) and the allowlist drops numbers. The broker resolves it.
    adapter.pollScript = async () => {
      throw new McpError(ErrorCode.InternalError, "Internal error");
    };
    await poll(svc);
    expect(events(client)).toEqual(["app_error"]);
    expect(client.events[0].properties).toMatchObject({
      subsystem: "broker",
      error_name: "McpError",
      error_code: "InternalError",
      source: "caught",
    });
  });

  test("a revoked grant ends the session instead of retrying it forever", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // Production shape: the stored refresh token was revoked, so the first poll to use it
    // throws and every later one throws identically. One install emitted 167 of these in
    // 26 minutes — one per poll — while its UI still read `connected`.
    adapter.pollScript = async () => {
      throw new InvalidGrantError("token revoked");
    };
    expect(svc.isAuthorized()).toBe(true);
    await poll(svc);
    // Reported once, then the session is over: tokens dropped, so the panel shows the
    // Connect CTA (a fresh consent) rather than pretending it can reconnect silently.
    // The end itself is counted, so a stranded install is visible in telemetry.
    expect(events(client)).toEqual(["app_error", "broker_session_ended"]);
    expect(client.events[0].properties).toMatchObject({
      subsystem: "broker",
      error_name: "InvalidGrantError",
      source: "caught",
    });
    expect(client.events[1].properties).toMatchObject({ reason: "invalid_grant" });
    expect(svc.getStatus()).toBe("disconnected");
    expect(adapter.resets).toBe(1);
    expect(svc.isAuthorized()).toBe(false);

    // And the loop is genuinely stopped — a further poll reports nothing new.
    await poll(svc);
    expect(events(client)).toEqual(["app_error", "broker_session_ended"]);
  });

  test("a revoked grant on the connect-time first poll ends the session without hanging connect()", async () => {
    const { svc, adapter, client } = setup();
    adapter.account = { accountNumber: "A1", agentic: true } as Account;
    // `runConnect` awaits the first poll itself, while `inflight` still holds runConnect.
    // Ending the session there via `disconnect()` — which awaits `inflight` — waited on
    // itself: connect() never resolved, status stuck on `connected`, Reset hung too.
    adapter.pollScript = async () => {
      throw new InvalidGrantError("token revoked");
    };
    const c = svc.connect();
    await tick();
    adapter.succeed(0);
    await c; // hung forever before the fix
    expect(svc.getStatus()).toBe("disconnected");
    expect(adapter.resets).toBe(1);
    expect(events(client)).toEqual([
      "broker_connect_started",
      "broker_connected",
      "app_error",
      "broker_session_ended",
    ]);
    // No poller was started for the session that no longer exists…
    expect((svc as unknown as { timer: unknown }).timer).toBeNull();
    // …and the user's Reset still works.
    await svc.disconnect();
    expect(svc.getStatus()).toBe("disconnected");
  });

  test("a 401 mid-session is NOT treated as a dead grant — good tokens are kept", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // `isReauthRequired` on the connect path also counts UnauthorizedError, but on the
    // poll path a transient/endpoint-specific 401 must not cost the user their session.
    adapter.pollScript = async () => {
      throw new UnauthorizedError("nope");
    };
    await poll(svc);
    expect(events(client)).toEqual(["app_error"]);
    expect(svc.getStatus()).toBe("connected");
  });

  test("disconnect closes the books: no broker_online spanning a deliberate disconnect", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    adapter.pollScript = async () => {
      throw fetchFailed("ECONNRESET");
    };
    await poll(svc);
    await svc.disconnect();
    // Reconnect and poll fine: no stale broker_online from the pre-disconnect outage.
    adapter.pollScript = async () => {};
    const again = svc.connect();
    await tick();
    adapter.succeed(1);
    await again;
    await poll(svc);
    expect(events(client).filter((e) => e === "broker_online")).toEqual([]);
  });

  test("a poll in flight when disconnect() runs reports nothing and doesn't reopen tracking", async () => {
    const { svc, adapter, client } = await connectedWithAccount();
    // Hold a poll mid-request, disconnect under it, then let it fail (as its closed
    // client would make it): no app_error, no broker_offline, and a later reconnect's
    // first good poll must not emit a broker_online spanning the disconnect.
    let failPoll!: () => void;
    adapter.pollScript = () =>
      new Promise<void>((_, reject) => {
        failPoll = () => reject(fetchFailed("ECONNRESET"));
      });
    const inflight = poll(svc);
    await new Promise((r) => setTimeout(r, 5));
    await svc.disconnect();
    failPoll();
    await inflight;
    expect(events(client)).toEqual([]);
    adapter.pollScript = async () => {};
    const again = svc.connect();
    await tick();
    adapter.succeed(1);
    await again;
    await poll(svc);
    expect(
      events(client).filter((e) => e !== "broker_connect_started" && e !== "broker_connected"),
    ).toEqual([]);
  });
});
