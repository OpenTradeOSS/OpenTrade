import { describe, expect, test } from "bun:test";
import type { OrderStatus } from "@shared/broker";
import { isTerminal, orderNotification, terminalTransition } from "./order-notify";

const order = (over: Partial<OrderStatus> & { id: string }): OrderStatus => ({
  symbol: "AAPL",
  side: "buy",
  type: "market",
  state: "confirmed",
  quantity: 2,
  cumulativeQuantity: null,
  avgPrice: null,
  limitPrice: null,
  fees: null,
  dollarAmount: null,
  createdAt: null,
  lastTransactionAt: null,
  ...over,
});

describe("isTerminal", () => {
  test("terminal states (any casing)", () => {
    for (const s of [
      "filled",
      "REJECTED",
      "Cancelled",
      "canceled",
      "failed",
      "expired",
      "voided",
    ]) {
      expect(isTerminal(s)).toBe(true);
    }
  });
  test("non-terminal / unknown states", () => {
    for (const s of ["confirmed", "queued", "partially_filled", "new", "weird", null]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("terminalTransition", () => {
  test("in-flight → terminal notifies", () => {
    expect(
      terminalTransition(
        order({ id: "1", state: "confirmed" }),
        order({ id: "1", state: "filled" }),
      ),
    ).toBe(true);
  });
  test("terminal → terminal is suppressed (absorbing, dedupes)", () => {
    expect(
      terminalTransition(order({ id: "1", state: "filled" }), order({ id: "1", state: "filled" })),
    ).toBe(false);
  });
  test("prev undefined + terminal notifies (appeared already-terminal between polls)", () => {
    expect(terminalTransition(undefined, order({ id: "1", state: "filled" }))).toBe(true);
  });
  test("prev undefined + non-terminal does not notify", () => {
    expect(terminalTransition(undefined, order({ id: "1", state: "queued" }))).toBe(false);
  });
  test("in-flight → in-flight does not notify", () => {
    expect(
      terminalTransition(
        order({ id: "1", state: "queued" }),
        order({ id: "1", state: "confirmed" }),
      ),
    ).toBe(false);
  });
});

describe("orderNotification", () => {
  test("filled order carries the fill price", () => {
    const n = orderNotification(
      order({ id: "1", side: "buy", cumulativeQuantity: 2, avgPrice: 182.34, state: "filled" }),
      "Momentum Bot",
      "agent-1",
    );
    expect(n.kind).toBe("order");
    expect(n.title).toBe("Momentum Bot — Order filled");
    expect(n.body).toBe("BUY 2 AAPL — filled at $182.34");
    expect(n.agentId).toBe("agent-1");
  });
  test("rejected order has no price", () => {
    const n = orderNotification(
      order({ id: "1", side: "sell", state: "rejected", avgPrice: null }),
      "Bot",
    );
    expect(n.body).toBe("SELL 2 AAPL — rejected");
  });
  test("dollar-based order uses the notional", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: "buy",
        quantity: null,
        cumulativeQuantity: null,
        dollarAmount: 100,
        state: "filled",
        avgPrice: 50,
      }),
      null,
    );
    expect(n.body).toBe("BUY $100 AAPL — filled at $50");
    expect(n.title).toBe("agent — Order filled");
  });
  test("null fields fall back gracefully", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: null,
        symbol: null,
        quantity: null,
        cumulativeQuantity: null,
        state: "cancelled",
      }),
      null,
    );
    expect(n.body).toBe("ORDER order — cancelled");
  });
  test("fractional fills trim trailing zeros", () => {
    const n = orderNotification(
      order({
        id: "1",
        side: "buy",
        cumulativeQuantity: 0.880592,
        avgPrice: 85.18,
        state: "filled",
      }),
      "Bot",
    );
    expect(n.body).toBe("BUY 0.880592 AAPL — filled at $85.18");
  });
});

describe("orderNotification — options", () => {
  const tltFill = order({
    id: "o1",
    assetType: "option",
    symbol: "TLT",
    side: "buy",
    type: "limit",
    state: "filled",
    quantity: 1,
    cumulativeQuantity: 1,
    avgPrice: 0.79,
    limitPrice: 0.79,
    multiplier: 100,
    legs: [
      {
        optionId: "x",
        side: "buy",
        positionEffect: "open",
        ratioQuantity: 1,
        contract: {
          optionId: "x",
          chainSymbol: "TLT",
          expirationDate: "2026-11-20",
          strikePrice: 86,
          optionType: "call",
          multiplier: 100,
        },
      },
    ],
  });

  test("a fill names the contract and the per-contract cost (price × multiplier)", () => {
    const n = orderNotification(tltFill, "citrini");
    expect(n.title).toBe("citrini — Order filled");
    expect(n.body).toBe("BUY 1 TLT $86C 11/20/26 — filled at $79");
  });

  test("a rejected option order carries no price", () => {
    const n = orderNotification({ ...tltFill, state: "rejected", avgPrice: null }, null);
    expect(n.body).toBe("BUY 1 TLT $86C 11/20/26 — rejected");
  });
});

describe("orderNotification — crypto", () => {
  test("coin quantities keep 8 decimals — a 1-satoshi fill is not rounded to 0", () => {
    const n = orderNotification(
      order({
        id: "c1",
        assetType: "crypto",
        symbol: "BTC",
        side: "buy",
        state: "filled",
        quantity: 0.00000001,
        cumulativeQuantity: 0.00000001,
        avgPrice: 78691.76,
      }),
      null,
    );
    expect(n.body).toBe("BUY 0.00000001 BTC — filled at $78691.76");
  });
});
