/**
 * The `hyperliquid` MCP server's tool surface — the single table both sides read:
 *  - the agent-facing stdio server (`src/agent-mcp/hyperliquid.ts`) lists these to the CLI;
 *  - the host (`services/venues/hyperliquid`) runs each one — reads as public queries on
 *    the account, writes as actions signed with the vault's API wallet key, after the
 *    approval gate.
 *
 * Dependency-free on purpose: it is bundled into the stdio server, which must stay
 * self-contained (see agent-mcp/index.ts).
 *
 * Agents name markets by SYMBOL and the host resolves ids, tick and lot sizes:
 *  - perps: the coin (`BTC`, `ETH`, `SOL`);
 *  - spot: `BASE/QUOTE` (`HYPE/USDC`) — bridged majors carry a `U` prefix (`UBTC/USDC`,
 *    `UETH/USDC`, `USOL/USDC`);
 *  - builder-deployed perp dexs: `dex:NAME` (`xyz:TSLA`).
 * Sizes are in the base coin, prices in the quote (USD).
 */

export type HyperliquidToolKind = "read" | "write";

export interface HyperliquidToolDef {
  name: string;
  kind: HyperliquidToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP server name; tools surface in the CLIs as `mcp__hyperliquid__<tool>`. */
export const HYPERLIQUID_SERVER = "hyperliquid";

function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: "string", description });
const numb = (description: string) => ({ type: "number", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
const SYMBOL = str(
  "Market symbol: `BTC` (perp), `HYPE/USDC` (spot), or `xyz:TSLA` (builder dex perp).",
);

export const HYPERLIQUID_TOOLS: readonly HyperliquidToolDef[] = [
  {
    name: "get_account",
    kind: "read",
    description:
      "The trading account: total equity, withdrawable USDC, margin used, every open perp position (size, entry, mark, unrealized P&L, leverage, liquidation price) and every spot balance.",
    inputSchema: obj({}),
  },
  {
    name: "get_markets",
    kind: "read",
    description:
      "Perp markets with live context: mark/mid/oracle price, funding rate (hourly), open interest, 24h volume, max leverage, size decimals. Pass `symbols` to narrow (the full list is ~200 rows), or `dex` for a builder-deployed dex.",
    inputSchema: obj({
      symbols: { type: "array", items: { type: "string" }, description: "Perp names to keep." },
      dex: str("Builder-deployed perp dex name (e.g. `xyz`). Omit for the main dex."),
    }),
  },
  {
    name: "get_spot_markets",
    kind: "read",
    description:
      "Spot pairs with live context: mark/mid price, 24h volume, size decimals. Pass `symbols` (`HYPE/USDC`) to narrow.",
    inputSchema: obj({
      symbols: { type: "array", items: { type: "string" }, description: "Pairs to keep." },
    }),
  },
  {
    name: "get_mids",
    kind: "read",
    description: "Current mid prices. Pass `symbols` to narrow; omit for every perp and spot pair.",
    inputSchema: obj({
      symbols: { type: "array", items: { type: "string" }, description: "Symbols to keep." },
    }),
  },
  {
    name: "get_orderbook",
    kind: "read",
    description:
      "L2 order book for a market: best `depth` bid and ask levels (price, size, orders).",
    inputSchema: obj({ symbol: SYMBOL, depth: int("Levels per side (1-20; default 10).") }, [
      "symbol",
    ]),
  },
  {
    name: "get_candles",
    kind: "read",
    description: "OHLCV candles for a market, oldest first.",
    inputSchema: obj(
      {
        symbol: SYMBOL,
        interval: {
          type: "string",
          enum: ["1m", "5m", "15m", "1h", "4h", "1d"],
          description: "Candle width.",
        },
        count: int("How many candles back from now (1-500; default 100)."),
      },
      ["symbol", "interval"],
    ),
  },
  {
    name: "get_open_orders",
    kind: "read",
    description:
      "Resting orders on the account: order id, symbol, side, price, size, original size, type, reduce-only, trigger details.",
    inputSchema: obj({}),
  },
  {
    name: "get_order",
    kind: "read",
    description: "One order's status (open / filled / canceled / rejected …) by order id.",
    inputSchema: obj({ order_id: int("The order id (`oid`).") }, ["order_id"]),
  },
  {
    name: "get_fills",
    kind: "read",
    description:
      "Recent fills, newest first: symbol, side, price, size, fee, closed P&L, order id, time.",
    inputSchema: obj({ limit: int("Max rows (1-500; default 50).") }),
  },
  {
    name: "place_order",
    kind: "write",
    description:
      "Place an order. Goes through the user's approval gate. `limit` rests at `price` (`time_in_force`: gtc, ioc, or alo = post-only). `market` fills immediately at up to `slippage` from the mid. Protect a perp entry by passing `stop_loss` (and/or `take_profit`) on the same call: the stop is placed with the entry, sized to it, and cancelled if the entry is. To add a stop to a position you already hold, send a separate reduce-only order with `trigger_price` + `trigger_kind` (sl or tp). Minimum order value is $10. The host rounds price and size to the market's tick and lot size.",
    inputSchema: obj(
      {
        symbol: SYMBOL,
        side: { type: "string", enum: ["buy", "sell"], description: "buy = long, sell = short." },
        size: numb("Size in the base coin (e.g. 0.01 BTC)."),
        order_type: { type: "string", enum: ["limit", "market"], description: "Default limit." },
        price: numb("Limit price in USD. Required for limit orders."),
        time_in_force: {
          type: "string",
          enum: ["gtc", "ioc", "alo"],
          description: "Limit orders only. Default gtc.",
        },
        reduce_only: bool("Only reduce an existing position (perps). Default false."),
        slippage: numb("Market orders: max slippage from mid as a fraction (default 0.03 = 3%)."),
        stop_loss: numb(
          "Perps: attach a stop-loss to this entry — a reduce-only market order for the same size that fires when the mark crosses this price (below entry for a buy, above for a sell). Shown on the order in OpenTrade.",
        ),
        take_profit: numb(
          "Perps: attach a take-profit the same way (above entry for a buy, below for a sell).",
        ),
        trigger_price: numb("Make this a trigger order that activates at this mark price."),
        trigger_kind: {
          type: "string",
          enum: ["sl", "tp"],
          description: "Stop-loss or take-profit. Required with trigger_price.",
        },
      },
      ["symbol", "side", "size"],
    ),
  },
  {
    name: "close_position",
    kind: "write",
    description:
      "Close an open perp position at market (reduce-only), fully or by `size`. Goes through the user's approval gate.",
    inputSchema: obj(
      {
        symbol: SYMBOL,
        size: numb("Coin amount to close. Omit to close the whole position."),
        slippage: numb("Max slippage from mid as a fraction (default 0.03)."),
      },
      ["symbol"],
    ),
  },
  {
    name: "cancel_order",
    kind: "write",
    description: "Cancel a resting order. Goes through the user's approval gate.",
    inputSchema: obj({ symbol: SYMBOL, order_id: int("The order id (`oid`).") }, [
      "symbol",
      "order_id",
    ]),
  },
  {
    name: "set_leverage",
    kind: "write",
    description:
      "Set the leverage for a perp market (cross or isolated). Applies to the open position too. Goes through the user's approval gate.",
    inputSchema: obj(
      {
        symbol: SYMBOL,
        leverage: int("Leverage multiple (1 up to the market's max)."),
        cross: bool("Cross margin (default true) or isolated."),
      },
      ["symbol", "leverage"],
    ),
  },
];

export const HYPERLIQUID_TOOL_BY_NAME: ReadonlyMap<string, HyperliquidToolDef> = new Map(
  HYPERLIQUID_TOOLS.map((t) => [t.name, t]),
);

/** Instructions the server hands the CLI on connect (MCP `initialize.instructions`). */
export const HYPERLIQUID_INSTRUCTIONS =
  "Hyperliquid is an on-chain exchange for perpetual futures and spot crypto, margined in USDC. Tools: get_* are " +
  "read-only; place_order, close_position, cancel_order and set_leverage act on a real account and are paused for " +
  "the user's approval in OpenTrade (a decline comes back as an error with the user's reason: record it and do " +
  "not blindly retry). Name markets by symbol: `BTC` for a perp, `HYPE/USDC` for spot, `xyz:TSLA` for a builder " +
  "dex perp. Always pass stop_loss on a leveraged entry unless the user's strategy says otherwise. Spot BTC/ETH/SOL are the bridged tokens UBTC/USDC, UETH/USDC, USOL/USDC. Sizes are in the base coin, prices in USD; orders under $10 are rejected. Perps are leveraged and " +
  "can be liquidated: check get_account (equity, leverage, liquidation price) and get_orderbook before trading, " +
  "and confirm with get_order / get_fills. Funding is paid hourly between longs and shorts. You cannot deposit, " +
  "withdraw or transfer funds.";
