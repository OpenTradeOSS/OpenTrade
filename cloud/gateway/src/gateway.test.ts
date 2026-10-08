import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Accounts } from "./accounts";
import { Sealer } from "./crypto";
import { openDb } from "./db";
import { sseMeter, type usageFrom } from "./llm";
import { listCostMicros, MICROS_PER_CREDIT, SIGNUP_CREDITS } from "./plans";
import { Billing } from "./stripe";

async function pump(
  stream: TransformStream<Uint8Array, Uint8Array>,
  chunks: string[],
): Promise<string> {
  const writer = stream.writable.getWriter();
  const out = new Response(stream.readable).text();
  const enc = new TextEncoder();
  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  return out;
}

describe("metering", () => {
  test("anthropic SSE: input+cache from message_start, output from the last message_delta", async () => {
    const seen: Array<[string, ReturnType<typeof usageFrom>]> = [];
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
      // split across chunks mid-event
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_',
      'tokens":250}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const text = await pump(
      sseMeter("anthropic", (m, u) => seen.push([m, u])),
      body,
    );
    expect(text).toBe(body.join("")); // passthrough is byte-identical
    expect(seen).toEqual([
      ["claude-sonnet-4-5", { input: 12, output: 250, cacheRead: 2000, cacheWrite: 100 }],
    ]);
  });

  test("openai Responses SSE: usage from response.completed, cached tokens split out", async () => {
    const seen: Array<[string, ReturnType<typeof usageFrom>]> = [];
    await pump(
      sseMeter("openai", (m, u) => seen.push([m, u])),
      [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":600},"output_tokens":40}}}\n\n',
      ],
    );
    expect(seen).toEqual([
      ["gpt-5-codex", { input: 400, output: 40, cacheRead: 600, cacheWrite: 0 }],
    ]);
  });

  test("a stream with no usage records nothing", async () => {
    let called = false;
    await pump(
      sseMeter("anthropic", () => (called = true)),
      ['data: {"type":"ping"}\n\n'],
    );
    expect(called).toBe(false);
  });

  test("prices: sonnet list cost, unknown model billed at the top tier", () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    expect(listCostMicros("anthropic", "claude-sonnet-4-5", u)).toBe(18_000_000);
    expect(listCostMicros("anthropic", "claude-mystery-9", u)).toBe(90_000_000);
    expect(listCostMicros("anthropic", "claude-haiku-4-5-20251001", u)).toBe(6_000_000);
  });
});

describe("accounts and credits", () => {
  test("signup grants starter credits once; a repeated ledger ref is ignored", async () => {
    const accounts = new Accounts(openDb(":memory:"));
    const u = await accounts.signup("A@Example.com", "long-enough-password");
    expect(u.email).toBe("a@example.com");
    expect(accounts.balanceMicros(u.id)).toBe(SIGNUP_CREDITS * MICROS_PER_CREDIT);
    expect(accounts.credit(u.id, 500, "pack", "evt_1")).toBe(true);
    expect(accounts.credit(u.id, 500, "pack", "evt_1")).toBe(false);
    expect(accounts.balanceMicros(u.id)).toBe(SIGNUP_CREDITS * MICROS_PER_CREDIT + 500);
  });

  test("login rejects a wrong password and an unknown email the same way", async () => {
    const accounts = new Accounts(openDb(":memory:"));
    await accounts.signup("b@example.com", "long-enough-password");
    await expect(accounts.login("b@example.com", "nope")).rejects.toThrow(
      "Wrong email or password.",
    );
    await expect(accounts.login("nobody@example.com", "nope")).rejects.toThrow(
      "Wrong email or password.",
    );
    expect((await accounts.login("B@example.com", "long-enough-password")).email).toBe(
      "b@example.com",
    );
  });

  test("sessions resolve to their user and end on logout", async () => {
    const accounts = new Accounts(openDb(":memory:"));
    const u = await accounts.signup("c@example.com", "long-enough-password");
    const t = accounts.createSession(u.id, "mobile");
    expect(accounts.userForSession(t)?.id).toBe(u.id);
    accounts.endSession(t);
    expect(accounts.userForSession(t)).toBeNull();
  });
});

describe("secrets", () => {
  test("sealed values round-trip and tampering is detected", () => {
    const s = new Sealer("11".repeat(32));
    const sealed = s.seal("sk-ant-secret");
    expect(sealed).not.toContain("secret");
    expect(s.open(sealed)).toBe("sk-ant-secret");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("x").toString("base64url");
    expect(() => s.open(parts.join("."))).toThrow();
  });
});

describe("stripe webhooks", () => {
  const db = openDb(":memory:");
  const accounts = new Accounts(db);
  const billing = new Billing("sk_test_x", "whsec_test", db, accounts, "https://app.test");
  const sign = (payload: string, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex")}`;

  test("rejects a bad or stale signature", async () => {
    const payload = JSON.stringify({ id: "evt_x", type: "ping", data: { object: {} } });
    expect((await billing.webhook(payload, "t=1,v1=00")).status).toBe(400);
    expect((await billing.webhook(payload, sign(payload, 1000))).status).toBe(400);
  });

  test("a paid credit-pack checkout grants credits exactly once", async () => {
    const u = await accounts.signup("d@example.com", "long-enough-password");
    const before = accounts.balanceMicros(u.id);
    const payload = JSON.stringify({
      id: "evt_pack",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "payment",
          payment_status: "paid",
          client_reference_id: u.id,
          metadata: { user_id: u.id, item: "credits_1000" },
        },
      },
    });
    expect((await billing.webhook(payload, sign(payload))).status).toBe(200);
    expect((await billing.webhook(payload, sign(payload))).body).toBe("duplicate");
    expect(accounts.balanceMicros(u.id) - before).toBe(1000 * MICROS_PER_CREDIT);
  });

  test("a paid subscription invoice sets the plan and grants its monthly credits", async () => {
    const u = await accounts.signup("e@example.com", "long-enough-password");
    accounts.update(u.id, { stripe_customer_id: "cus_e" });
    const before = accounts.balanceMicros(u.id);
    const payload = JSON.stringify({
      id: "evt_inv",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          customer: "cus_e",
          parent: { subscription_details: { metadata: { plan: "pro", user_id: u.id } } },
          lines: { data: [{ period: { end: 1_900_000_000 } }] },
        },
      },
    });
    expect((await billing.webhook(payload, sign(payload))).status).toBe(200);
    expect(accounts.byId(u.id)?.plan).toBe("pro");
    expect(accounts.balanceMicros(u.id) - before).toBe(2000 * MICROS_PER_CREDIT);
  });
});
