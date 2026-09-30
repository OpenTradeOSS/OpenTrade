/**
 * The `kalshi` MCP server's tool surface — the single table both sides read:
 *  - the agent-facing stdio server (`src/agent-mcp/kalshi.ts`) lists these to the CLI;
 *  - the host (`services/venues/kalshi`) maps each name onto a signed Kalshi REST call
 *    and routes every `write` through the approval gate.
 *
 * Dependency-free on purpose: it is bundled into the stdio server, which must stay
 * self-contained (see agent-mcp/index.ts).
 *
 * Pricing model exposed to agents: every price is **dollars per contract of the named
 * outcome** (0.01–0.99), and a position pays $1 per contract if its outcome resolves
 * true. The host converts to Kalshi's V2 single-book request (`bid` = long YES,
 * `ask` = long NO, always priced on the YES scale), so agents never deal with it.
 */

export type KalshiToolKind = "read" | "write";

export interface KalshiToolDef {
  name: string;
  kind: KalshiToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP server name; tools surface in the CLIs as `mcp__kalshi__<tool>`. */
export const KALSHI_SERVER = "kalshi";

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const LIMIT = int("Max rows to return (1-1000; default 100).");
const CURSOR = str("Pagination cursor from a previous response's `cursor` field.");

export const KALSHI_TOOLS: readonly KalshiToolDef[] = [
  {
    name: "get_exchange_status",
    kind: "read",
    description: "Whether the Kalshi exchange and trading are currently active.",
    inputSchema: obj({}),
  },
  {
    name: "get_balance",
    kind: "read",
    description:
      "Account cash balance and portfolio value. Kalshi reports both in CENTS (divide by 100 for dollars).",
    inputSchema: obj({}),
  },
  {
    name: "get_positions",
    kind: "read",
    description:
      "Open (unsettled) market positions. `position_fp` > 0 is long YES, < 0 is long NO. Filter by ticker or event.",
    inputSchema: obj({
      ticker: str("Market ticker filter."),
      event_ticker: str("Event ticker filter."),
      settlement_status: {
        type: "string",
        enum: ["unsettled", "settled", "all"],
        description: "Default unsettled.",
      },
      limit: LIMIT,
      cursor: CURSOR,
    }),
  },
  {
    name: "get_orders",
    kind: "read",
    description: "Your orders, newest first. Filter by market/event ticker and status.",
    inputSchema: obj({
      ticker: str("Market ticker filter."),
      event_ticker: str("Event ticker filter."),
      status: { type: "string", enum: ["resting", "canceled", "executed"] },
      limit: LIMIT,
      cursor: CURSOR,
    }),
  },
  {
    name: "get_order",
    kind: "read",
    description: "A single order by id (fill status, remaining count, prices).",
    inputSchema: obj({ order_id: str("The order id.") }, ["order_id"]),
  },
  {
    name: "get_fills",
    kind: "read",
    description: "Your executed fills (trades), newest first.",
    inputSchema: obj({
      ticker: str("Market ticker filter."),
      order_id: str("Only fills of this order."),
      limit: LIMIT,
      cursor: CURSOR,
    }),
  },
  {
    name: "get_settlements",
    kind: "read",
    description: "Settled positions and their payouts.",
    inputSchema: obj({ ticker: str("Market ticker filter."), limit: LIMIT, cursor: CURSOR }),
  },
  {
    name: "get_events",
    kind: "read",
    description:
      "Browse events (a question like 'Fed decision in December' that groups related markets). Set with_nested_markets to include each event's markets and prices.",
    inputSchema: obj({
      series_ticker: str("Only events of this series (e.g. KXFED)."),
      status: { type: "string", enum: ["open", "closed", "settled"] },
      with_nested_markets: { type: "boolean" },
      limit: int("Max rows (1-200; default 100)."),
      cursor: CURSOR,
    }),
  },
  {
    name: "get_event",
    kind: "read",
    description: "One event and its markets.",
    inputSchema: obj(
      {
        event_ticker: str("The event ticker."),
        with_nested_markets: { type: "boolean" },
      },
      ["event_ticker"],
    ),
  },
  {
    name: "get_markets",
    kind: "read",
    description:
      "List markets (each a YES/NO contract) with last price, bid/ask, volume and close time. Filter by event, series, status, or an explicit comma-separated ticker list.",
    inputSchema: obj({
      event_ticker: str("Only markets of this event."),
      series_ticker: str("Only markets of this series."),
      tickers: str("Comma-separated market tickers."),
      status: { type: "string", enum: ["unopened", "open", "closed", "settled"] },
      limit: LIMIT,
      cursor: CURSOR,
    }),
  },
  {
    name: "get_market",
    kind: "read",
    description: "One market by ticker: rules, prices, volume, open interest, close time.",
    inputSchema: obj({ ticker: str("The market ticker.") }, ["ticker"]),
  },
  {
    name: "get_orderbook",
    kind: "read",
    description:
      "Resting bids for YES and for NO on one market. A NO bid at p is equivalent to a YES ask at 1 - p.",
    inputSchema: obj(
      { ticker: str("The market ticker."), depth: int("Price levels per side (0 = all).") },
      ["ticker"],
    ),
  },
  {
    name: "get_trades",
    kind: "read",
    description: "Recent public trades on a market.",
    inputSchema: obj({
      ticker: str("The market ticker."),
      min_ts: int("Unix seconds lower bound."),
      max_ts: int("Unix seconds upper bound."),
      limit: LIMIT,
      cursor: CURSOR,
    }),
  },
  {
    name: "place_order",
    kind: "write",
    description:
      "Place a limit order on a Kalshi market. MOVES REAL MONEY and goes through the user's approval gate. " +
      "`price` is dollars per contract OF THE OUTCOME you name (0.01-0.99): buy yes @ 0.42 costs $0.42 per contract " +
      "and pays $1 if YES resolves; buy no @ 0.58 costs $0.58 and pays $1 if NO resolves. Sell reduces a position you hold. " +
      "Use time_in_force immediate_or_cancel for a marketable order that should not rest.",
    inputSchema: obj(
      {
        ticker: str("The market ticker."),
        action: { type: "string", enum: ["buy", "sell"] },
        outcome: { type: "string", enum: ["yes", "no"] },
        count: { type: "number", description: "Number of contracts (> 0)." },
        price: {
          type: "number",
          description: "Limit price in dollars per contract of `outcome`, 0.01-0.99.",
        },
        time_in_force: {
          type: "string",
          enum: ["good_till_canceled", "immediate_or_cancel", "fill_or_kill"],
          description: "Default good_till_canceled.",
        },
        expiration_time: int(
          "Optional Unix seconds when a good_till_canceled order expires (not with immediate_or_cancel).",
        ),
        post_only: { type: "boolean", description: "Reject instead of taking liquidity." },
        reduce_only: {
          type: "boolean",
          description: "Only reduce an existing position (requires immediate_or_cancel).",
        },
      },
      ["ticker", "action", "outcome", "count", "price"],
    ),
  },
  {
    name: "cancel_order",
    kind: "write",
    description:
      "Cancel a resting order. Goes through the user's approval gate. Pass the market ticker so the cancel routes to the right exchange shard.",
    inputSchema: obj(
      { order_id: str("The order id."), ticker: str("The order's market ticker.") },
      ["order_id", "ticker"],
    ),
  },
];

export const KALSHI_TOOL_BY_NAME: ReadonlyMap<string, KalshiToolDef> = new Map(
  KALSHI_TOOLS.map((t) => [t.name, t]),
);

/** Instructions the server hands the CLI on connect (MCP `initialize.instructions`). */
export const KALSHI_INSTRUCTIONS =
  "Kalshi is a regulated US exchange for event contracts: each market is a YES/NO question that pays $1 per " +
  "contract to the side that resolves true. Tools: get_* are read-only; place_order and cancel_order move real " +
  "money and are paused for the user's approval in OpenTrade (a decline comes back as an error with the " +
  "user's reason: record it and do not blindly retry). Prices you pass and see in place_order are dollars per " +
  "contract of the outcome you name; balances from get_balance are in cents. Discover markets with get_events " +
  "(with_nested_markets) or get_markets, check liquidity with get_orderbook before trading, and confirm fills with " +
  "get_order / get_fills.";
