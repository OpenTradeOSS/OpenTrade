import { describe, expect, test } from "bun:test";
import {
  contractLabel,
  legActionLabel,
  legsLabel,
  type OptionContract,
  shortExpiry,
  strategyLabel,
} from "./options";

const tlt: OptionContract = {
  optionId: "e9c444cc-5ccc-4dfe-8fd9-64daf22d6338",
  chainSymbol: "TLT",
  expirationDate: "2026-11-20",
  strikePrice: 86,
  optionType: "call",
  multiplier: 100,
};

describe("contractLabel", () => {
  test("full contract reads symbol $strikeC/P M/D/YY", () => {
    expect(contractLabel(tlt)).toBe("TLT $86C 11/20/26");
    expect(contractLabel({ ...tlt, optionType: "put", strikePrice: 86.5 })).toBe(
      "TLT $86.5P 11/20/26",
    );
  });
  test("degrades field by field, never to an empty string", () => {
    expect(contractLabel({ ...tlt, strikePrice: null, optionType: null })).toBe("TLT 11/20/26");
    expect(
      contractLabel({ ...tlt, strikePrice: null, optionType: null, expirationDate: null }),
    ).toBe("TLT option");
    expect(
      contractLabel({
        ...tlt,
        chainSymbol: null,
        strikePrice: null,
        optionType: null,
        expirationDate: null,
      }),
    ).toBe("option");
    expect(contractLabel(null)).toBe("option");
  });
});

test("shortExpiry", () => {
  expect(shortExpiry("2026-11-20")).toBe("11/20/26");
  expect(shortExpiry("2027-01-05")).toBe("1/5/27");
  expect(shortExpiry("weird")).toBe("weird");
  expect(shortExpiry(null)).toBeNull();
});

describe("legsLabel", () => {
  const leg = (c: OptionContract | null) => ({
    optionId: c?.optionId ?? "x",
    side: "buy",
    positionEffect: "open",
    ratioQuantity: 1,
    contract: c,
  });
  test("single leg is its contract", () => {
    expect(legsLabel([leg(tlt)])).toBe("TLT $86C 11/20/26");
    expect(legsLabel([leg(null)])).toBe("option");
  });
  test("multi-leg names the underlying and leg count", () => {
    expect(legsLabel([leg(tlt), leg({ ...tlt, strikePrice: 90 })])).toBe("TLT 2-leg spread");
    expect(legsLabel([leg(null), leg(null)])).toBe("2-leg spread");
  });
  test("no legs", () => {
    expect(legsLabel([])).toBe("option");
  });
});

test("strategyLabel / legActionLabel humanize RH's snake_case", () => {
  expect(strategyLabel("long_call")).toBe("Long call");
  expect(strategyLabel("call_debit_spread")).toBe("Call debit spread");
  expect(strategyLabel(null)).toBeNull();
  expect(legActionLabel("buy", "open")).toBe("Buy to open");
  expect(legActionLabel("sell", "close")).toBe("Sell to close");
  expect(legActionLabel("sell", null)).toBe("Sell");
  expect(legActionLabel(null, null)).toBe("Order");
});
