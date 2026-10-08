import type { ParsedOrder } from "@shared/approval";

/** Tool names the `hyperliquid` MCP server surfaces (`mcp__hyperliquid__<tool>`). */
export const HYPERLIQUID_TOOL_PREFIX = "mcp__hyperliquid__";

export function isHyperliquidTool(toolName: string): boolean {
  return toolName.startsWith(HYPERLIQUID_TOOL_PREFIX);
}

/**
 * The approval card for a Hyperliquid write. The input is the agent-facing tool shape
 * from `@shared/hyperliquid-tools`, validated by the host before the card is raised,
 * (an entry may carry `stop_loss` / `take_profit`, shown on the same card),
 * plus two fields the host adds for the card: `ref_price` (the mid when the card was
 * raised — a market order has no price of its own) and, for `close_position`, the
 * `side`/`size` it resolved from the open position.
 */
export function parseHyperliquidOrderInput(toolName: string, input: unknown): ParsedOrder {
  const o = (input ?? {}) as Record<string, unknown>;
  const tool = toolName.slice(HYPERLIQUID_TOOL_PREFIX.length);
  const symbol = typeof o.symbol === "string" && o.symbol ? o.symbol : null;
  const base = {
    symbol,
    side: null,
    quantity: null,
    orderType: null,
    limitPrice: null,
    estCost: null,
    cancelsOrderId: null,
    assetType: "crypto" as const,
    instrument: symbol,
  };

  if (tool === "cancel_order") {
    const orderId = o.order_id !== undefined && o.order_id !== null ? String(o.order_id) : null;
    return {
      ...base,
      kind: "cancel",
      orderType: "cancel",
      cancelsOrderId: orderId,
      summary: `Cancel Hyperliquid order${symbol ? ` on ${symbol}` : ""}${orderId ? ` (${orderId})` : ""}`,
    };
  }

  if (tool === "set_leverage") {
    const lev = num(o.leverage);
    return {
      ...base,
      kind: "unknown",
      orderType: "leverage",
      summary: `Hyperliquid: set ${symbol ?? "?"} leverage to ${lev ?? "?"}x ${o.cross === false ? "isolated" : "cross"}`,
    };
  }

  const closing = tool === "close_position";
  const side = o.side === "sell" ? "sell" : o.side === "buy" ? "buy" : null;
  const size = num(o.size);
  const isMarket = closing || o.order_type === "market";
  const trigger = num(o.trigger_price);
  const limit = isMarket ? null : num(o.price);
  const ref = limit ?? trigger ?? num(o.ref_price);
  const estCost = size !== null && ref !== null ? round2(size * ref) : null;
  const reduce = closing || o.reduce_only === true;
  const stopLoss = num(o.stop_loss);
  const takeProfit = num(o.take_profit);

  const tif = o.time_in_force === "ioc" ? " IOC" : o.time_in_force === "alo" ? " post-only" : "";
  const priceLabel = isMarket
    ? `@ market${ref !== null && trigger === null ? ` (~${usd(ref)})` : ""}`
    : limit !== null
      ? `@ ${usd(limit)}${tif}`
      : null;
  const summary = [
    "Hyperliquid",
    closing ? "CLOSE" : side?.toUpperCase(),
    closing && side ? `(${side})` : null,
    size !== null ? String(size) : null,
    symbol,
    priceLabel,
    trigger !== null
      ? `${o.trigger_kind === "tp" ? "take-profit" : "stop"} at ${usd(trigger)}`
      : null,
    reduce && !closing ? "reduce-only" : null,
    stopLoss !== null ? `· stop-loss ${usd(stopLoss)}` : null,
    takeProfit !== null ? `· take-profit ${usd(takeProfit)}` : null,
    estCost !== null ? `— ${usd(estCost)} notional` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...base,
    kind: "place",
    side,
    quantity: size,
    orderType:
      trigger !== null
        ? `${o.trigger_kind === "tp" ? "take_profit" : "stop"}_${isMarket ? "market" : "limit"}`
        : isMarket
          ? "market"
          : "limit",
    limitPrice: limit,
    estCost,
    stopPrice: trigger ?? stopLoss,
    takeProfitPrice: takeProfit,
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

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
}
