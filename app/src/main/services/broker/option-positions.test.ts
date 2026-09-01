import { describe, expect, test } from "bun:test";
import type { OptionContract, OptionPosition, OptionQuote, Portfolio } from "@shared/broker";
import { enrichOptionPosition, withDayChange } from "./index";

const TLT_ID = "e9c444cc-5ccc-4dfe-8fd9-64daf22d6338";

const portfolio = (equity: number): Portfolio => ({
  accountNumber: "X",
  equity,
  marketValue: null,
  buyingPower: null,
  cash: null,
  dayChange: null,
  dayChangePct: null,
});

/** The live TLT position as the mapper leaves it: no strike/type, no price. */
const raw = (over: Partial<OptionPosition> = {}): OptionPosition => ({
  optionId: TLT_ID,
  chainId: "c",
  chainSymbol: "TLT",
  type: "long",
  quantity: 1,
  intradayQuantity: 1,
  averagePrice: 79,
  intradayAverageOpenPrice: 79,
  expirationDate: "2026-11-20",
  multiplier: 100,
  strikePrice: null,
  optionType: null,
  lastPrice: null,
  previousClose: null,
  marketValue: null,
  unrealizedPnl: null,
  pendingQuantity: 0,
  ...over,
});

const contract: OptionContract = {
  optionId: TLT_ID,
  chainSymbol: "TLT",
  expirationDate: "2026-11-20",
  strikePrice: 86,
  optionType: "call",
  multiplier: 100,
};

const quote = (mark: number, previousClose: number): OptionQuote => ({
  optionId: TLT_ID,
  mark,
  bidPrice: null,
  askPrice: null,
  previousClose,
  impliedVolatility: null,
  delta: null,
  theta: null,
});

describe("enrichOptionPosition", () => {
  test("folds in the contract identity and prices in contract units", () => {
    const p = enrichOptionPosition(raw(), contract, quote(0.765, 0.85));
    expect(p.strikePrice).toBe(86);
    expect(p.optionType).toBe("call");
    expect(p.lastPrice).toBe(0.765); // per share, as quoted
    expect(p.previousClose).toBe(0.85);
    expect(p.marketValue).toBeCloseTo(76.5); // 0.765 × 100 × 1
    expect(p.unrealizedPnl).toBeCloseTo(-2.5); // 76.5 − 79 (basis is per contract)
  });

  test("a short position inverts value and P&L", () => {
    const p = enrichOptionPosition(raw({ type: "short" }), contract, quote(0.5, 0.85));
    expect(p.marketValue).toBeCloseTo(-50);
    expect(p.unrealizedPnl).toBeCloseTo(29); // sold at 79, now worth 50
  });

  test("no quote → identity only, prices stay null; no contract → identity stays null", () => {
    const noQuote = enrichOptionPosition(raw(), contract, undefined);
    expect(noQuote.strikePrice).toBe(86);
    expect(noQuote.lastPrice).toBeNull();
    expect(noQuote.unrealizedPnl).toBeNull();
    const noContract = enrichOptionPosition(raw(), undefined, quote(0.765, 0.85));
    expect(noContract.strikePrice).toBeNull();
    expect(noContract.marketValue).toBeCloseTo(76.5);
  });
});

describe("withDayChange — options", () => {
  // Prices ride the enriched position rows themselves — the same rows a poll
  // serves from cache during an options-API outage.
  const enriched = (over: Parameters<typeof raw>[0] = {}) =>
    enrichOptionPosition(raw(over), contract, quote(0.765, 0.85));

  test("contracts held overnight move from the prior close × multiplier", () => {
    const p = withDayChange(portfolio(1000), [], new Map(), [
      enriched({ intradayQuantity: 0, quantity: 2 }),
    ]);
    expect(p.dayChange).toBeCloseTo(-17); // (0.765 − 0.85) × 100 × 2
    expect(p.dayChangePct).toBeCloseTo(-17 / 1017);
  });

  test("contracts opened today move from their own basis; a short inverts", () => {
    // 1 contract, opened today at $79
    const today = withDayChange(portfolio(1000), [], new Map(), [enriched()]);
    expect(today.dayChange).toBeCloseTo(-2.5); // 76.5 − 79, NOT vs. the 0.85 close

    const short = withDayChange(portfolio(1000), [], new Map(), [
      enriched({ type: "short", intradayQuantity: 0 }),
    ]);
    expect(short.dayChange).toBeCloseTo(8.5);
  });

  test("a cached (already-enriched) position still counts with no live quote in sight", () => {
    // The outage path serves enriched rows from cache; Today must not drop them.
    const p = withDayChange(portfolio(1000), [], new Map(), [
      enriched({ intradayQuantity: 0, quantity: 2 }),
    ]);
    expect(p.dayChange).not.toBeNull();
  });

  test("a never-priced position is skipped, leaving null when nothing else counts", () => {
    const p = withDayChange(portfolio(1000), [], new Map(), [raw()]);
    expect(p.dayChange).toBeNull();
  });
});
