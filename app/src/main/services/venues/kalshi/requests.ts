import { KALSHI_TOOL_BY_NAME } from "@shared/kalshi-tools";

/** A Kalshi REST call, relative to the `/trade-api/v2` base. */
export interface KalshiRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Bad agent input — reported back to the agent, never raised as an approval card. */
export class KalshiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KalshiInputError";
  }
}

/**
 * Map a `kalshi` MCP tool call (the agent-facing shape in `@shared/kalshi-tools`) onto
 * a Kalshi Trade API v2 request. Pure and synchronous so it can validate a write
 * BEFORE the approval card goes up — a malformed order must fail fast rather than ask
 * the user to approve something that cannot be sent.
 */
export function buildKalshiRequest(tool: string, args: Record<string, unknown>): KalshiRequest {
  if (!KALSHI_TOOL_BY_NAME.has(tool)) throw new KalshiInputError(`unknown tool: ${tool}`);
  switch (tool) {
    case "get_exchange_status":
      return { method: "GET", path: "/exchange/status" };
    case "get_balance":
      return { method: "GET", path: "/portfolio/balance" };
    case "get_positions":
      return {
        method: "GET",
        path: "/portfolio/positions",
        query: pickQuery(args, ["ticker", "event_ticker", "settlement_status", "limit", "cursor"]),
      };
    case "get_orders":
      return {
        method: "GET",
        path: "/portfolio/orders",
        query: pickQuery(args, ["ticker", "event_ticker", "status", "limit", "cursor"]),
      };
    case "get_order":
      return { method: "GET", path: `/portfolio/orders/${seg(args, "order_id")}` };
    case "get_fills":
      return {
        method: "GET",
        path: "/portfolio/fills",
        query: pickQuery(args, ["ticker", "order_id", "limit", "cursor"]),
      };
    case "get_settlements":
      return {
        method: "GET",
        path: "/portfolio/settlements",
        query: pickQuery(args, ["ticker", "limit", "cursor"]),
      };
    case "get_events":
      return {
        method: "GET",
        path: "/events",
        query: pickQuery(args, [
          "series_ticker",
          "status",
          "with_nested_markets",
          "limit",
          "cursor",
        ]),
      };
    case "get_event":
      return {
        method: "GET",
        path: `/events/${seg(args, "event_ticker")}`,
        query: pickQuery(args, ["with_nested_markets"]),
      };
    case "get_markets":
      return {
        method: "GET",
        path: "/markets",
        query: pickQuery(args, [
          "event_ticker",
          "series_ticker",
          "tickers",
          "status",
          "limit",
          "cursor",
        ]),
      };
    case "get_market":
      return { method: "GET", path: `/markets/${seg(args, "ticker")}` };
    case "get_orderbook":
      return {
        method: "GET",
        path: `/markets/${seg(args, "ticker")}/orderbook`,
        query: pickQuery(args, ["depth"]),
      };
    case "get_trades":
      return {
        method: "GET",
        path: "/markets/trades",
        query: pickQuery(args, ["ticker", "min_ts", "max_ts", "limit", "cursor"]),
      };
    case "place_order":
      return { method: "POST", path: "/portfolio/events/orders", body: placeOrderBody(args) };
    case "cancel_order":
      return {
        method: "DELETE",
        path: `/portfolio/events/orders/${seg(args, "order_id")}`,
        // Required for auto-routing to the right exchange shard (an id alone can't).
        query: { market_ticker: requireStr(args, "ticker") },
      };
    default:
      throw new KalshiInputError(`unmapped tool: ${tool}`);
  }
}

/**
 * The V2 create-order body. Kalshi's V2 book is single-sided on the YES scale:
 * `bid` = long YES, `ask` = long NO, and `price` is always the YES price. Agents speak
 * in (action, outcome, price-of-that-outcome), so:
 *
 *   buy  yes @ p → bid @ p        sell yes @ p → ask @ p
 *   buy  no  @ p → ask @ 1 - p    sell no  @ p → bid @ 1 - p
 *
 * (Selling NO at p is the same exposure change as buying YES at 1 - p.) The host adds
 * `client_order_id` after approval, so the approved input stays exactly what the
 * agent sent.
 */
export function placeOrderBody(args: Record<string, unknown>): Record<string, unknown> {
  const ticker = requireStr(args, "ticker");
  const action = args.action;
  const outcome = args.outcome;
  if (action !== "buy" && action !== "sell") throw new KalshiInputError("action must be buy|sell");
  if (outcome !== "yes" && outcome !== "no") throw new KalshiInputError("outcome must be yes|no");

  const count = Number(args.count);
  if (!Number.isFinite(count) || count <= 0) throw new KalshiInputError("count must be > 0");
  const price = Number(args.price);
  if (!Number.isFinite(price) || price < 0.01 || price > 0.99) {
    throw new KalshiInputError("price must be between 0.01 and 0.99 dollars");
  }

  const longYes = (action === "buy") === (outcome === "yes");
  const yesPrice = outcome === "yes" ? price : 1 - price;
  const tif = args.time_in_force ?? "good_till_canceled";
  if (tif !== "good_till_canceled" && tif !== "immediate_or_cancel" && tif !== "fill_or_kill") {
    throw new KalshiInputError(
      "time_in_force must be good_till_canceled|immediate_or_cancel|fill_or_kill",
    );
  }

  const body: Record<string, unknown> = {
    ticker,
    side: longYes ? "bid" : "ask",
    count: count.toFixed(2),
    price: yesPrice.toFixed(4),
    time_in_force: tif,
    self_trade_prevention_type: "taker_at_cross",
  };
  if (args.expiration_time != null) {
    const exp = Number(args.expiration_time);
    if (!Number.isInteger(exp) || exp <= 0)
      throw new KalshiInputError("expiration_time must be unix seconds");
    body.expiration_time = exp;
  }
  if (typeof args.post_only === "boolean") body.post_only = args.post_only;
  if (typeof args.reduce_only === "boolean") body.reduce_only = args.reduce_only;
  return body;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new KalshiInputError(`${key} is required`);
  return v.trim();
}

/** A required path segment, URL-encoded so an id can never rewrite the path. */
function seg(args: Record<string, unknown>, key: string): string {
  return encodeURIComponent(requireStr(args, key));
}

function pickQuery(args: Record<string, unknown>, keys: string[]): Record<string, string> {
  const q: Record<string, string> = {};
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    q[k] = String(v);
  }
  return q;
}
