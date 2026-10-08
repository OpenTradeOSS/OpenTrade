import type { ParsedOrder } from "@shared/approval";

/** Tool names the `kalshi` MCP server surfaces (`mcp__kalshi__<tool>`). */
export const KALSHI_TOOL_PREFIX = "mcp__kalshi__";

export function isKalshiTool(toolName: string): boolean {
  return toolName.startsWith(KALSHI_TOOL_PREFIX);
}

/**
 * The approval card for a Kalshi order. The input is the agent-facing `place_order` /
 * `cancel_order` shape from `@shared/kalshi-tools` (validated by the host before the
 * card is raised), so unlike the Robinhood parser this is exact, not a lenient guess.
 * `price` is dollars per contract of the named outcome, so the est. cost of a buy is
 * simply `count × price` (the most the order can spend).
 */
export function parseKalshiOrderInput(toolName: string, input: unknown): ParsedOrder {
  const o = (input ?? {}) as Record<string, unknown>;
  const ticker = typeof o.ticker === "string" && o.ticker ? o.ticker.toUpperCase() : null;

  if (toolName === `${KALSHI_TOOL_PREFIX}cancel_order`) {
    const orderId = typeof o.order_id === "string" ? o.order_id : null;
    return {
      kind: "cancel",
      symbol: ticker,
      side: null,
      quantity: null,
      orderType: "cancel",
      limitPrice: null,
      estCost: null,
      cancelsOrderId: orderId,
      instrument: ticker,
      summary: `Cancel Kalshi order${ticker ? ` on ${ticker}` : ""}${orderId ? ` (${orderId})` : ""}`,
    };
  }

  const action = o.action === "sell" ? "sell" : o.action === "buy" ? "buy" : null;
  const outcome = o.outcome === "no" ? "NO" : o.outcome === "yes" ? "YES" : null;
  const count = num(o.count);
  const price = num(o.price);
  const tif = typeof o.time_in_force === "string" ? o.time_in_force : "good_till_canceled";
  const estCost = count != null && price != null ? round2(count * price) : null;
  const instrument = ticker && outcome ? `${ticker} ${outcome}` : ticker;

  const tifLabel = tif === "immediate_or_cancel" ? " IOC" : tif === "fill_or_kill" ? " FOK" : "";
  const summary = [
    "Kalshi",
    action?.toUpperCase(),
    count != null ? fmtCount(count) : null,
    outcome,
    ticker,
    price != null ? `@ ${usd(price)}${tifLabel}` : null,
    estCost != null
      ? `— ${action === "sell" ? "est. proceeds" : "max cost"} ${usd(estCost)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    kind: "place",
    symbol: ticker,
    side: action,
    quantity: count,
    orderType: "limit",
    limitPrice: price,
    estCost,
    cancelsOrderId: null,
    instrument,
    summary,
  };
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
