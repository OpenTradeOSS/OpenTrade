import { describe, expect, test } from "bun:test";
import type { ParsedOrder } from "@shared/approval";
import type { OrderStatus } from "@shared/broker";
import {
  assignProtection,
  parsedTrigger,
  protectionNote,
  protectionStage,
  triggerAction,
} from "./stops";

const order = (o: Partial<OrderStatus>): OrderStatus => ({
  id: "1",
  symbol: "BTC",
  side: "buy",
  type: "limit",
  state: "filled",
  quantity: 0.01,
  cumulativeQuantity: 0,
  avgPrice: null,
  limitPrice: null,
  fees: null,
  dollarAmount: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastTransactionAt: null,
  ...o,
});

const entryParsed: ParsedOrder = {
  kind: "place",
  symbol: "BTC",
  side: "buy",
  quantity: 0.01,
  orderType: "limit",
  limitPrice: 80_000,
  estCost: 800,
  stopPrice: 76_000,
  takeProfitPrice: 90_000,
  summary: "",
};
const entry = order({ id: "10" });
const stop = order({
  id: "11",
  side: "sell",
  type: "stop market",
  state: "confirmed",
  trigger: { kind: "sl", price: 76_000 },
  reduceOnly: true,
});

describe("stops in Activity", () => {
  const ref = (key: string, status: OrderStatus, parsed = entryParsed) => ({ key, parsed, status });

  test("a stop belongs to the latest entry before it on the same market, opposite side", () => {
    const later = order({ id: "20", createdAt: "2026-10-01T02:00:00.000Z" });
    const lateStop = order({ ...stop, id: "21", createdAt: "2026-10-01T02:00:05.000Z" });
    const noise = [
      order({ id: "12", side: "sell", symbol: "ETH", trigger: stop.trigger, reduceOnly: true }),
      order({ ...stop, id: "14", createdAt: "2026-09-30T00:00:00.000Z" }), // older than any entry
      order({ id: "15", side: "sell", trigger: stop.trigger }), // not reduce-only
      order({ ...stop, id: "16", side: "buy" }), // same side as the entry
    ];
    const got = assignProtection([ref("a", entry), ref("b", later)], [...noise, stop, lateStop]);
    expect(got.get("a")?.map((o) => o.id)).toEqual(["11"]);
    expect(got.get("b")?.map((o) => o.id)).toEqual(["21"]);
    // A stop order's own row, or a closing order, never owns protection.
    expect(
      assignProtection([ref("s", entry, { ...entryParsed, orderType: "stop_market" })], [stop])
        .size,
    ).toBe(0);
    expect(assignProtection([ref("c", order({ id: "30", reduceOnly: true }))], [stop]).size).toBe(
      0,
    );
  });

  test("the entry row names its protection, live once linked", () => {
    expect(protectionNote(entryParsed, [])).toBe("Stop-loss $76,000.00 · Take-profit $90,000.00");
    expect(
      protectionNote({ ...entryParsed, stopPrice: null, takeProfitPrice: null }, []),
    ).toBeNull();
    const bare = { ...entryParsed, stopPrice: null, takeProfitPrice: null };
    expect(protectionNote(bare, [stop])).toBe("Stop-loss $76,000.00");
    expect(
      protectionNote(bare, [
        { ...stop, state: "filled", cumulativeQuantity: 0.01, avgPrice: 75_990 },
      ]),
    ).toBe("Stop-loss triggered at $76,000.00: sold 0.01 at $75,990.00");
  });

  test("waiting → triggered (with the fill) → cancelled", () => {
    expect(protectionStage(stop).label).toBe("Stop-loss waiting at $76,000.00");
    expect(
      protectionStage({ ...stop, state: "filled", cumulativeQuantity: 0.01, avgPrice: 75_990 }),
    ).toEqual({
      label: "Stop-loss triggered at $76,000.00: sold 0.01 at $75,990.00",
      tone: "bg-destructive",
    });
    expect(protectionStage({ ...stop, state: "cancelled" }).label).toBe(
      "Stop-loss at $76,000.00 cancelled",
    );
  });

  test("a stop order's own row says what it is, and why it sold", () => {
    const t = { kind: "sl", price: 76_000 } as const;
    expect(triggerAction("sell", "BTC", t, false)).toBe("STOP-LOSS SELL BTC @ $76,000.00");
    expect(triggerAction("sell", "BTC", t, true)).toBe(
      "SELL BTC · stop-loss triggered at $76,000.00",
    );
    expect(parsedTrigger({ ...entryParsed, orderType: "take_profit_market" })).toEqual({
      kind: "tp",
      price: 76_000,
    });
    expect(parsedTrigger(entryParsed)).toBeNull();
  });
});
