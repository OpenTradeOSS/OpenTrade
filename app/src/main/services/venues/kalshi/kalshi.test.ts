import { describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import type { PreToolUseDecision } from "@shared/approval";
import { parseOrderInput } from "../../approvals/parse";
import { parseKalshiOrderInput } from "../../approvals/parse-kalshi";
import { KalshiClient, parseKalshiKey, signKalshi } from "./client";
import { KalshiService } from "./index";
import { buildKalshiRequest, KalshiInputError, placeOrderBody } from "./requests";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PEM = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("placeOrderBody — agent (action, outcome, price) → Kalshi V2 single book", () => {
  const base = { ticker: "KXFED-25DEC-T4.25", count: 10 };
  test.each([
    ["buy", "yes", 0.42, "bid", "0.4200"],
    ["sell", "yes", 0.42, "ask", "0.4200"],
    ["buy", "no", 0.3, "ask", "0.7000"],
    ["sell", "no", 0.3, "bid", "0.7000"],
  ])("%s %s @ %p → %s @ %s", (action, outcome, price, side, yesPrice) => {
    const body = placeOrderBody({ ...base, action, outcome, price });
    expect(body.side).toBe(side);
    expect(body.price).toBe(yesPrice);
    expect(body.count).toBe("10.00");
    expect(body.time_in_force).toBe("good_till_canceled");
    expect(body.self_trade_prevention_type).toBe("taker_at_cross");
  });

  test("rejects out-of-range prices and bad counts before any card", () => {
    expect(() => placeOrderBody({ ...base, action: "buy", outcome: "yes", price: 1 })).toThrow(
      KalshiInputError,
    );
    expect(() =>
      placeOrderBody({ ...base, action: "buy", outcome: "yes", price: 0.5, count: 0 }),
    ).toThrow(KalshiInputError);
    expect(() => placeOrderBody({ ...base, action: "hold", outcome: "yes", price: 0.5 })).toThrow(
      KalshiInputError,
    );
  });
});

describe("buildKalshiRequest", () => {
  test("reads map to REST paths with only the known query params", () => {
    expect(buildKalshiRequest("get_markets", { event_ticker: "E", limit: 5, junk: "x" })).toEqual({
      method: "GET",
      path: "/markets",
      query: { event_ticker: "E", limit: "5" },
    });
  });

  test("path ids are URL-encoded (no path rewriting)", () => {
    expect(buildKalshiRequest("get_order", { order_id: "../balance" }).path).toBe(
      "/portfolio/orders/..%2Fbalance",
    );
  });

  test("cancel routes by market ticker", () => {
    expect(buildKalshiRequest("cancel_order", { order_id: "o1", ticker: "T" })).toEqual({
      method: "DELETE",
      path: "/portfolio/events/orders/o1",
      query: { market_ticker: "T" },
    });
  });
});

describe("signKalshi", () => {
  test("RSA-PSS/SHA-256 over ts+METHOD+path verifies with the public key", () => {
    const key = parseKalshiKey(RSA_PEM);
    const sig = signKalshi(key, "1700000000000", "GET", "/trade-api/v2/portfolio/balance");
    const ok = verify(
      "sha256",
      Buffer.from("1700000000000GET/trade-api/v2/portfolio/balance"),
      {
        key: rsa.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(true);
  });

  test("Ed25519 keys are supported", () => {
    const ed = generateKeyPairSync("ed25519");
    const pem = ed.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sig = signKalshi(parseKalshiKey(pem), "1", "POST", "/p");
    expect(verify(null, Buffer.from("1POST/p"), ed.publicKey, Buffer.from(sig, "base64"))).toBe(
      true,
    );
  });

  test("a malformed key is a readable error", () => {
    expect(() => parseKalshiKey("not a key")).toThrow(/private key/);
  });

  test("client signs the path without the query string", async () => {
    const seen = { url: "", headers: {} as Record<string, string> };
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      seen.url = String(url);
      seen.headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ balance: 1234 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new KalshiClient(
      { keyId: "kid", privateKeyPem: RSA_PEM, env: "demo" },
      fakeFetch,
    );
    await client.send({ method: "GET", path: "/markets", query: { limit: "1" } });
    expect(seen.url).toBe("https://demo-api.kalshi.co/trade-api/v2/markets?limit=1");
    const h = seen.headers;
    const ok = verify(
      "sha256",
      Buffer.from(`${h["KALSHI-ACCESS-TIMESTAMP"]}GET/trade-api/v2/markets`),
      {
        key: rsa.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64"),
    );
    expect(h["KALSHI-ACCESS-KEY"]).toBe("kid");
    expect(ok).toBe(true);
  });
});

describe("Kalshi approval cards", () => {
  test("place: exact summary + est. cost", () => {
    const p = parseOrderInput("mcp__kalshi__place_order", {
      ticker: "kxfed-25dec-t4.25",
      action: "buy",
      outcome: "no",
      count: 10,
      price: 0.3,
    });
    expect(p.kind).toBe("place");
    expect(p.symbol).toBe("KXFED-25DEC-T4.25");
    expect(p.estCost).toBe(3);
    expect(p.summary).toBe("Kalshi BUY 10 NO KXFED-25DEC-T4.25 @ $0.30 — max cost $3.00");
  });

  test("cancel carries the order id", () => {
    const p = parseKalshiOrderInput("mcp__kalshi__cancel_order", { order_id: "o1", ticker: "t" });
    expect(p).toMatchObject({ kind: "cancel", cancelsOrderId: "o1", symbol: "T" });
  });
});

describe("KalshiService — server-side gate", () => {
  const allow: PreToolUseDecision = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  };
  const deny: PreToolUseDecision = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "too big",
    },
  };

  function harness(decision: PreToolUseDecision, creds = true) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const outcomes: unknown[] = [];
    const requests: unknown[] = [];
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      calls.push({
        method: String(init.method),
        url: String(url),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ order_id: "ord-1", fill_count: "0.00" }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    const vault = {
      kalshiCredentials: () =>
        creds ? { keyId: "k", privateKeyPem: RSA_PEM, env: "prod" as const } : null,
    };
    const approvals = {
      request: async (a: unknown) => {
        requests.push(a);
        return decision;
      },
      recordOutcome: (o: unknown) => outcomes.push(o),
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural test doubles
    const svc = new KalshiService(vault as any, approvals as any, fakeFetch);
    return { svc, calls, outcomes, requests };
  }

  const order = { ticker: "T", action: "buy", outcome: "yes", count: 2, price: 0.5 };

  test("a declined order never reaches Kalshi", async () => {
    const h = harness(deny);
    const r = await h.svc.call("a1", "place_order", order);
    expect(r).toEqual({ ok: false, error: "too big" });
    expect(h.calls).toHaveLength(0);
    expect(h.requests[0]).toMatchObject({ agentId: "a1", toolName: "mcp__kalshi__place_order" });
  });

  test("an approved order is sent once with a client_order_id, and its outcome recorded", async () => {
    const h = harness(allow);
    const r = await h.svc.call("a1", "place_order", order);
    expect(r.ok).toBe(true);
    // Exactly one order is sent (the GETs after it are the account-view refresh).
    const posts = h.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(h.calls[0].method).toBe("POST");
    expect(h.calls[0].url).toBe(
      "https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders",
    );
    expect((posts[0].body as { client_order_id?: string }).client_order_id).toBeString();
    expect(h.outcomes[0]).toMatchObject({ toolName: "mcp__kalshi__place_order", rawInput: order });
  });

  test("reads skip the gate", async () => {
    const h = harness(deny);
    const r = await h.svc.call("a1", "get_balance", {});
    expect(r.ok).toBe(true);
    expect(h.requests).toHaveLength(0);
  });

  test("invalid input fails without raising a card", async () => {
    const h = harness(allow);
    const r = await h.svc.call("a1", "place_order", { ...order, price: 5 });
    expect(r.ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  test("no credentials → a clear error, nothing sent", async () => {
    const h = harness(allow, false);
    const r = await h.svc.call("a1", "get_balance", {});
    expect(r.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});
