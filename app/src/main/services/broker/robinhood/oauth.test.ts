import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../../db/client";
import * as schema from "../../../db/schema";
import { analytics } from "../../analytics";
import { BrokerOAuthProvider, ConsentRequired } from "./oauth";

function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

// Spy on the singleton rather than starting it with a fake client: `start` is idempotent,
// so in a full-suite run whichever file starts it first owns it and a second fake client
// would silently receive nothing. The spy asserts the call this file is about.
let tracked: ReturnType<typeof spyOn<typeof analytics, "track">>;
beforeEach(() => {
  tracked = spyOn(analytics, "track").mockImplementation(() => {});
});
afterEach(() => {
  tracked.mockRestore();
});

function provider() {
  const opened: string[] = [];
  const p = new BrokerOAuthProvider({ db: memDb(), openBrowser: (u) => opened.push(u) });
  return { p, opened };
}

const TOKENS = { access_token: "a", token_type: "bearer", refresh_token: "r" };

describe("BrokerOAuthProvider", () => {
  test("beginAuthorization adopts the loopback URL and drops the stale registration", () => {
    const { p } = provider();
    p.saveClientInformation({ client_id: "old" });
    p.saveCodeVerifier("v-old");
    p.saveTokens(TOKENS);
    p.beginAuthorization("http://127.0.0.1:50123/callback");
    // What the SDK reads: registration metadata + auth request + code exchange all
    // agree on the freshly bound URL, and there's no client to reuse → re-register.
    expect(p.redirectUrl).toBe("http://127.0.0.1:50123/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:50123/callback"]);
    expect(p.clientInformation()).toBeUndefined();
    expect(() => p.codeVerifier()).toThrow();
    // Tokens are left alone — dropping them is the adapter's call.
    expect(p.hasTokens()).toBe(true);
  });

  test("outside a consent, redirectUrl is still a truthy string (SDK: not a non-interactive grant)", () => {
    const { p } = provider();
    expect(p.redirectUrl).toBeTruthy();
    p.beginAuthorization("http://127.0.0.1:50123/callback");
    p.endAuthorization();
    expect(p.redirectUrl).toBeTruthy();
    expect(p.redirectUrl).not.toBe("http://127.0.0.1:50123/callback");
  });

  test("the browser gate: silent throws ConsentRequired; inside a consent it opens", () => {
    const { p, opened } = provider();
    expect(() => p.redirectToAuthorization(new URL("https://robinhood.com/oauth"))).toThrow(
      ConsentRequired,
    );
    expect(opened).toEqual([]);

    p.beginAuthorization("http://127.0.0.1:50123/callback");
    p.redirectToAuthorization(new URL("https://robinhood.com/oauth?x=1"));
    expect(opened).toEqual(["https://robinhood.com/oauth?x=1"]);

    p.endAuthorization();
    expect(() => p.redirectToAuthorization(new URL("https://x"))).toThrow(ConsentRequired);
    expect(opened).toHaveLength(1);
  });

  test("opening the browser reports broker_consent_opened with the budget already spent", () => {
    const { p, opened } = provider();
    p.beginAuthorization("http://127.0.0.1:50123/callback");
    p.redirectToAuthorization(new URL("https://robinhood.com/oauth"));

    expect(opened).toHaveLength(1);
    const calls = tracked.mock.calls.filter(([event]) => event === "broker_consent_opened");
    expect(calls).toHaveLength(1);
    // How much of the consent timeout was gone before the user could act. Bounded by the
    // test's own runtime, so assert the shape the allowlist requires, not a value.
    const armed = (calls[0][1] as { armed_ms: number }).armed_ms;
    expect(Number.isInteger(armed)).toBe(true);
    expect(armed).toBeGreaterThanOrEqual(0);
  });

  test("a browser that never opened reports nothing — that's the case the event separates", () => {
    const { p } = provider();
    // Silent connect: the gate throws before `openBrowser`, so an OAUTH_TIMEOUT with no
    // `broker_consent_opened` means the user was never shown a page.
    expect(() => p.redirectToAuthorization(new URL("https://robinhood.com/oauth"))).toThrow(
      ConsentRequired,
    );
    expect(tracked.mock.calls.filter(([e]) => e === "broker_consent_opened")).toHaveLength(0);
  });
});
