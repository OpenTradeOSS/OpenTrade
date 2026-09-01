import { describe, expect, test } from "bun:test";
import {
  COSMETIC_WRITES,
  GATED_TOOL_MATCHER,
  GATED_TOOLS,
  MONEY_MOVERS,
  PREALLOWED_TOOL_PATTERNS,
  READ_PATTERNS,
} from "./robinhood-tools";

const asRegex = new RegExp(`^${GATED_TOOL_MATCHER}$`);

describe("the gate table", () => {
  test("every money-mover on today's server is present, by name", () => {
    // Pinned literally so gutting the table breaks this test, not just the derived
    // artifacts. Update alongside LAST_VERIFIED when Robinhood ships new ones.
    expect([...MONEY_MOVERS].sort()).toEqual(
      [
        "place_equity_order",
        "cancel_equity_order",
        "place_option_order",
        "cancel_option_order",
        "place_crypto_order",
        "cancel_crypto_order",
        "exercise_option",
        "cancel_option_exercise",
      ].sort(),
    );
    expect(GATED_TOOLS).toEqual(MONEY_MOVERS);
  });

  test("the derived matcher gates every money-mover and nothing else", () => {
    for (const t of MONEY_MOVERS) {
      expect(asRegex.test(`mcp__robinhood__${t}`)).toBe(true);
    }
    for (const name of [
      "get_equity_quotes",
      "get_option_positions",
      "get_crypto_orders",
      "search",
      "run_scan",
      "review_option_order",
      "preview_crypto_order",
      ...COSMETIC_WRITES,
    ]) {
      expect(asRegex.test(`mcp__robinhood__${name}`)).toBe(false);
    }
    // Unknown future tools are deliberately NOT gated (policy: money-movers only).
    expect(asRegex.test("mcp__robinhood__place_futures_order")).toBe(false);
  });

  test("no tool is both gated and pre-allowed", () => {
    for (const t of MONEY_MOVERS) {
      expect(PREALLOWED_TOOL_PATTERNS).not.toContain(`mcp__robinhood__${t}`);
      // No wildcard may swallow a money-mover either (prefix check against `*` rules).
      for (const p of READ_PATTERNS) {
        if (!p.endsWith("*")) continue;
        expect(t.startsWith(p.slice(0, -1))).toBe(false);
      }
    }
  });

  test("simulations and cosmetic writes are pre-allowed", () => {
    expect(PREALLOWED_TOOL_PATTERNS).toContain("mcp__robinhood__review_*");
    expect(PREALLOWED_TOOL_PATTERNS).toContain("mcp__robinhood__preview_*");
    for (const t of COSMETIC_WRITES) {
      expect(PREALLOWED_TOOL_PATTERNS).toContain(`mcp__robinhood__${t}`);
    }
  });
});
