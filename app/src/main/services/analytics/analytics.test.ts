import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assetTypeOf,
  errorCodeOf,
  errorNameOf,
  orderKindOf,
  orderTypeOf,
  RendererTrackInput,
  sanitizeStack,
  sideOf,
  TELEMETRY_EVENTS,
  templateOf,
} from "@shared/analytics";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { SettingsService } from "../settings";
import { AnalyticsService, type CaptureClient } from "./index";

// Same stand-in the SettingsService tests use: bun:sqlite exposes the sync query
// API drizzle needs, so we avoid better-sqlite3's Electron-ABI native binding.
function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

interface Captured {
  distinctId: string;
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

// Track every service we spin up so listeners never leak onto the shared `bus`
// across tests (settings.update() fans out to all live AnalyticsService instances).
const live: AnalyticsService[] = [];
function makeService(settings: SettingsService, client: CaptureClient | null): AnalyticsService {
  const svc = new AnalyticsService();
  svc.start({ settings, client });
  live.push(svc);
  return svc;
}
afterEach(async () => {
  while (live.length) await live.pop()?.shutdown();
});

describe("AnalyticsService", () => {
  test("opted out → nothing is captured", () => {
    const settings = new SettingsService(memDb());
    settings.update({ telemetryEnabled: false });
    const fake = new FakeClient();
    const svc = makeService(settings, fake);
    svc.track("host_started");
    expect(fake.events).toHaveLength(0);
  });

  test("no client → no-op (community/source build)", () => {
    const svc = makeService(new SettingsService(memDb()), null);
    svc.track("host_started");
    // Nothing to assert but the absence of a throw; a null client is inert.
    expect(svc.anonymousId).toMatch(/[0-9a-f-]{36}/);
  });

  test("allowlisted event stamps super-props + person properties", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    svc.track("agent_created", { template: "dca", harness: "claude", approval_mode: "auto" });
    expect(fake.events).toHaveLength(1);
    const e = fake.events[0];
    expect(e.event).toBe("agent_created");
    expect(e.distinctId).toBe(svc.anonymousId);
    expect(e.properties).toMatchObject({
      template: "dca",
      approval_mode: "auto",
      platform: process.platform,
      arch: process.arch,
    });
    expect(e.properties?.app_version).toBeDefined();
    // Person profiles must be created: the personless flag would suppress them.
    expect(e.properties).not.toHaveProperty("$process_person_profile");
    // $set/$set_once are stamped AFTER Zod validation, so they are the one channel
    // that bypasses the allowlist. Pin their key sets exactly: a subset match would let
    // a newly added super-prop reach PostHog without anyone reviewing it.
    const set = e.properties?.$set as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual(["app_version", "arch", "platform"]);
    expect(set).toMatchObject({
      app_version: e.properties?.app_version,
      platform: process.platform,
      arch: process.arch,
    });
    // The install's origin via $set_once, which never overwrites.
    const setOnce = e.properties?.$set_once as Record<string, unknown>;
    expect(Object.keys(setOnce).sort()).toEqual(["first_seen_at", "first_seen_version"]);
    expect(setOnce.first_seen_version).toBe(e.properties?.app_version);
    expect(String(setOnce.first_seen_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("an event with an extra prop is dropped whole (no PII leak)", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    // A ticker sneaks in — strict parsing must reject the entire event.
    svc.track("order_gate_prompted", {
      kind: "place",
      asset_type: "equity",
      side: "buy",
      order_type: "market",
      mode: "approve",
      symbol: "AAPL",
    } as never);
    expect(fake.events).toHaveLength(0);
  });

  test("an unknown event name is dropped, not thrown", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    expect(() => svc.track("not_an_event" as never)).not.toThrow();
    expect(fake.events).toHaveLength(0);
  });

  test("distinct id is a stable per-install value across service instances", () => {
    const db = memDb();
    const a = makeService(new SettingsService(db), new FakeClient());
    const b = makeService(new SettingsService(db), new FakeClient());
    expect(a.anonymousId).toBe(b.anonymousId);
    expect(a.anonymousId).toMatch(/[0-9a-f-]{36}/);
  });

  test("toggle off sends exactly one telemetry_disabled, then gates; on re-enables", () => {
    const settings = new SettingsService(memDb());
    const fake = new FakeClient();
    const svc = makeService(settings, fake);

    settings.update({ telemetryEnabled: false });
    expect(fake.events.map((e) => e.event)).toEqual(["telemetry_disabled"]);
    // Gated now: further events are dropped.
    svc.track("host_started");
    expect(fake.events).toHaveLength(1);

    settings.update({ telemetryEnabled: true });
    expect(fake.events.map((e) => e.event)).toEqual(["telemetry_disabled", "telemetry_enabled"]);
    svc.track("host_started");
    expect(fake.events).toHaveLength(3);
  });

  test("a non-telemetry setting change emits setting_changed (value only for enums/bools)", () => {
    const settings = new SettingsService(memDb());
    const fake = new FakeClient();
    makeService(settings, fake);

    settings.update({ defaultApprovalMode: "auto" });
    settings.update({ approvalTimeoutSec: 120 });

    const changes = fake.events.filter((e) => e.event === "setting_changed");
    expect(changes).toHaveLength(2);
    expect(changes[0].properties).toMatchObject({ key: "defaultApprovalMode", value: "auto" });
    // Numeric settings carry no value (only the key).
    expect(changes[1].properties?.key).toBe("approvalTimeoutSec");
    expect(changes[1].properties).not.toHaveProperty("value");
  });

  test("trackError sends only the class name + frames — never the message", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    svc.trackError("broker", new TypeError("secret /Users/alice/holdings AAPL"));
    expect(fake.events).toHaveLength(1);
    const e = fake.events[0];
    expect(e.event).toBe("app_error");
    // Defaults to `caught` when the caller doesn't say how the error surfaced.
    expect(e.properties).toMatchObject({
      subsystem: "broker",
      error_name: "TypeError",
      source: "caught",
    });
    const blob = JSON.stringify(e.properties);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("/Users/");
    expect(blob).not.toContain("AAPL");
  });

  test("trackError records how the error surfaced via source", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    svc.trackError("host", new Error("x"), "unhandled_rejection");
    expect(fake.events[0].properties).toMatchObject({
      subsystem: "host",
      source: "unhandled_rejection",
    });
    // No code on the error → the prop is absent, not null/empty.
    expect(fake.events[0].properties).not.toHaveProperty("error_code");
  });

  test("trackError carries err.code for a Node system error whose stack has no bundle frame", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    // The exact shape of a `listen EADDRINUSE` rejection: plain Error, code set, and a
    // stack made only of node:internal frames — so `frames` is empty and, before
    // error_code, PostHog received nothing that said what went wrong.
    const err = Object.assign(
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:8771"),
      {
        code: "EADDRINUSE",
      },
    );
    err.stack =
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:8771\n" +
      "    at Server.setupListenHandle [as _listen2] (node:net:1940:16)\n" +
      "    at listenInCluster (node:net:1997:12)\n" +
      "    at node:net:2206:7\n" +
      "    at process.processTicksAndRejections (node:internal/process/task_queues:89:21)";
    svc.trackError("host", err, "unhandled_rejection");
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0].properties).toMatchObject({
      subsystem: "host",
      error_name: "Error",
      error_code: "EADDRINUSE",
      source: "unhandled_rejection",
    });
    expect(fake.events[0].properties).not.toHaveProperty("frames");
    expect(JSON.stringify(fake.events[0].properties)).not.toContain("127.0.0.1");
  });

  test("trackError takes a codeOverride for a code errorCodeOf cannot see", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    // An McpError's `code` is numeric (-32603), which the allowlist drops — so the
    // broker resolves it to its enum name and passes that in. Without the override
    // these arrive as a bare class name with nothing saying which failure it was.
    const err = Object.assign(new Error("MCP error -32603: Internal error"), { code: -32603 });
    svc.trackError("broker", err, "caught", "InternalError");
    expect(fake.events[0].properties).toMatchObject({
      subsystem: "broker",
      error_name: "Error",
      error_code: "InternalError",
    });
  });

  test("trackError ignores a codeOverride that isn't allowlist-shaped", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    // An override is re-gated, so a caller can never widen the field — and, since an
    // invalid prop drops the whole event, can never cost us the app_error either.
    svc.trackError("broker", new Error("x"), "caught", "not a code /Users/alice");
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0].properties).not.toHaveProperty("error_code");
  });

  test("trackError prefers a real err.code over an unusable override", () => {
    const fake = new FakeClient();
    const svc = makeService(new SettingsService(memDb()), fake);
    const err = Object.assign(new Error("x"), { code: "ECONNRESET" });
    svc.trackError("broker", err, "caught", undefined);
    expect(fake.events[0].properties).toMatchObject({ error_code: "ECONNRESET" });
  });
});

describe("analytics allowlist + normalizers", () => {
  test("normalizers map raw values, unknown → other", () => {
    expect(sideOf("BUY")).toBe("buy");
    expect(sideOf("sell")).toBe("sell");
    expect(sideOf("weird")).toBe("other");
    expect(sideOf(null)).toBe("other");
    expect(assetTypeOf("mcp__robinhood__place_option_order")).toBe("option");
    expect(assetTypeOf("mcp__robinhood__place_equity_order")).toBe("equity");
    expect(assetTypeOf("something_else")).toBe("other");
    expect(orderTypeOf("LIMIT")).toBe("limit");
    expect(orderTypeOf("stop")).toBe("other");
    expect(orderKindOf("cancel")).toBe("cancel");
    expect(orderKindOf("place")).toBe("place");
    expect(templateOf("momentum")).toBe("momentum");
    expect(templateOf("custom-thing")).toBe("other");
  });

  test("errorNameOf normalizes to a bare identifier", () => {
    expect(errorNameOf(new TypeError("x"))).toBe("TypeError");
    expect(errorNameOf(new Error("y"))).toBe("Error");
    expect(errorNameOf("a string")).toBe("string");
  });

  test("error_name schema rejects anything but an identifier", () => {
    const ok = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "host",
      error_name: "RangeError",
    });
    expect(ok.success).toBe(true);
    const bad = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "host",
      error_name: "has spaces and /paths",
    });
    expect(bad.success).toBe(false);
  });

  test("errorCodeOf takes err.code only when it is already a bare identifier", () => {
    // Node system errors: class is plain `Error`, the code is the whole story.
    const sys = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      code: "EADDRINUSE",
      errno: -48,
      syscall: "listen",
    });
    expect(errorCodeOf(sys)).toBe("EADDRINUSE");
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "ERR_SOCKET_CLOSED" }))).toBe(
      "ERR_SOCKET_CLOSED",
    );
    // No code → undefined (never invents one).
    expect(errorCodeOf(new Error("plain"))).toBeUndefined();
    expect(errorCodeOf(new TypeError("fetch failed"))).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
    expect(errorCodeOf("EADDRINUSE")).toBeUndefined();
    // A code that isn't a bare identifier is dropped whole, not truncated/coerced.
    expect(
      errorCodeOf(Object.assign(new Error("x"), { code: "bad code /Users/a" })),
    ).toBeUndefined();
    expect(errorCodeOf(Object.assign(new Error("x"), { code: "x".repeat(49) }))).toBeUndefined();
    // Numeric codes (DOMException.code) are ignored.
    expect(errorCodeOf(Object.assign(new Error("x"), { code: 18 }))).toBeUndefined();
    // broker_connect_failed carries the same field.
    expect(
      TELEMETRY_EVENTS.broker_connect_failed.safeParse({
        error_name: "OAuthFlowError",
        error_code: "OAUTH_TIMEOUT",
      }).success,
    ).toBe(true);
  });

  test("errorCodeOf falls back to err.cause.code — the undici `fetch failed` shape", () => {
    // What `fetch` throws on a network failure: a bare TypeError with the real code one
    // level down. These are the exact shapes Node 22 produces (probed, not assumed).
    const dns = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND agent.robinhood.com"), {
        code: "ENOTFOUND",
      }),
    });
    expect(errorCodeOf(dns)).toBe("ENOTFOUND");
    // Dual-stack host: the cause is an AggregateError that Node also stamps with the code.
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError([], "connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(errorCodeOf(refused)).toBe("ECONNREFUSED");
    // Own code wins over the cause's; a cause with no code adds nothing; one level only.
    expect(
      errorCodeOf(Object.assign(new Error("x"), { code: "OWN", cause: { code: "INNER" } })),
    ).toBe("OWN");
    expect(
      errorCodeOf(new TypeError("fetch failed", { cause: new Error("bad port") })),
    ).toBeUndefined();
    expect(
      errorCodeOf(new Error("x", { cause: new Error("y", { cause: { code: "DEEP" } }) })),
    ).toBeUndefined();
    // The same sanitization applies to the cause's code.
    expect(
      errorCodeOf(new Error("x", { cause: { code: "not an identifier /path" } })),
    ).toBeUndefined();
  });

  test("app_error source accepts the enum and rejects free text", () => {
    const ok = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "renderer",
      error_name: "NotAllowedError",
      source: "unhandled_rejection",
    });
    expect(ok.success).toBe(true);
    const bad = TELEMETRY_EVENTS.app_error.safeParse({
      subsystem: "renderer",
      error_name: "NotAllowedError",
      source: "Document is not focused",
    });
    expect(bad.success).toBe(false);
  });

  test("RendererTrackInput rejects host-only events and non-renderer errors", () => {
    expect(RendererTrackInput.safeParse({ event: "host_started" }).success).toBe(false);
    expect(
      RendererTrackInput.safeParse({
        event: "onboarding_step_completed",
        props: { step: "broker" },
      }).success,
    ).toBe(true);
    // app_error on the tRPC surface is restricted to the GUI-process subsystems
    // (renderer + updater); a host-only subsystem is rejected.
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: { subsystem: "host", error_name: "X" },
      }).success,
    ).toBe(false);
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: { subsystem: "renderer", error_name: "X" },
      }).success,
    ).toBe(true);
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: { subsystem: "updater", error_name: "X", source: "caught" },
      }).success,
    ).toBe(true);
  });

  test("RendererTrackInput carries a bounded error_code but not a message", () => {
    // The updater relay's reason for existing: a bare `Error` plus its machine code.
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: {
          subsystem: "updater",
          error_name: "Error",
          error_code: "ENOTFOUND",
          source: "caught",
        },
      }).success,
    ).toBe(true);
    // A `code` holding free text fails the same regex the host path uses, so the tRPC
    // surface can't be used to smuggle a message through the field.
    expect(
      RendererTrackInput.safeParse({
        event: "app_error",
        props: {
          subsystem: "updater",
          error_name: "Error",
          error_code: "Cannot parse releases feed: /Users/a/Library",
        },
      }).success,
    ).toBe(false);
  });

  test("sanitizeStack keeps bundle + dependency frames, drops node internals", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at foo (/Users/a/out/main/host.js:41231:17)",
      "    at task (node:internal/process/task_queues:95:5)",
      "    at ws (/Users/a/node_modules/ws/lib/index.js:10:2)",
      "    at main (/Users/a/out/main/index.js:5:9)",
    ].join("\n");
    expect(sanitizeStack(err)).toEqual(["host.js:41231:17", "ws/index.js:10:2", "index.js:5:9"]);
  });

  test("sanitizeStack labels a dependency frame with its package, scope included", () => {
    // The shape that made every backend app_error frameless: the whole stack sits in
    // the MCP SDK, so dropping node_modules frames left nothing at all.
    const err = new Error("boom");
    err.stack = [
      "McpError: MCP error -32603",
      "    at Client._onresponse (/Applications/OpenTrade.app/Contents/Resources/app.asar/node_modules/@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js:301:31)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");
    expect(sanitizeStack(err)).toEqual(["@modelcontextprotocol/sdk/protocol.js:301:31"]);
  });

  test("sanitizeStack resolves a nested dependency to the package that owns the frame", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at f (/Users/a/node_modules/.bun/ws@8/node_modules/ws/lib/sender.js:7:3)",
    ].join("\n");
    expect(sanitizeStack(err)).toEqual(["ws/sender.js:7:3"]);
  });

  test("sanitizeStack frames carry no directory, and stay inside the allowlist shape", () => {
    // The privacy guarantee: whatever the user's install path, only a package name and
    // a basename survive — so a home directory can never ride along in `frames`.
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at a (/Users/somebody/secret-dir/out/main/host.js:1:2)",
      "    at b (/Users/somebody/secret-dir/node_modules/@scope/pkg/deep/nested/file.js:3:4)",
    ].join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toEqual(["host.js:1:2", "@scope/pkg/file.js:3:4"]);
    for (const f of frames) expect(f).not.toContain("somebody");
    // Must survive the strict allowlist — a frame that fails it drops the whole event.
    expect(
      TELEMETRY_EVENTS.app_error.safeParse({
        subsystem: "broker",
        error_name: "McpError",
        frames,
      }).success,
    ).toBe(true);
  });

  test("sanitizeStack does not treat a directory merely ending in node_modules as one", () => {
    // `indexOf("node_modules/")` without a path boundary would publish the user's own
    // next directory as if it were a package name.
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at f (/Users/alice/my-node_modules/Acme-Client-Trades/lib/x.js:1:2)",
    ].join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toEqual(["x.js:1:2"]);
    expect(JSON.stringify(frames)).not.toContain("Acme");
  });

  test("sanitizeStack ignores the message line, which is free text", () => {
    // The `<Class>: <message>` line is server-influenceable (an McpError's message), so
    // mining it for a `file.js:line` would turn message text into telemetry.
    const err = new Error("boom");
    err.stack = [
      "Error: request to /srv/node_modules/AAPL-strategy/buy-500-shares.js:42 failed",
      "    at g (/app/out/main/main.js:1:1)",
    ].join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toEqual(["main.js:1:1"]);
    expect(JSON.stringify(frames)).not.toContain("AAPL");
  });

  test("sanitizeStack rejects traversal segments as package names", () => {
    const err = new Error("boom");
    err.stack = ["Error: boom", "    at f (/a/node_modules/../../../Users/alice/x.js:9:9)"].join(
      "\n",
    );
    expect(sanitizeStack(err)).toEqual(["x.js:9:9"]);
  });

  test("sanitizeStack labels dependency frames on Windows paths too", () => {
    const err = new Error("boom");
    err.stack = ["Error: boom", "    at f (C:\\p\\node_modules\\ws\\lib\\index.js:10:2)"].join(
      "\n",
    );
    expect(sanitizeStack(err)).toEqual(["ws/index.js:10:2"]);
  });

  test("one over-long frame is shed, never allowed to drop the whole event", () => {
    // frames are `.max(128)`; a frame past it fails validation, and an invalid prop
    // drops the entire app_error — so the length has to be enforced while building.
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      `    at f (/app/out/${"a".repeat(200)}.js:1:1)`,
      "    at g (/app/out/main.js:2:2)",
    ].join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toEqual(["main.js:2:2"]);
    expect(
      TELEMETRY_EVENTS.app_error.safeParse({
        subsystem: "broker",
        error_name: "Error",
        frames,
      }).success,
    ).toBe(true);
  });

  test("sanitizeStack caps at 10 frames", () => {
    const lines = ["Error: boom"];
    for (let i = 0; i < 15; i++) lines.push(`    at fn (/x/out/host.js:${i}:1)`);
    const err = new Error("boom");
    err.stack = lines.join("\n");
    const frames = sanitizeStack(err);
    expect(frames).toHaveLength(10);
    for (const f of frames) expect(f).toMatch(/^[\w.-]+\.js:\d+(:\d+)?$/);
  });
});
