import { describe, expect, test } from "bun:test";
import {
  mapAccounts,
  mapCryptoOrderStatuses,
  mapCryptoPositions,
  mapCryptoQuotes,
  mapOptionInstruments,
  mapOptionOrderStatuses,
  mapOptionPositions,
  mapOptionQuotes,
  mapOrderStatuses,
  mapPortfolio,
  mapPositions,
  mapQuotes,
  nextCursor,
  unwrap,
} from "./mapping";

// Real envelope shape observed from the live Robinhood MCP (get_accounts).
const accountsEnvelope = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data: {
          accounts: [
            {
              account_number: "991422569",
              rhs_account_number: "991422569",
              type: "margin",
              brokerage_account_type: "individual",
              is_default: true,
              agentic_allowed: false,
              state: "active",
            },
            {
              account_number: "AGENT123",
              brokerage_account_type: "individual",
              is_default: false,
              agentic_allowed: true,
              state: "active",
            },
          ],
        },
      }),
    },
  ],
};

describe("unwrap", () => {
  test("extracts inner JSON from the MCP text envelope", () => {
    const payload = unwrap(accountsEnvelope) as { data: { accounts: unknown[] } };
    expect(payload.data.accounts).toHaveLength(2);
  });

  test("passes through non-enveloped values", () => {
    expect(unwrap({ foo: 1 })).toEqual({ foo: 1 });
  });
});

describe("mapAccounts", () => {
  test("maps the real account shape and flags the agentic account", () => {
    const accounts = mapAccounts(unwrap(accountsEnvelope));
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toEqual({
      accountNumber: "991422569",
      rhsAccountNumber: "991422569",
      type: "individual",
      agentic: false,
      isDefault: true,
    });
    expect(accounts.find((a) => a.agentic)?.accountNumber).toBe("AGENT123");
  });
});

describe("mapPortfolio", () => {
  // Real shape observed live (get_portfolio): total_value/equity_value, nested
  // buying_power, string numbers.
  test("maps account total vs holdings value and the nested buying power", () => {
    const portfolio = mapPortfolio(
      {
        data: {
          total_value: "1999.99",
          equity_value: "125.39",
          cash: "1874.6",
          buying_power: { buying_power: "1874.6000", unleveraged_buying_power: "1874.6000" },
        },
      },
      "547526228",
    );
    expect(portfolio).toEqual({
      accountNumber: "547526228",
      equity: 1999.99,
      marketValue: 125.39,
      buyingPower: 1874.6,
      cash: 1874.6,
      dayChange: null,
      dayChangePct: null,
      optionsValue: null,
      cryptoValue: null,
    });
  });
});

describe("mapPositions", () => {
  test("coerces string numbers and derives market value + pnl when price is present", () => {
    const positions = mapPositions({
      data: {
        positions: [{ symbol: "AAPL", quantity: "10", average_cost: "100", last_price: "110" }],
      },
    });
    expect(positions[0]).toMatchObject({
      symbol: "AAPL",
      quantity: 10,
      averageCost: 100,
      lastPrice: 110,
      marketValue: 1100,
      unrealizedPnl: 100,
    });
  });

  test("real shape has no price — averageCost from average_buy_price, lastPrice null", () => {
    const positions = mapPositions({
      data: {
        positions: [
          {
            symbol: "INTC",
            quantity: "1.000000",
            intraday_quantity: "1.000000",
            average_buy_price: "125.400000",
            type: "long",
          },
        ],
      },
    });
    expect(positions[0]).toMatchObject({
      symbol: "INTC",
      quantity: 1,
      intradayQuantity: 1,
      averageCost: 125.4,
      lastPrice: null,
      unrealizedPnl: null,
    });
  });
});

describe("mapOrderStatuses", () => {
  // Real shapes from live get_equity_orders (placed_agent=agentic).
  const filledMarket = {
    id: "6a3059a5-ed0b-4726-be61-0b40c0710cc0",
    symbol: "GDX",
    side: "buy",
    type: "market",
    state: "filled",
    quantity: "0.880592",
    cumulative_quantity: "0.880592",
    price: "85.180000",
    average_price: "85.169900",
    fees: "0.000000",
    dollar_based_amount: { amount: "75.000000", currency_code: "USD" },
    created_at: "2026-06-15T19:59:33.173739Z",
    last_transaction_at: "2026-06-15T19:59:33.38Z",
  };
  const filledLimit = {
    id: "6a2c9cb7-a947-4f2d-8771-00c5f3f68b6f",
    symbol: "INTC",
    side: "buy",
    type: "limit",
    state: "filled",
    quantity: "1.000000",
    cumulative_quantity: "1.000000",
    price: "125.500000",
    average_price: "125.400000",
    dollar_based_amount: null,
    created_at: "2026-06-12T23:56:39.475706Z",
    last_transaction_at: "2026-06-12T23:56:39.678Z",
  };

  test("takes avg_price as VWAP and cumulative_quantity as executed — NOT limit/ordered", () => {
    const [o] = mapOrderStatuses({ data: { orders: [filledLimit] } });
    expect(o).toEqual({
      assetType: "equity",
      id: "6a2c9cb7-a947-4f2d-8771-00c5f3f68b6f",
      symbol: "INTC",
      side: "buy",
      type: "limit",
      state: "filled",
      quantity: 1,
      cumulativeQuantity: 1,
      avgPrice: 125.4, // average_price, the fill — not the 125.50 limit
      limitPrice: 125.5, // price = the limit, kept separately
      fees: null,
      dollarAmount: null,
      createdAt: "2026-06-12T23:56:39.475706Z",
      lastTransactionAt: "2026-06-12T23:56:39.678Z",
    });
  });

  test("market order: price is null (no limit), dollar amount unwrapped from the nested object", () => {
    const [o] = mapOrderStatuses({ data: { orders: [filledMarket] } });
    expect(o).toMatchObject({
      symbol: "GDX",
      type: "market",
      limitPrice: 85.18, // RH puts the reference price here for market orders
      avgPrice: 85.1699,
      cumulativeQuantity: 0.880592,
      dollarAmount: 75,
    });
  });

  test("partial fill keeps ordered vs executed distinct", () => {
    const [o] = mapOrderStatuses({
      data: {
        orders: [
          {
            id: "p1",
            symbol: "X",
            state: "partially_filled",
            quantity: "10",
            cumulative_quantity: "4",
            average_price: "20",
          },
        ],
      },
    });
    expect(o).toMatchObject({
      state: "partially_filled",
      quantity: 10,
      cumulativeQuantity: 4,
      avgPrice: 20,
    });
  });

  test("empty / wrong-account response yields no orders", () => {
    expect(mapOrderStatuses({ data: { orders: [] } })).toEqual([]);
    expect(mapOrderStatuses({ data: {} })).toEqual([]);
  });
});

describe("nextCursor", () => {
  test("pulls the cursor query param out of a next URL", () => {
    expect(
      nextCursor({ data: { orders: [], next: "https://api.robinhood.com/orders/?cursor=abc123" } }),
    ).toBe("abc123");
  });
  test("null when there is no further page", () => {
    expect(nextCursor({ data: { orders: [] } })).toBeNull();
  });
});

describe("mapQuotes", () => {
  test("reads the flat shape (back-compat)", () => {
    const quotes = mapQuotes({
      quotes: [{ symbol: "SPY", last_trade_price: "500.5", previous_close: "498" }],
    });
    expect(quotes[0]).toMatchObject({ symbol: "SPY", last: 500.5, previousClose: 498 });
  });

  test("descends into results[].quote and uses adjusted_previous_close", () => {
    const quotes = mapQuotes({
      data: {
        results: [
          {
            quote: {
              symbol: "INTC",
              last_trade_price: "124.540000",
              adjusted_previous_close: "116.960000",
              bid_price: "125.210000",
              ask_price: "125.420000",
            },
            close: { symbol: "INTC", price: "116.96" },
          },
        ],
      },
    });
    expect(quotes[0]).toMatchObject({
      symbol: "INTC",
      last: 124.54,
      previousClose: 116.96,
      bidPrice: 125.21,
      askPrice: 125.42,
    });
  });
});

// ---- options: real shapes from the live MCP (2026-08-27) ----

const TLT_ID = "e9c444cc-5ccc-4dfe-8fd9-64daf22d6338";

const liveOptionOrder = {
  id: "6a908e72-e3e6-451f-b9bc-e765a26c5056",
  chain_id: "644f21f0-a166-4c94-bd67-02568d3a5940",
  chain_symbol: "TLT",
  state: "filled",
  type: "limit",
  trigger: "immediate",
  direction: "debit",
  quantity: "1.00000",
  processed_quantity: "1.00000",
  pending_quantity: "0.00000",
  canceled_quantity: "0.00000",
  price: "0.79000000",
  stop_price: null,
  premium: "79.00000000",
  processed_premium: "79",
  trade_value_multiplier: "100.0000",
  time_in_force: "gfd",
  market_hours: "regular_hours",
  opening_strategy: "long_call",
  closing_strategy: null,
  placed_agent: "agentic",
  created_at: "2026-08-27T19:22:26.187483Z",
  updated_at: "2026-08-27T19:22:26.624039Z",
  last_transaction_at: null,
  is_replaceable: false,
  legs: [
    {
      id: "de66ccba-fd05-47a4-8e11-dc3510c45a05",
      option_id: TLT_ID,
      side: "buy",
      position_effect: "open",
      ratio_quantity: 1,
      expiration_date: "2026-11-20",
      strike_price: "86.0000",
      option_type: "call",
      executions: [
        {
          id: "6a908e72-ac36-46ae-a2c3-042f1fb9ef22",
          price: "0.79000000",
          quantity: "1.00000",
          settlement_date: "2026-08-28",
          trade_date: "2026-08-27",
          timestamp: "2026-08-27T19:22:26.462000Z",
        },
      ],
    },
  ],
};

describe("mapOptionOrderStatuses", () => {
  test("maps the live single-leg order in per-contract/per-share units with its contract", () => {
    const [o] = mapOptionOrderStatuses({ data: { orders: [liveOptionOrder] } });
    expect(o.id).toBe("6a908e72-e3e6-451f-b9bc-e765a26c5056");
    expect(o.assetType).toBe("option");
    expect(o.symbol).toBe("TLT"); // chain_symbol — the underlying
    expect(o.side).toBe("buy"); // the single leg's side, not the net direction
    expect(o.direction).toBe("debit");
    expect(o.type).toBe("limit");
    expect(o.state).toBe("filled");
    expect(o.quantity).toBe(1);
    expect(o.cumulativeQuantity).toBe(1);
    expect(o.limitPrice).toBe(0.79);
    expect(o.avgPrice).toBe(0.79); // processed_premium / (contracts × multiplier)
    expect(o.multiplier).toBe(100);
    expect(o.premium).toBe(79);
    expect(o.processedPremium).toBe(79);
    expect(o.strategy).toBe("long_call");
    expect(o.dollarAmount).toBeNull();
    expect(o.lastTransactionAt).toBe("2026-08-27T19:22:26.624039Z"); // updated_at fallback
    expect(o.legs).toHaveLength(1);
    expect(o.legs?.[0]).toEqual({
      optionId: TLT_ID,
      side: "buy",
      positionEffect: "open",
      ratioQuantity: 1,
      contract: {
        optionId: TLT_ID,
        chainSymbol: "TLT",
        expirationDate: "2026-11-20",
        strikePrice: 86,
        optionType: "call",
        multiplier: 100,
      },
    });
  });

  test("a spread's side is its net direction; an unfilled order has no avg price", () => {
    const [o] = mapOptionOrderStatuses({
      data: {
        orders: [
          {
            ...liveOptionOrder,
            state: "queued",
            processed_quantity: "0.00000",
            processed_premium: "0",
            legs: [
              { ...liveOptionOrder.legs[0], executions: [] },
              {
                ...liveOptionOrder.legs[0],
                option_id: "x",
                side: "sell",
                strike_price: "90.0000",
                executions: [],
              },
            ],
          },
        ],
      },
    });
    expect(o.side).toBe("debit");
    expect(o.cumulativeQuantity).toBe(0);
    expect(o.avgPrice).toBeNull();
    expect(o.legs?.[1].contract?.strikePrice).toBe(90);
  });

  test("falls back to the legs' execution VWAP when premium fields are absent", () => {
    const { premium: _p, processed_premium: _pp, ...noPremium } = liveOptionOrder;
    const [o] = mapOptionOrderStatuses({ data: { orders: [noPremium] } });
    expect(o.avgPrice).toBe(0.79);
  });

  test("empty response yields no orders", () => {
    expect(mapOptionOrderStatuses({ data: { orders: [] } })).toEqual([]);
  });
});

describe("mapOptionPositions", () => {
  test("maps the live position; average_price stays per contract (multiplier in)", () => {
    const [p] = mapOptionPositions({
      data: {
        positions: [
          {
            option_id: TLT_ID,
            chain_id: "644f21f0-a166-4c94-bd67-02568d3a5940",
            chain_symbol: "TLT",
            type: "long",
            quantity: "1.0000",
            average_price: "79.0000",
            expiration_date: "2026-11-20",
            trade_value_multiplier: "100.0000",
            intraday_average_open_price: "79.0000",
            intraday_quantity: "1.0000",
            pending_buy_quantity: "0.0000",
            pending_sell_quantity: "0.0000",
            pending_exercise_quantity: "0.0000",
            pending_assignment_quantity: "0.0000",
            pending_expiration_quantity: "1.0000",
            opened_at: "2026-08-27T19:22:26.260113Z",
          },
        ],
      },
    });
    expect(p).toEqual({
      optionId: TLT_ID,
      chainId: "644f21f0-a166-4c94-bd67-02568d3a5940",
      chainSymbol: "TLT",
      type: "long",
      quantity: 1,
      intradayQuantity: 1,
      averagePrice: 79,
      intradayAverageOpenPrice: 79,
      expirationDate: "2026-11-20",
      multiplier: 100,
      strikePrice: null, // not in the response — resolved via get_option_instruments
      optionType: null,
      lastPrice: null, // no price either — folded in from a quote
      previousClose: null,
      marketValue: null,
      unrealizedPnl: null,
      pendingQuantity: 1, // exercise + assignment + expiration
    });
  });
});

test("mapOptionInstruments resolves an option_id to its contract", () => {
  const [c] = mapOptionInstruments({
    data: {
      instruments: [
        {
          id: TLT_ID,
          chain_id: "644f21f0-a166-4c94-bd67-02568d3a5940",
          chain_symbol: "TLT",
          underlying_type: "equity",
          expiration_date: "2026-11-20",
          sellout_datetime: "2026-11-20T20:45:00+00:00",
          strike_price: "86.0000",
          type: "call",
          state: "active",
          tradability: "tradable",
          trade_value_multiplier: "100.0000",
          min_ticks: { above_tick: "0.05", below_tick: "0.01", cutoff_price: "3.00" },
        },
      ],
    },
  });
  expect(c).toEqual({
    optionId: TLT_ID,
    chainSymbol: "TLT",
    expirationDate: "2026-11-20",
    strikePrice: 86,
    optionType: "call",
    multiplier: 100,
  });
});

describe("mapOptionQuotes", () => {
  const liveQuote = {
    quote: {
      instrument_id: TLT_ID,
      ask_price: "0.770000",
      ask_size: 1,
      bid_price: "0.760000",
      bid_size: 123,
      break_even_price: "86.770000",
      adjusted_mark_price: "0.770000",
      mark_price: "0.765000",
      previous_close_price: "0.850000",
      previous_close_date: "2026-08-26",
      implied_volatility: "0.099614",
      delta: "0.308245",
      gamma: "0.088061",
      theta: "-0.010901",
      vega: "0.141183",
      open_interest: 28428,
      volume: 259,
      updated_at: "2026-08-27T19:46:28.647347216Z",
    },
    close: {
      instrument_id: TLT_ID,
      symbol: "TLT",
      date: "2026-08-26",
      price: "0.85",
      interpolated: false,
      source: "ddb-market-snapshot",
    },
  };

  test("mark from mark_price, prior close from the official close", () => {
    const [q] = mapOptionQuotes({ data: { results: [liveQuote] } });
    expect(q).toEqual({
      optionId: TLT_ID,
      mark: 0.765,
      bidPrice: 0.76,
      askPrice: 0.77,
      previousClose: 0.85,
      impliedVolatility: 0.099614,
      delta: 0.308245,
      theta: -0.010901,
    });
  });

  test("falls back to the quote's previous_close_price when the close is missing", () => {
    const [q] = mapOptionQuotes({ data: { results: [{ quote: liveQuote.quote }] } });
    expect(q.previousClose).toBe(0.85);
  });
});

// ---- crypto ----

describe("mapCryptoQuotes", () => {
  // Real shape from live get_crypto_quotes (2026-08-31): symbol comes back
  // UNhyphenated; open_price is the prior midnight-ET close.
  const liveQuote = {
    symbol: "BTCUSD",
    id: "3d961844-d360-45fc-989b-f6fca761d511",
    bid_price: "77951.48703514",
    bid_time: "2026-08-31T18:39:00.037-04:00",
    ask_price: "79432.03469233",
    ask_time: "2026-08-31T18:39:01.544-04:00",
    mark_price: "78691.760863735",
    open_price: "77747.085",
    routing: "Market Maker Routing",
    updated_at: "2026-08-31T18:39:01.63-04:00",
  };

  test("maps the live shape: mark, bid/ask, open_price as the previous close", () => {
    const [q] = mapCryptoQuotes({ data: { results: [liveQuote] } });
    expect(q.symbol).toBe("BTCUSD");
    expect(q.mark).toBeCloseTo(78691.760863735);
    expect(q.bidPrice).toBeCloseTo(77951.48703514);
    expect(q.askPrice).toBeCloseTo(79432.03469233);
    expect(q.previousClose).toBeCloseTo(77747.085);
  });
});

describe("mapCryptoPositions", () => {
  // Constructed from the tool's documented field guide (the live account held no
  // crypto when this was written) — verify against a real position when one exists.
  test("asset from currency.code; avg cost from summed direct cost bases", () => {
    const [p] = mapCryptoPositions({
      data: {
        results: [
          {
            currency: { code: "BTC" },
            quantity: "0.003",
            quantity_transferable: "0.002",
            intraday_quantity: "0.001",
            cost_bases: [
              { direct_cost_basis: "160.00", direct_quantity: "0.002" },
              { direct_cost_basis: "0", direct_quantity: "0" },
            ],
          },
        ],
      },
    });
    expect(p.assetCode).toBe("BTC");
    expect(p.quantity).toBe(0.003);
    expect(p.transferableQuantity).toBe(0.002);
    expect(p.avgCost).toBeCloseTo(80000); // $160 over 0.002 BTC — direct buys only
    expect(p.directQuantity).toBe(0.002); // the other 0.001 has no captured basis
    expect(p.intradayQuantity).toBe(0.001);
    expect(p.lastPrice).toBeNull(); // no price in the response — folded from quotes
  });

  test("no cost bases → no average, never NaN", () => {
    const [p] = mapCryptoPositions({
      data: { results: [{ currency: { code: "DOGE" }, quantity: "100" }] },
    });
    expect(p.avgCost).toBeNull();
    expect(p.directQuantity).toBeNull();
  });
});

describe("mapCryptoOrderStatuses", () => {
  // Constructed from the tool's documented response guide — verify against the
  // first real gated crypto order (TODO.md).
  test("maps onto the shared OrderStatus in coin units", () => {
    const [o] = mapCryptoOrderStatuses({
      data: {
        rhs_account_number: "547526228",
        results: [
          {
            id: "order-1",
            currency_code: "BTC",
            currency_pair_id: "3d961844-d360-45fc-989b-f6fca761d511",
            side: "buy",
            type: "limit",
            state: "filled",
            state_group: "closed",
            quantity: "0.00127",
            cumulative_quantity: "0.00127",
            average_price: "78650.00",
            limit_price: "78700.00",
            fee: "0.45",
            initiator_type: "agent",
            created_at: "2026-08-31T18:00:00Z",
            updated_at: "2026-08-31T18:00:05Z",
          },
        ],
      },
    });
    expect(o.id).toBe("order-1");
    expect(o.assetType).toBe("crypto");
    expect(o.symbol).toBe("BTC");
    expect(o.side).toBe("buy");
    expect(o.state).toBe("filled");
    expect(o.quantity).toBe(0.00127);
    expect(o.cumulativeQuantity).toBe(0.00127);
    expect(o.avgPrice).toBe(78650);
    expect(o.limitPrice).toBe(78700);
    expect(o.fees).toBe(0.45);
    expect(o.lastTransactionAt).toBe("2026-08-31T18:00:05Z");
  });

  test("empty response yields no orders", () => {
    expect(mapCryptoOrderStatuses({ data: { results: [] } })).toEqual([]);
  });
});
