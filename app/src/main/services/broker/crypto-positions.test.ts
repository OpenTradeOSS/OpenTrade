import { describe, expect, test } from "bun:test";
import type { CryptoPosition, CryptoQuote, Portfolio } from "@shared/broker";
import { enrichCryptoPosition, withDayChange } from "./index";

const portfolio = (equity: number): Portfolio => ({
  accountNumber: "X",
  equity,
  marketValue: null,
  buyingPower: null,
  cash: null,
  dayChange: null,
  dayChangePct: null,
});

const raw = (over: Partial<CryptoPosition> = {}): CryptoPosition => ({
  assetCode: "BTC",
  quantity: 0.002,
  transferableQuantity: 0.002,
  avgCost: 80000,
  directQuantity: 0.002,
  intradayQuantity: 0,
  lastPrice: null,
  previousClose: null,
  marketValue: null,
  unrealizedPnl: null,
  ...over,
});

const quote = (mark: number, previousClose: number): CryptoQuote => ({
  symbol: "BTCUSD",
  mark,
  bidPrice: null,
  askPrice: null,
  previousClose,
});

describe("enrichCryptoPosition", () => {
  test("folds mark into price, value, and P&L against the direct basis", () => {
    const p = enrichCryptoPosition(raw(), quote(78691.76, 77747.08));
    expect(p.lastPrice).toBeCloseTo(78691.76);
    expect(p.previousClose).toBeCloseTo(77747.08);
    expect(p.marketValue).toBeCloseTo(157.38, 1);
    expect(p.unrealizedPnl).toBeCloseTo(-2.62, 1); // bought at 80k, now 78.7k, ×0.002
  });

  test("mixed-basis holding: P&L covers only the directly purchased lots", () => {
    // 0.003 BTC held, but only 0.002 was bought directly — the transferred 0.001
    // has no basis, so its P&L is unknown, never extrapolated from the others'.
    const p = enrichCryptoPosition(
      raw({ quantity: 0.003, directQuantity: 0.002 }),
      quote(78691.76, 77747.08),
    );
    expect(p.marketValue).toBeCloseTo(78691.76 * 0.003); // value covers everything
    expect(p.unrealizedPnl).toBeCloseTo((78691.76 - 80000) * 0.002); // P&L only known lots
  });

  test("no basis → value but no P&L; no quote → untouched", () => {
    const noBasis = enrichCryptoPosition(
      raw({ avgCost: null, directQuantity: null }),
      quote(78691.76, 77747.08),
    );
    expect(noBasis.marketValue).not.toBeNull();
    expect(noBasis.unrealizedPnl).toBeNull();
    expect(enrichCryptoPosition(raw(), undefined).lastPrice).toBeNull();
  });
});

describe("withDayChange — crypto", () => {
  test("coins held overnight move from the midnight-ET boundary close", () => {
    const p = withDayChange(
      portfolio(1000),
      [],
      new Map(),
      [],
      [enrichCryptoPosition(raw(), quote(78691.76, 77747.08))],
    );
    expect(p.dayChange).toBeCloseTo((78691.76 - 77747.08) * 0.002);
  });

  test("coins bought today move from their basis; no quote → skipped", () => {
    const today = withDayChange(
      portfolio(1000),
      [],
      new Map(),
      [],
      [enrichCryptoPosition(raw({ intradayQuantity: 0.002 }), quote(78691.76, 77747.08))],
    );
    expect(today.dayChange).toBeCloseTo((78691.76 - 80000) * 0.002);

    const noQuote = withDayChange(portfolio(1000), [], new Map(), [], [raw()]);
    expect(noQuote.dayChange).toBeNull();
  });
});
