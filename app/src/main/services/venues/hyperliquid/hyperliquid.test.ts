import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PreToolUseDecision } from "@shared/approval";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { generatePrivateKey } from "viem/accounts";
import type { Db } from "../../../db/client";
import { SCHEMA_DDL } from "../../../db/ddl";
import * as schema from "../../../db/schema";
import { parseOrderInput, parseOrderResult } from "../../approvals/parse";
import { VaultService } from "../../vault";
import { addressOf, type HyperliquidApi, normalizePrivateKey, type OrderWire } from "./client";
import { HyperliquidService } from "./index";
import { mapBalances, mapOrders, mapPortfolio, mapPositions } from "./portfolio";
import {
  buildOrder,
  buildProtection,
  dexOf,
  HyperliquidInputError,
  type MarketRef,
} from "./requests";

const BTC: MarketRef = { symbol: "BTC", asset: 0, szDecimals: 5, kind: "perp", mid: 80_000 };
const HYPE: MarketRef = { symbol: "HYPE/USDC", asset: 10107, szDecimals: 2, kind: "spot", mid: 90 };

describe("buildOrder", () => {
  test("limit: rounds to lot size and 5 significant figures, no trailing zeros", () => {
    const o = buildOrder({ side: "buy", size: 0.001234567, price: 50000.123 }, BTC);
    expect(o).toEqual({
      a: 0,
      b: true,
      p: "50000",
      s: "0.00123",
      r: false,
      t: { limit: { tif: "Gtc" } },
    });
    expect(
      buildOrder({ side: "sell", size: 1, price: 90.5, time_in_force: "alo" }, HYPE),
    ).toMatchObject({ a: 10107, b: false, p: "90.5", s: "1", t: { limit: { tif: "Alo" } } });
  });

  test("market: IOC priced through the mid by the slippage cap", () => {
    expect(buildOrder({ side: "buy", size: 0.001, order_type: "market" }, BTC)).toMatchObject({
      p: "82400",
      t: { limit: { tif: "Ioc" } },
    });
    expect(
      buildOrder({ side: "sell", size: 0.001, order_type: "market", slippage: 0.01 }, BTC).p,
    ).toBe("79200");
  });

  test("trigger: a stop-market that only reduces", () => {
    const o = buildOrder(
      {
        side: "sell",
        size: 0.001,
        order_type: "market",
        trigger_price: 75_000,
        trigger_kind: "sl",
        reduce_only: true,
      },
      BTC,
    );
    expect(o.r).toBe(true);
    expect(o.t).toEqual({ trigger: { isMarket: true, triggerPx: "75000", tpsl: "sl" } });
    expect(o.p).toBe("72750");
  });

  test("rejects what the venue would: tiny value, missing price, no mid, bad enums", () => {
    const bad = (args: Record<string, unknown>, m = BTC) =>
      expect(() => buildOrder(args, m)).toThrow(HyperliquidInputError);
    bad({ side: "buy", size: 0.0001, price: 50_000 }); // $5
    bad({ side: "buy", size: 0.001 }); // limit without a price
    bad({ side: "hold", size: 1, price: 1 });
    bad({ side: "buy", size: 0.001, order_type: "market" }, { ...BTC, mid: null });
    bad({ side: "buy", size: 0.001, order_type: "market", slippage: 3 });
    bad({ side: "buy", size: 0.001, price: 80_000, time_in_force: "fok" });
    bad({ side: "sell", size: 1, price: 90, reduce_only: true }, HYPE);
    bad({ side: "sell", size: 0.001, price: 80_000, trigger_price: 75_000 });
    bad({ side: "buy", size: 0.000001, price: 80_000_000 }); // rounds to zero size
  });

  test("a reduce-only order may be under the $10 minimum", () => {
    expect(
      buildOrder({ side: "sell", size: 0.0001, price: 80_000, reduce_only: true }, BTC).s,
    ).toBe("0.0001");
  });

  test("attached stop-loss / take-profit: reduce-only market triggers sized to the entry", () => {
    const args = {
      side: "buy",
      size: 0.001,
      price: 80_000,
      stop_loss: 76_000,
      take_profit: 90_000,
    };
    const kids = buildProtection(args, BTC, buildOrder(args, BTC));
    expect(kids).toEqual([
      {
        a: 0,
        b: false,
        p: "87300",
        s: "0.001",
        r: true,
        t: { trigger: { isMarket: true, triggerPx: "90000", tpsl: "tp" } },
      },
      {
        a: 0,
        b: false,
        p: "73720",
        s: "0.001",
        r: true,
        t: { trigger: { isMarket: true, triggerPx: "76000", tpsl: "sl" } },
      },
    ]);
    expect(buildProtection({ side: "buy", size: 0.001, price: 80_000 }, BTC, kids[0])).toEqual([]);
  });

  test("a stop on the wrong side of the entry (it would fire at once) is refused", () => {
    const bad = (args: Record<string, unknown>, m = BTC) =>
      expect(() => buildProtection(args, m, buildOrder(args, m))).toThrow(HyperliquidInputError);
    bad({ side: "buy", size: 0.001, price: 80_000, stop_loss: 81_000 });
    bad({ side: "sell", size: 0.001, price: 80_000, stop_loss: 79_000 });
    bad({ side: "buy", size: 0.001, order_type: "market", take_profit: 79_000 });
    bad({ side: "buy", size: 1, price: 90, stop_loss: 80 }, HYPE); // spot
  });

  test("dexOf", () => {
    expect(dexOf("xyz:TSLA")).toBe("xyz");
    expect(dexOf("BTC")).toBeUndefined();
  });
});

describe("approval cards", () => {
  test("limit and market orders", () => {
    expect(
      parseOrderInput("mcp__hyperliquid__place_order", {
        symbol: "BTC",
        side: "buy",
        size: 0.01,
        price: 80_000,
        ref_price: 80_100,
      }),
    ).toMatchObject({
      kind: "place",
      symbol: "BTC",
      side: "buy",
      quantity: 0.01,
      orderType: "limit",
      limitPrice: 80_000,
      estCost: 800,
      assetType: "crypto",
      summary: "Hyperliquid BUY 0.01 BTC @ $80,000.00 — $800.00 notional",
    });
    expect(
      parseOrderInput("mcp__hyperliquid__place_order", {
        symbol: "USOL/USDC",
        side: "sell",
        size: 0.1,
        order_type: "market",
        ref_price: 118.3,
      }),
    ).toMatchObject({ orderType: "market", limitPrice: null, estCost: 11.83 });
  });

  test("an entry shows its stop-loss; a stop order is typed as one", () => {
    const entry = parseOrderInput("mcp__hyperliquid__place_order", {
      symbol: "BTC",
      side: "buy",
      size: 0.01,
      price: 80_000,
      stop_loss: 76_000,
      take_profit: 90_000,
    });
    expect(entry).toMatchObject({ orderType: "limit", stopPrice: 76_000, takeProfitPrice: 90_000 });
    expect(entry.summary).toContain("· stop-loss $76,000.00 · take-profit $90,000.00");
    expect(
      parseOrderInput("mcp__hyperliquid__place_order", {
        symbol: "BTC",
        side: "sell",
        size: 0.01,
        order_type: "market",
        trigger_price: 76_000,
        trigger_kind: "sl",
        reduce_only: true,
      }),
    ).toMatchObject({ orderType: "stop_market", stopPrice: 76_000, side: "sell" });
  });

  test("close, cancel, leverage", () => {
    const close = parseOrderInput("mcp__hyperliquid__close_position", {
      symbol: "ETH",
      side: "sell",
      size: 0.5,
      order_type: "market",
      reduce_only: true,
      ref_price: 2000,
    });
    expect(close).toMatchObject({ kind: "place", side: "sell", estCost: 1000 });
    expect(close.summary).toStartWith("Hyperliquid CLOSE (sell) 0.5 ETH @ market");
    expect(
      parseOrderInput("mcp__hyperliquid__cancel_order", { symbol: "BTC", order_id: 77 }),
    ).toMatchObject({ kind: "cancel", cancelsOrderId: "77" });
    expect(
      parseOrderInput("mcp__hyperliquid__set_leverage", { symbol: "BTC", leverage: 5 }).summary,
    ).toBe("Hyperliquid: set BTC leverage to 5x cross");
  });
});

describe("portfolio mappers", () => {
  const state = {
    marginSummary: { accountValue: "1200.5" },
    withdrawable: "700",
    assetPositions: [
      {
        position: {
          coin: "ETH",
          szi: "-0.5",
          entryPx: "2100",
          positionValue: "1000",
          unrealizedPnl: "50",
          marginUsed: "200",
          leverage: { type: "cross", value: 5 },
          liquidationPx: "2600",
        },
      },
    ],
  };
  const spot = {
    balances: [
      { coin: "USDC", total: "100", hold: "40", entryNtl: "0" },
      { coin: "USOL", total: "0.5", hold: "0", entryNtl: "55" },
      { coin: "DUST", total: "0.0", hold: "0", entryNtl: "0" },
      { coin: "UETH", total: "0.0001", hold: "0", entryNtl: "0.2" },
    ],
  };
  const positions = mapPositions(state, { ETH: "2000" });
  const balances = mapBalances(spot, (c) => (c === "USOL" ? 120 : c === "UETH" ? 2000 : null));

  test("positions and balances", () => {
    expect(positions).toEqual([
      {
        symbol: "ETH",
        side: "short",
        size: 0.5,
        entryPrice: 2100,
        markPrice: 2000,
        positionValue: 1000,
        unrealizedPnl: 50,
        marginUsed: 200,
        leverage: 5,
        liquidationPrice: 2600,
      },
    ]);
    expect(balances.map((b) => [b.coin, b.value, b.cost])).toEqual([
      ["USDC", 100, null],
      ["USOL", 60, 55],
    ]);
  });

  test("default mode: perp ledger + spot; unified: spot is the collateral", () => {
    expect(mapPortfolio([state], positions, balances, "default", 1)).toMatchObject({
      equity: 1360.5,
      withdrawable: 700,
      unrealizedPnl: 50,
    });
    expect(mapPortfolio([state], positions, balances, "unifiedAccount", 1)).toMatchObject({
      equity: 160,
      withdrawable: 60,
    });
  });

  test("orders join fills for average price and fees", () => {
    const orders = mapOrders(
      [
        {
          order: {
            coin: "@107",
            side: "B",
            limitPx: "90",
            origSz: "2",
            oid: 5,
            timestamp: 1,
            orderType: "Limit",
          },
          status: "filled",
          statusTimestamp: 2,
        },
        {
          order: { coin: "@107", side: "B", limitPx: "90", origSz: "2", oid: 5, timestamp: 1 },
          status: "open",
        },
        {
          order: { coin: "BTC", side: "A", limitPx: "90000", origSz: "1", oid: 6, timestamp: 3 },
          status: "canceled",
        },
      ],
      [
        { oid: 5, px: "89", sz: "1", fee: "0.03" },
        { oid: 5, px: "91", sz: "1", fee: "0.03" },
      ],
      (c) => (c === "@107" ? "HYPE/USDC" : c),
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      id: "5",
      symbol: "HYPE/USDC",
      side: "buy",
      state: "filled",
      cumulativeQuantity: 2,
      avgPrice: 90,
      fees: 0.06,
    });
    expect(orders[1]).toMatchObject({ id: "6", side: "sell", state: "cancelled" });
    expect(orders[0].trigger).toBeUndefined();
  });

  test("a trigger order carries its kind and price", () => {
    const [stop] = mapOrders(
      [
        {
          order: {
            coin: "BTC",
            side: "A",
            limitPx: "73720",
            origSz: "0.001",
            oid: 9,
            timestamp: 5,
            orderType: "Stop Market",
            isTrigger: true,
            triggerPx: "76000",
            reduceOnly: true,
          },
          status: "filled",
        },
      ],
      [{ oid: 9, px: "75990", sz: "0.001", fee: "0.03" }],
      (c) => c,
    );
    expect(stop).toMatchObject({
      state: "filled",
      side: "sell",
      limitPrice: null,
      trigger: { kind: "sl", price: 76_000 },
      reduceOnly: true,
    });
  });
});

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

const KEY = generatePrivateKey();
const MASTER = "0x8544e4a8a13bdc617a570dc501117488e33f87d6" as const;

function harness(decision: PreToolUseDecision, creds = true) {
  const sent: OrderWire[] = [];
  const groupings: string[] = [];
  const cancels: [number, number][] = [];
  const outcomes: { result: unknown; rawInput: unknown }[] = [];
  const requests: { toolName: string; rawInput: Record<string, unknown> }[] = [];
  let mid = "80000";
  const api: HyperliquidApi = {
    info: (async (p: Record<string, unknown>) => {
      if (p.type === "allMids") return { BTC: mid };
      if (p.type === "perpDexs") return [null, { name: "xyz" }];
      if (p.type === "clearinghouseState" && p.dex === "xyz") {
        return {
          assetPositions: [
            { position: { coin: "xyz:BRENTOIL", szi: "1.98", positionValue: "193" } },
          ],
        };
      }
      if (p.type === "clearinghouseState") {
        return { assetPositions: [{ position: { coin: "BTC", szi: "0.002" } }] };
      }
      if (p.type === "userAbstraction") return "default";
      return [];
    }) as HyperliquidApi["info"],
    order: async (orders, grouping = "na") => {
      sent.push(...orders);
      groupings.push(grouping);
      return [{ resting: { oid: 42 } }];
    },
    cancel: async (a, o) => {
      cancels.push([a, o]);
    },
    updateLeverage: async () => {},
    assetId: (s) => (s === "BTC" ? 0 : undefined),
    szDecimals: (s) => (s === "BTC" ? 5 : undefined),
    coin: (s) => s,
    symbol: (c) => c,
    loadSymbols: async () => {},
  };
  const vault = {
    hyperliquidCredentials: () =>
      creds
        ? { privateKey: KEY, accountAddress: MASTER, masterAddress: MASTER, env: "mainnet" }
        : null,
  };
  const approvals = {
    request: async (a: { toolName: string; rawInput: Record<string, unknown> }) => {
      requests.push(a);
      mid = "81000"; // the market moves while the card waits
      return decision;
    },
    recordOutcome: (o: { result: unknown; rawInput: unknown }) => outcomes.push(o),
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural test doubles
  const svc = new HyperliquidService(vault as any, approvals as any, () => api);
  return { svc, sent, groupings, cancels, outcomes, requests };
}

describe("HyperliquidService gate", () => {
  const order = { symbol: "BTC", side: "buy", size: 0.001, price: 79_000 };

  test("a declined order is never signed", async () => {
    const h = harness(deny);
    expect(await h.svc.call("a1", "place_order", order)).toEqual({ ok: false, error: "too big" });
    expect(h.sent).toHaveLength(0);
    expect(h.requests[0].toolName).toBe("mcp__hyperliquid__place_order");
  });

  test("an approved order is sent once and its outcome links the order id", async () => {
    const h = harness(allow);
    const r = await h.svc.call("a1", "place_order", order);
    expect(r).toEqual({ ok: true, result: { symbol: "BTC", status: "open", order_id: 42 } });
    expect(h.sent).toEqual([
      { a: 0, b: true, p: "79000", s: "0.001", r: false, t: { limit: { tif: "Gtc" } } },
    ]);
    expect(h.requests[0].rawInput).toMatchObject({ ...order, ref_price: 80_000 });
    expect(parseOrderResult(h.outcomes[0].result, "mcp__hyperliquid__place_order")).toMatchObject({
      ok: true,
      orderId: "42",
    });
  });

  test("an entry with a stop-loss is sent as one group, the stop sized to it", async () => {
    const h = harness(allow);
    const r = await h.svc.call("a1", "place_order", { ...order, stop_loss: 75_000 });
    expect(r).toMatchObject({ ok: true, result: { order_id: 42, stop_loss: 75_000 } });
    expect(h.groupings).toEqual(["normalTpsl"]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({
      b: false,
      s: "0.001",
      r: true,
      t: { trigger: { isMarket: true, triggerPx: "75000", tpsl: "sl" } },
    });
    expect(h.requests[0].rawInput.stop_loss).toBe(75_000);
    // A stop above a buy's entry never raises a card.
    const bad = await h.svc.call("a1", "place_order", { ...order, stop_loss: 99_000 });
    expect(bad.ok).toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  test("a market order is re-priced off the mid at send time, not card time", async () => {
    const h = harness(allow);
    await h.svc.call("a1", "place_order", { ...order, price: undefined, order_type: "market" });
    expect(h.sent[0].p).toBe("83430"); // 81000 × 1.03
  });

  test("close_position resolves side and size from the open position", async () => {
    const h = harness(allow);
    await h.svc.call("a1", "close_position", { symbol: "BTC" });
    expect(h.requests[0].rawInput).toMatchObject({ side: "sell", size: 0.002, reduce_only: true });
    expect(h.sent[0]).toMatchObject({ b: false, s: "0.002", r: true });
  });

  test("cancel is gated and recorded as an accepted cancel", async () => {
    const h = harness(allow);
    await h.svc.call("a1", "cancel_order", { symbol: "BTC", order_id: 42 });
    expect(h.cancels).toEqual([[0, 42]]);
    expect(parseOrderResult(h.outcomes[0].result, "mcp__hyperliquid__cancel_order").ok).toBe(true);
  });

  test("reads skip the gate; bad input and unknown markets never raise a card", async () => {
    const h = harness(deny);
    expect((await h.svc.call("a1", "get_mids", {})).ok).toBe(true);
    expect((await h.svc.call("a1", "place_order", { ...order, size: 0.00001 })).ok).toBe(false);
    expect((await h.svc.call("a1", "place_order", { ...order, symbol: "NOPE" })).ok).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  test("positions on a builder-deployed dex are part of the account", async () => {
    const h = harness(allow);
    const r = await h.svc.call("a1", "get_account", {});
    const positions = (r as { result: { positions: { symbol: string }[] } }).result.positions;
    expect(positions.map((p) => p.symbol).sort()).toEqual(["BTC", "xyz:BRENTOIL"]);
  });

  test("no credentials → a clear error", async () => {
    const h = harness(allow, false);
    const r = await h.svc.call("a1", "get_account", {});
    expect(r).toMatchObject({ ok: false });
    expect(h.sent).toHaveLength(0);
  });
});

describe("saving an API wallet", () => {
  function setup(roles: Record<string, unknown>) {
    const sqlite = new Database(":memory:");
    sqlite.exec(SCHEMA_DDL);
    const vault = new VaultService(drizzle(sqlite, { schema }) as unknown as Db);
    const info = (async (p: { user: string }) => roles[p.user] ?? { role: "missing" }) as never;
    // biome-ignore lint/suspicious/noExplicitAny: structural test doubles
    const svc = new HyperliquidService(vault, {} as any, undefined, () => info);
    return { vault, svc };
  }
  const wallet = addressOf(KEY);

  test("the account is resolved from the venue; the key never reaches the renderer", async () => {
    const { vault, svc } = setup({ [wallet]: { role: "agent", data: { user: MASTER } } });
    const status = await svc.save({ privateKey: KEY.slice(2).toUpperCase(), env: "mainnet" });
    expect(status.hyperliquid).toEqual({
      configured: true,
      enabled: true,
      env: "mainnet",
      account: MASTER,
      apiWallet: wallet,
    });
    expect(JSON.stringify(status)).not.toContain(KEY.slice(2));
    expect(vault.agentIntegrations().hyperliquid).toBe(true);
    expect(vault.hyperliquidCredentials()?.privateKey).toBe(KEY);
    vault.setEnabled("hyperliquid", false);
    expect(vault.hyperliquidCredentials()).toBeNull();
    expect(vault.removeHyperliquid().hyperliquid.configured).toBe(false);
  });

  test("a main wallet's key (it can withdraw) is refused", async () => {
    const { vault, svc } = setup({ [wallet]: { role: "user" } });
    await expect(svc.save({ privateKey: KEY, env: "mainnet" })).rejects.toThrow(/API wallet/);
    expect(vault.status().hyperliquid.configured).toBe(false);
  });

  test("an unapproved key, and someone else's sub-account, are refused", async () => {
    const sub = "0x00000000000000000000000000000000000000aa";
    await expect(setup({}).svc.save({ privateKey: KEY, env: "testnet" })).rejects.toThrow(
      /testnet doesn't know/,
    );
    const roles = {
      [wallet]: { role: "agent", data: { user: MASTER } },
      [sub]: { role: "subAccount", data: { master: "0x00000000000000000000000000000000000000bb" } },
    };
    await expect(
      setup(roles).svc.save({ privateKey: KEY, accountAddress: sub, env: "mainnet" }),
    ).rejects.toThrow(/not a sub-account/);
    const own = { ...roles, [sub]: { role: "subAccount", data: { master: MASTER } } };
    const ok = await setup(own).svc.save({ privateKey: KEY, accountAddress: sub, env: "mainnet" });
    expect(ok.hyperliquid.account).toBe(sub);
  });

  test("normalizePrivateKey", () => {
    expect(normalizePrivateKey(` ${KEY.slice(2)} `)).toBe(KEY);
    expect(() => normalizePrivateKey("0x1234")).toThrow();
  });
});
