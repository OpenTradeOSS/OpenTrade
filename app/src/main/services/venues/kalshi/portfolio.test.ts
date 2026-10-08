import { describe, expect, test } from "bun:test";
import { agentPositions, mapOrder, mapPortfolio } from "./portfolio";

// Shapes per docs.kalshi.com GetBalance / GetPositions / GetOrders (fixed-point strings).
const markets = new Map<string, Record<string, unknown>>([
  ["FED-Y", { title: "Fed hikes?", yes_bid_dollars: "0.4000", no_bid_dollars: "0.5800" }],
  ["RAIN-N", { title: "Rain?", yes_bid_dollars: "0.7000", no_bid_dollars: "0.2800" }],
]);

describe("Kalshi portfolio mapping", () => {
  const agents = new Map([
    ["a-1", "agentA"],
    ["a-2", "agentA"],
    ["a-3", "agentB"],
  ]);
  const fill = (
    order_id: string,
    ticker: string,
    side: "yes" | "no",
    count: number,
    yes: number,
    t: number,
  ) => ({
    order_id,
    ticker,
    outcome_side: side,
    count_fp: count.toFixed(2),
    yes_price_dollars: yes.toFixed(4),
    no_price_dollars: (1 - yes).toFixed(4),
    ts: t,
  });

  test("only agent orders count; the user's own fills are ignored", () => {
    const positions = agentPositions(
      [fill("a-1", "FED-Y", "yes", 10, 0.35, 1), fill("mine", "FED-Y", "yes", 500, 0.3, 2)],
      agents,
      markets,
    );
    expect(positions).toEqual([
      {
        ticker: "FED-Y",
        title: "Fed hikes?",
        side: "yes",
        contracts: 10,
        cost: 3.5,
        mark: 0.4,
        marketValue: 4,
        unrealizedPnl: 0.5,
        agentIds: ["agentA"],
      },
    ]);
  });

  test("NO positions are marked at the NO bid", () => {
    const [p] = agentPositions([fill("a-3", "RAIN-N", "no", 5, 0.65, 1)], agents, markets);
    expect(p).toMatchObject({
      side: "no",
      contracts: 5,
      cost: 1.75,
      mark: 0.28,
      marketValue: 1.4,
      unrealizedPnl: -0.35,
    });
  });

  test("opposite-side fills net the position down (average cost), then flip", () => {
    // Buy 10 YES @0.40 (cost 4.00), then buy 4 NO (closes 4 YES → 6 YES, cost 2.40).
    let [p] = agentPositions(
      [fill("a-1", "FED-Y", "yes", 10, 0.4, 1), fill("a-2", "FED-Y", "no", 4, 0.5, 2)],
      agents,
      markets,
    );
    expect(p).toMatchObject({ side: "yes", contracts: 6, cost: 2.4 });
    // A further 8 NO @ no=0.55 closes the 6 YES and opens 2 NO at 0.55 each.
    [p] = agentPositions(
      [
        fill("a-1", "FED-Y", "yes", 10, 0.4, 1),
        fill("a-2", "FED-Y", "no", 4, 0.5, 2),
        fill("a-3", "FED-Y", "no", 8, 0.45, 3),
      ],
      agents,
      markets,
    );
    expect(p).toMatchObject({
      side: "no",
      contracts: 2,
      cost: 1.1,
      agentIds: ["agentA", "agentB"],
    });
    // Fully closed → no row.
    expect(
      agentPositions(
        [fill("a-1", "FED-Y", "yes", 3, 0.4, 1), fill("a-2", "FED-Y", "no", 3, 0.5, 2)],
        agents,
        markets,
      ),
    ).toEqual([]);
  });

  test("portfolio: headline is the agents' positions; cash is the shared account's", () => {
    const positions = agentPositions([fill("a-1", "FED-Y", "yes", 10, 0.35, 1)], agents, markets);
    expect(
      mapPortfolio(
        { balance: 12345, balance_dollars: "123.4500", portfolio_value: 99999 },
        positions,
        1,
      ),
    ).toMatchObject({
      cash: 123.45,
      positionsValue: 4,
      unrealizedPnl: 0.5,
    });
    expect(mapPortfolio({ balance: 1000 }, [], 1)).toMatchObject({
      cash: 10,
      positionsValue: 0,
      unrealizedPnl: 0,
    });
  });

  test("orders map onto the shared ledger shape Activity joins on", () => {
    expect(
      mapOrder({
        order_id: "o1",
        ticker: "FED-Y",
        outcome_side: "no",
        status: "executed",
        yes_price_dollars: "0.4200",
        no_price_dollars: "0.5800",
        initial_count_fp: "4.00",
        fill_count_fp: "4.00",
        taker_fill_cost_dollars: "2.3200",
        maker_fill_cost_dollars: "0",
        taker_fees_dollars: "0.0700",
        created_time: "2026-09-30T10:00:00Z",
      }),
    ).toMatchObject({
      id: "o1",
      symbol: "FED-Y NO",
      state: "filled",
      quantity: 4,
      cumulativeQuantity: 4,
      avgPrice: 0.58,
      limitPrice: 0.58,
      fees: 0.07,
    });
    expect(mapOrder({ order_id: "o2", status: "resting", fill_count_fp: "0" })?.state).toBe(
      "confirmed",
    );
    expect(mapOrder({ order_id: "o3", status: "canceled", fill_count_fp: "0" })?.state).toBe(
      "cancelled",
    );
  });
});
