import { describe, expect, test } from "bun:test";
import type { OptionContract } from "@shared/options";
import { enrichCancelParsed, enrichOptionParsed, parseOrderInput, parseOrderResult } from "./parse";

// The exact tool_input a live agent submitted (2026-08-27) — no symbol anywhere.
const TLT_ID = "e9c444cc-5ccc-4dfe-8fd9-64daf22d6338";
const liveOptionInput = {
  account_number: "547526228",
  legs: [{ option_id: TLT_ID, side: "buy", position_effect: "open" }],
  quantity: "1",
  type: "limit",
  price: "0.79",
  time_in_force: "gfd",
  ref_id: "e5a1c8d2-9f4b-4a37-b6e0-8d2c7f1a5b93",
};
const tltCall: OptionContract = {
  optionId: TLT_ID,
  chainSymbol: "TLT",
  expirationDate: "2026-11-20",
  strikePrice: 86,
  optionType: "call",
  multiplier: 100,
};
const contracts = new Map([[TLT_ID, tltCall]]);

describe("parseOrderInput", () => {
  test("limit buy computes est cost and a clean summary", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "aapl",
      side: "buy",
      quantity: 10,
      type: "limit",
      limit_price: "215.00",
    });
    expect(p.kind).toBe("place");
    expect(p.symbol).toBe("AAPL");
    expect(p.side).toBe("buy");
    expect(p.quantity).toBe(10);
    expect(p.orderType).toBe("limit");
    expect(p.limitPrice).toBe(215);
    expect(p.estCost).toBe(2150);
    expect(p.summary).toBe("BUY 10 AAPL @ $215.00 limit — est. $2,150.00");
  });

  test("market sell has no est cost and reads as market", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "TSLA",
      side: "sell",
      quantity: 3,
      type: "market",
    });
    expect(p.orderType).toBe("market");
    expect(p.estCost).toBeNull();
    expect(p.summary).toBe("SELL 3 TSLA @ market");
  });

  test("a bare limit_price infers a limit order", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "MSFT",
      side: "buy",
      quantity: 1,
      limit_price: 400,
    });
    expect(p.orderType).toBe("limit");
  });

  test("dollar-based order surfaces notional in the summary", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "VOO",
      side: "buy",
      amount: 500,
    });
    expect(p.quantity).toBeNull();
    expect(p.estCost).toBe(500);
    expect(p.summary).toBe("BUY $500.00 of VOO @ market");
  });

  test("cancel order is summarized by id and links back via cancelsOrderId", () => {
    const p = parseOrderInput("cancel_equity_order", { order_id: "abc-123" });
    expect(p.kind).toBe("cancel");
    expect(p.cancelsOrderId).toBe("abc-123");
    expect(p.summary).toBe("Cancel order abc-123");
  });

  test("missing fields degrade gracefully, never throw", () => {
    const p = parseOrderInput("place_equity_order", {});
    expect(p.kind).toBe("place");
    expect(p.symbol).toBeNull();
    expect(p.summary).toBe("ORDER ? @ market");
  });
});

describe("parseOrderInput — options", () => {
  test("a live single-leg limit buy: contracts × multiplier, unresolved contract reads 'option'", () => {
    const p = parseOrderInput("mcp__robinhood__place_option_order", liveOptionInput);
    expect(p.kind).toBe("place");
    expect(p.assetType).toBe("option");
    expect(p.side).toBe("buy"); // from the leg, not a top-level field
    expect(p.quantity).toBe(1);
    expect(p.orderType).toBe("limit");
    expect(p.limitPrice).toBe(0.79);
    expect(p.estCost).toBe(79); // $0.79 × 100 × 1 — what the account is actually debited
    expect(p.multiplier).toBe(100);
    expect(p.symbol).toBeNull();
    expect(p.legs?.[0]).toMatchObject({ optionId: TLT_ID, side: "buy", positionEffect: "open" });
    expect(p.summary).toBe("BUY 1 option to open @ $0.79 limit — est. $79.00");
  });

  test("enrichOptionParsed names the contract and the underlying", () => {
    const p = enrichOptionParsed(
      parseOrderInput("mcp__robinhood__place_option_order", liveOptionInput),
      contracts,
    );
    expect(p.symbol).toBe("TLT");
    expect(p.instrument).toBe("TLT $86C 11/20/26");
    expect(p.legs?.[0].contract).toEqual(tltCall);
    expect(p.estCost).toBe(79);
    expect(p.summary).toBe("BUY 1 TLT $86C 11/20/26 to open @ $0.79 limit — est. $79.00");
  });

  test("an unknown id stays unresolved; enrichment never throws or touches equities", () => {
    const raw = parseOrderInput("mcp__robinhood__place_option_order", liveOptionInput);
    expect(enrichOptionParsed(raw, new Map()).summary).toBe(raw.summary);
    const eq = parseOrderInput("place_equity_order", { symbol: "AAPL", side: "buy", quantity: 1 });
    expect(enrichOptionParsed(eq, contracts)).toBe(eq);
  });

  test("market sell-to-close has no estimate; stop orders show the stop", () => {
    const base = {
      legs: [{ option_id: TLT_ID, side: "sell", position_effect: "close" }],
      quantity: 1,
    };
    const mkt = enrichOptionParsed(
      parseOrderInput("place_option_order", { ...base, type: "market" }),
      contracts,
    );
    expect(mkt.side).toBe("sell");
    expect(mkt.estCost).toBeNull();
    expect(mkt.summary).toBe("SELL 1 TLT $86C 11/20/26 to close @ market");

    const stop = enrichOptionParsed(
      parseOrderInput("place_option_order", { ...base, type: "stop_market", stop_price: "0.5" }),
      contracts,
    );
    expect(stop.stopPrice).toBe(0.5);
    expect(stop.summary).toBe("SELL 1 TLT $86C 11/20/26 to close @ market (stop $0.50)");

    const stopLimit = enrichOptionParsed(
      parseOrderInput("place_option_order", {
        ...base,
        type: "stop_limit",
        stop_price: "0.5",
        price: "0.45",
      }),
      contracts,
    );
    expect(stopLimit.estCost).toBe(45);
    expect(stopLimit.summary).toBe(
      "SELL 1 TLT $86C 11/20/26 to close @ $0.45 stop-limit (stop $0.50) — est. $45.00",
    );
  });

  test("a bare price implies limit, as RH defaults it", () => {
    const p = parseOrderInput("place_option_order", { ...liveOptionInput, type: undefined });
    expect(p.orderType).toBe("limit");
    expect(p.estCost).toBe(79);
  });

  test("a spread takes its verb from the net direction and prices the whole strategy", () => {
    const OTHER = "11111111-2222-3333-4444-555555555555";
    const p = enrichOptionParsed(
      parseOrderInput("place_option_order", {
        legs: [
          { option_id: TLT_ID, side: "buy", position_effect: "open" },
          { option_id: OTHER, side: "sell", position_effect: "open" },
        ],
        quantity: "2",
        type: "limit",
        price: "1.20",
        direction: "debit",
      }),
      new Map([
        [TLT_ID, tltCall],
        [OTHER, { ...tltCall, optionId: OTHER, strikePrice: 90 }],
      ]),
    );
    expect(p.side).toBe("debit");
    expect(p.direction).toBe("debit");
    expect(p.legs).toHaveLength(2);
    expect(p.instrument).toBe("TLT 2-leg spread");
    expect(p.estCost).toBe(240); // $1.20 net × 100 × 2
    expect(p.summary).toBe("DEBIT 2 TLT 2-leg spread @ $1.20 net limit — est. $240.00");
  });

  test("an empty option input degrades gracefully", () => {
    const p = parseOrderInput("place_option_order", {});
    expect(p.assetType).toBe("option");
    expect(p.summary).toBe("ORDER option @ market");
  });

  test("exercise_option: contract-resolved card with the cash needed to exercise a call", () => {
    const raw = parseOrderInput("mcp__robinhood__exercise_option", {
      account_number: "547526228",
      option_id: TLT_ID,
      quantity: 2,
      reason: "buying_stocks",
    });
    expect(raw.kind).toBe("exercise");
    expect(raw.assetType).toBe("option");
    expect(raw.summary).toBe("EXERCISE 2 option");
    const p = enrichOptionParsed(raw, contracts);
    expect(p.symbol).toBe("TLT");
    expect(p.estCost).toBe(17200); // $86 strike × 100 × 2 — the cash the exercise commits
    expect(p.summary).toBe("EXERCISE 2 TLT $86C 11/20/26 — est. $17,200.00 to buy shares");
  });

  test("a put exercise with allow_shorts keeps the risk note through enrichment", () => {
    const put = new Map([[TLT_ID, { ...tltCall, optionType: "put" as const }]]);
    const p = enrichOptionParsed(
      parseOrderInput("exercise_option", { option_id: TLT_ID, quantity: 1, allow_shorts: true }),
      put,
    );
    expect(p.estCost).toBeNull(); // a put delivers shares; no cash debit to estimate
    expect(p.summary).toBe("EXERCISE 1 TLT $86P 11/20/26 — may short shares to deliver");
  });

  test("cancel_option_exercise targets the contract, not an order id", () => {
    const p = enrichOptionParsed(
      parseOrderInput("mcp__robinhood__cancel_option_exercise", {
        account_number: "547526228",
        option_id: TLT_ID,
      }),
      contracts,
    );
    expect(p.kind).toBe("cancel");
    expect(p.cancelsOrderId).toBeNull();
    expect(p.summary).toBe("Cancel exercise of TLT $86C 11/20/26");
  });

  test("cancel_option_order is a cancel tagged as an option", () => {
    const p = parseOrderInput("mcp__robinhood__cancel_option_order", {
      account_number: "1",
      order_id: "abc-123",
    });
    expect(p.kind).toBe("cancel");
    expect(p.assetType).toBe("option");
    expect(p.cancelsOrderId).toBe("abc-123");
  });
});

describe("parseOrderInput — crypto", () => {
  test("dollar-notional market buy (the common shape)", () => {
    const p = parseOrderInput("mcp__robinhood__place_crypto_order", {
      rhs_account_number: "547526228",
      symbol: "BTC",
      side: "buy",
      type: "market",
      dollar_amount: "100.00",
    });
    expect(p.kind).toBe("place");
    expect(p.assetType).toBe("crypto");
    expect(p.symbol).toBe("BTC");
    expect(p.estCost).toBe(100);
    expect(p.summary).toBe("BUY $100.00 of BTC @ market");
  });

  test("a pair symbol reads as the bare asset; limit sell in coins", () => {
    const p = parseOrderInput("place_crypto_order", {
      symbol: "ETH-USD",
      side: "sell",
      type: "limit",
      quantity: "0.5",
      limit_price: "2600",
    });
    expect(p.symbol).toBe("ETH");
    expect(p.estCost).toBe(1300);
    expect(p.summary).toBe("SELL 0.5 ETH @ $2,600.00 limit — est. $1,300.00");
  });

  test("stop_loss is a stop-triggered market order; stop_limit carries both prices", () => {
    const stop = parseOrderInput("place_crypto_order", {
      symbol: "BTC",
      side: "sell",
      type: "stop_loss",
      quantity: "0.001",
      stop_price: "70000",
    });
    expect(stop.stopPrice).toBe(70000);
    expect(stop.summary).toBe("SELL 0.001 BTC @ market (stop $70,000.00)");

    const stopLimit = parseOrderInput("place_crypto_order", {
      symbol: "BTC",
      side: "sell",
      type: "stop_limit",
      quantity: "0.001",
      stop_price: "70000",
      limit_price: "69500",
    });
    expect(stopLimit.summary).toBe(
      "SELL 0.001 BTC @ $69,500.00 stop-limit (stop $70,000.00) — est. $69.50",
    );
  });

  test("cancel_crypto_order is a cancel tagged as crypto", () => {
    const p = parseOrderInput("mcp__robinhood__cancel_crypto_order", {
      rhs_account_number: "547526228",
      order_id: "abc-123",
    });
    expect(p.kind).toBe("cancel");
    expect(p.assetType).toBe("crypto");
    expect(p.cancelsOrderId).toBe("abc-123");
  });
});

describe("enrichCancelParsed", () => {
  const bare = parseOrderInput("cancel_equity_order", { order_id: "abc-123" });

  test("an option target names the contract and scales the limit by the multiplier", () => {
    const cancel = parseOrderInput("cancel_option_order", { order_id: "abc-123" });
    const p = enrichCancelParsed(cancel, {
      symbol: "TLT",
      side: "buy",
      quantity: 1,
      orderType: "limit",
      limitPrice: 0.79,
      dollarAmount: null,
      assetType: "option",
      instrument: "TLT $86C 11/20/26",
      multiplier: 100,
    });
    expect(p.summary).toBe("Cancel BUY 1 TLT $86C 11/20/26 @ $0.79 limit");
    expect(p.estCost).toBe(79);
    expect(p.instrument).toBe("TLT $86C 11/20/26");
    expect(p.assetType).toBe("option");
    expect(p.cancelsOrderId).toBe("abc-123");
  });

  test("folds a dollar-based market order into the cancel card", () => {
    const p = enrichCancelParsed(bare, {
      symbol: "net",
      side: "buy",
      quantity: 0,
      orderType: "market",
      limitPrice: null,
      dollarAmount: 5,
    });
    expect(p.summary).toBe("Cancel BUY $5.00 of NET");
    expect(p.symbol).toBe("NET");
    expect(p.side).toBe("buy");
    expect(p.cancelsOrderId).toBe("abc-123"); // link preserved for folding
  });

  test("folds a share limit order with its price", () => {
    const p = enrichCancelParsed(bare, {
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      orderType: "limit",
      limitPrice: 150,
      dollarAmount: null,
    });
    expect(p.summary).toBe("Cancel SELL 10 AAPL @ $150.00 limit");
    expect(p.quantity).toBe(10);
    expect(p.estCost).toBe(1500);
  });

  test("a null target leaves the bare-uuid summary as the fallback", () => {
    const p = enrichCancelParsed(bare, null);
    expect(p.summary).toBe("Cancel order abc-123");
  });

  test("a non-cancel parsed order is returned untouched", () => {
    const place = parseOrderInput("place_equity_order", { symbol: "MSFT", side: "buy" });
    expect(
      enrichCancelParsed(place, {
        symbol: "X",
        side: "sell",
        quantity: 1,
        orderType: "market",
        limitPrice: null,
        dollarAmount: null,
      }),
    ).toBe(place);
  });
});

describe("parseOrderResult", () => {
  test("isError MCP result is rejected with its message", () => {
    const o = parseOrderResult({
      isError: true,
      content: [{ type: "text", text: "Market orders not allowed in extended hours." }],
    });
    expect(o.ok).toBe(false);
    expect(o.message).toBe("Market orders not allowed in extended hours.");
  });

  test("error text without an isError flag is still caught", () => {
    const o = parseOrderResult({
      content: [{ type: "text", text: "Error: market orders are not allowed after hours" }],
    });
    expect(o.ok).toBe(false);
  });

  test("accepted order with id + state reads as ok", () => {
    const o = parseOrderResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            order_id: "6a2c9cb7-aaaa-bbbb-cccc-1234567890ab",
            state: "queued",
          }),
        },
      ],
    });
    expect(o.ok).toBe(true);
    expect(o.orderId).toBe("6a2c9cb7-aaaa-bbbb-cccc-1234567890ab");
  });

  test("a rejected state is a failure even without isError", () => {
    const o = parseOrderResult(JSON.stringify({ id: "x", state: "rejected" }));
    expect(o.ok).toBe(false);
  });

  test("an unclassifiable result is ok:null, never throws", () => {
    const o = parseOrderResult({ content: [{ type: "text", text: "ok" }] });
    expect(o.ok).toBeNull();
    expect(typeof o.at).toBe("number");
  });

  test("a bare uuid in plain text is picked up as the order id", () => {
    const o = parseOrderResult("Submitted order 6a2c9cb7-aaaa-bbbb-cccc-1234567890ab successfully");
    expect(o.orderId).toBe("6a2c9cb7-aaaa-bbbb-cccc-1234567890ab");
    expect(o.ok).toBe(true);
  });

  test("a cancel's `accepted:true` is ok, despite the guide text mentioning rejections", () => {
    // The real RH shape: the guide enumerates states like "rejected"/"failed",
    // which would trip the place-order error heuristic if not handled as a cancel.
    const o = parseOrderResult(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { accepted: true },
              guide:
                "accepted=true means the broker accepted the cancel request. state 'rejected'/'failed' are terminal.",
            }),
          },
        ],
      },
      "mcp__robinhood__cancel_equity_order",
    );
    expect(o.ok).toBe(true);
    expect(o.orderId).toBeNull();
    expect(o.message).toContain("accepted the cancel request");
  });

  test("a cancel with accepted:false is a failure", () => {
    const o = parseOrderResult(
      { content: [{ type: "text", text: JSON.stringify({ data: { accepted: false } }) }] },
      "mcp__robinhood__cancel_equity_order",
    );
    expect(o.ok).toBe(false);
  });

  test("the outcome carries only the link + classification (no fill numbers)", () => {
    const o = parseOrderResult({
      content: [{ type: "text", text: '{"id":"abc","state":"unconfirmed"}' }],
    });
    // Execution status is read live from get_equity_orders, not stored here.
    expect(Object.keys(o).sort()).toEqual(["at", "message", "ok", "orderId"]);
    expect(o.orderId).toBe("abc");
    expect(o.ok).toBe(true);
  });
});
