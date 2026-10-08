import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import type { OrderWire } from "./client";

/** Bad tool input: the agent's to fix, reported before any approval card is raised. */
export class HyperliquidInputError extends Error {}

/** Default cap on how far a market order may fill from the mid (Hyperliquid's own UI uses 8%). */
export const DEFAULT_SLIPPAGE = 0.03;
const MAX_SLIPPAGE = 0.1;
/** Hyperliquid rejects orders worth less than this (in the quote currency). */
export const MIN_ORDER_VALUE = 10;

/** What the order builder needs to know about a market. */
export interface MarketRef {
  symbol: string;
  asset: number;
  szDecimals: number;
  kind: "perp" | "spot";
  /** Current mid price; null when the book is empty. */
  mid: number | null;
}

export function isSpot(symbol: string): boolean {
  return symbol.includes("/");
}

/** The builder-deployed dex a symbol lives on (`xyz:TSLA` → `xyz`), if any. */
export function dexOf(symbol: string): string | undefined {
  const i = symbol.indexOf(":");
  return i > 0 ? symbol.slice(0, i) : undefined;
}

export function symbolArg(args: Record<string, unknown>): string {
  const s = typeof args.symbol === "string" ? args.symbol.trim() : "";
  if (!s) throw new HyperliquidInputError("symbol is required (e.g. BTC, HYPE/USDC, xyz:TSLA).");
  return s;
}

export function positive(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0)
    throw new HyperliquidInputError(`${name} must be a positive number.`);
  return n;
}

export function intArg(v: unknown, name: string): number {
  const n = positive(v, name);
  if (!Number.isInteger(n)) throw new HyperliquidInputError(`${name} must be a whole number.`);
  return n;
}

export function slippageArg(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_SLIPPAGE;
  const n = positive(v, "slippage");
  if (n > MAX_SLIPPAGE) {
    throw new HyperliquidInputError(`slippage is a fraction (0.03 = 3%), at most ${MAX_SLIPPAGE}.`);
  }
  return n;
}

/**
 * The price a market order is sent at. Hyperliquid has no market order type: it is an
 * immediate-or-cancel limit priced through the book, so the limit is the worst price
 * the order may fill at.
 */
export function marketPrice(mid: number, isBuy: boolean, slippage: number): number {
  return mid * (isBuy ? 1 + slippage : 1 - slippage);
}

/**
 * `place_order` args → the wire order. Pure: validates everything the venue would
 * reject outright (so a bad order never raises an approval card) and rounds price and
 * size to the market's tick and lot size — at most 5 significant figures, and the
 * string form Hyperliquid hashes (no trailing zeros).
 */
export function buildOrder(args: Record<string, unknown>, market: MarketRef): OrderWire {
  const isBuy = sideArg(args.side);
  const type = args.order_type ?? "limit";
  if (type !== "limit" && type !== "market") {
    throw new HyperliquidInputError("order_type must be limit or market.");
  }
  const isMarket = type === "market";
  const reduceOnly = args.reduce_only === true;
  if (reduceOnly && market.kind === "spot") {
    throw new HyperliquidInputError("reduce_only applies to perps, not spot.");
  }
  const size = fmt(() => formatSize(positive(args.size, "size"), market.szDecimals), "size");

  const hasTrigger = args.trigger_price !== undefined && args.trigger_price !== null;
  let reference: number;
  let limit: number;
  let t: OrderWire["t"];
  if (hasTrigger) {
    if (args.trigger_kind !== "sl" && args.trigger_kind !== "tp") {
      throw new HyperliquidInputError("trigger_kind (sl or tp) is required with trigger_price.");
    }
    const trigger = positive(args.trigger_price, "trigger_price");
    reference = trigger;
    limit = isMarket
      ? marketPrice(trigger, isBuy, slippageArg(args.slippage))
      : positive(args.price, "price");
    t = {
      trigger: {
        isMarket,
        triggerPx: price(trigger, market),
        tpsl: args.trigger_kind,
      },
    };
  } else if (isMarket) {
    if (market.mid === null) {
      throw new HyperliquidInputError(
        `${market.symbol} has no mid price right now; use a limit order.`,
      );
    }
    reference = market.mid;
    limit = marketPrice(market.mid, isBuy, slippageArg(args.slippage));
    t = { limit: { tif: "Ioc" } };
  } else {
    limit = positive(args.price, "price");
    reference = limit;
    t = { limit: { tif: tifArg(args.time_in_force) } };
  }

  const value = Number(size) * reference;
  if (value < MIN_ORDER_VALUE && !reduceOnly) {
    throw new HyperliquidInputError(
      `Order value is $${value.toFixed(2)}; Hyperliquid's minimum is $${MIN_ORDER_VALUE}.`,
    );
  }
  return { a: market.asset, b: isBuy, p: price(limit, market), s: size, r: reduceOnly, t };
}

/**
 * The stop-loss / take-profit attached to an entry (`stop_loss`, `take_profit`), as the
 * child orders of a `normalTpsl` group: reduce-only market triggers on the opposite
 * side, sized to the entry. Hyperliquid activates them when the entry fills and cancels
 * them if it is cancelled. Validated against the entry price so a stop on the wrong
 * side (which would fire immediately) never reaches the venue.
 */
export function buildProtection(
  args: Record<string, unknown>,
  market: MarketRef,
  entry: OrderWire,
): OrderWire[] {
  const has = (v: unknown) => v !== undefined && v !== null;
  if (!has(args.stop_loss) && !has(args.take_profit)) return [];
  if (market.kind === "spot") {
    throw new HyperliquidInputError("stop_loss / take_profit attach to perp orders, not spot.");
  }
  if ("trigger" in entry.t || entry.r) {
    throw new HyperliquidInputError(
      "stop_loss / take_profit attach to an entry order, not to a trigger or reduce-only order.",
    );
  }
  const isBuy = entry.b;
  const ref = args.order_type === "market" ? market.mid : Number(entry.p);
  const out: OrderWire[] = [];
  // Hyperliquid's order: take-profit first, then stop-loss.
  for (const [key, tpsl] of [
    ["take_profit", "tp"],
    ["stop_loss", "sl"],
  ] as const) {
    if (!has(args[key])) continue;
    const trigger = positive(args[key], key);
    // A long is stopped out below its entry and takes profit above; a short mirrors it.
    const mustBeBelow = (tpsl === "sl") === isBuy;
    if (ref !== null && (mustBeBelow ? trigger >= ref : trigger <= ref)) {
      throw new HyperliquidInputError(
        `${key} must be ${mustBeBelow ? "below" : "above"} the entry price (${ref}) for a ${isBuy ? "buy" : "sell"}.`,
      );
    }
    out.push({
      a: market.asset,
      b: !isBuy,
      p: price(marketPrice(trigger, !isBuy, DEFAULT_SLIPPAGE), market),
      s: entry.s,
      r: true,
      t: { trigger: { isMarket: true, triggerPx: price(trigger, market), tpsl } },
    });
  }
  return out;
}

function price(px: number, market: MarketRef): string {
  return fmt(() => formatPrice(px, market.szDecimals, market.kind), "price");
}

/** The SDK's formatters throw when a value rounds to zero; surface that as input error. */
function fmt(fn: () => string, name: string): string {
  try {
    return fn();
  } catch {
    throw new HyperliquidInputError(`${name} is too small for this market's precision.`);
  }
}

function sideArg(v: unknown): boolean {
  if (v === "buy") return true;
  if (v === "sell") return false;
  throw new HyperliquidInputError("side must be buy or sell.");
}

function tifArg(v: unknown): "Gtc" | "Ioc" | "Alo" {
  if (v === undefined || v === null || v === "gtc") return "Gtc";
  if (v === "ioc") return "Ioc";
  if (v === "alo") return "Alo";
  throw new HyperliquidInputError("time_in_force must be gtc, ioc, or alo.");
}
