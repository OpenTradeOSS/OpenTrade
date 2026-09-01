import type {
  Account,
  CryptoPosition,
  CryptoQuote,
  OptionContract,
  OptionPosition,
  OptionQuote,
  OrderStatus,
  Portfolio,
  Position,
  Quote,
} from "@shared/broker";
import type { OptionLeg } from "@shared/options";

/**
 * Robinhood Agentic Trading MCP tool names (confirmed live, 2026-06-11) and
 * lenient response mappers. RH wraps results as
 *   { content: [{ type: "text", text: "<json>" }] }
 * and frequently returns numbers as strings, so we unwrap + coerce defensively.
 * Exact non-account field names are best-effort and refined after live testing.
 */
export const RH_TOOLS = {
  getAccounts: "get_accounts",
  getPortfolio: "get_portfolio",
  getEquityPositions: "get_equity_positions",
  getEquityOrders: "get_equity_orders",
  getEquityQuotes: "get_equity_quotes",
  getOptionOrders: "get_option_orders",
  getOptionPositions: "get_option_positions",
  getOptionInstruments: "get_option_instruments",
  getOptionQuotes: "get_option_quotes",
  getCryptoOrders: "get_crypto_orders",
  getCryptoPositions: "get_crypto_positions",
  getCryptoQuotes: "get_crypto_quotes",
  placeEquityOrder: "place_equity_order",
  placeOptionOrder: "place_option_order",
  cancelEquityOrder: "cancel_equity_order",
  cancelOptionOrder: "cancel_option_order",
} as const;

type McpResult = { content?: Array<{ type: string; text?: string }> };

/** Unwrap the MCP text-content envelope into the inner JSON payload. */
export function unwrap(result: unknown): unknown {
  const r = result as McpResult;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) if (rec[k] !== undefined) return rec[k] as T;
  return undefined;
}

function asArray(payload: unknown, ...keys: string[]): unknown[] {
  const data = (pick(payload, "data") ?? payload) as unknown;
  for (const k of keys) {
    const v = pick(data, k);
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(data)) return data;
  return [];
}

export function mapAccounts(payload: unknown): Account[] {
  return asArray(payload, "accounts").map((a) => ({
    accountNumber: String(pick(a, "account_number", "rhs_account_number") ?? ""),
    // The numeric brokerage id crypto tools key on (usually equal to account_number).
    rhsAccountNumber: (pick(a, "rhs_account_number") as string) ?? null,
    type: String(pick(a, "brokerage_account_type", "type") ?? ""),
    agentic: Boolean(pick(a, "agentic_allowed")),
    isDefault: Boolean(pick(a, "is_default")),
  }));
}

export function mapPortfolio(payload: unknown, accountNumber: string): Portfolio {
  const data = (pick(payload, "data") ?? payload) as unknown;
  // buying_power is a nested object ({ buying_power, unleveraged_buying_power, … }),
  // but tolerate a flat number too.
  const bp = pick(data, "buying_power", "buying_power_amount");
  const buyingPower =
    bp && typeof bp === "object"
      ? num(pick(bp, "buying_power", "unleveraged_buying_power"))
      : num(bp);
  return {
    accountNumber,
    // total_value = whole-account value (cash + holdings); equity_value = holdings only.
    equity: num(pick(data, "total_value", "equity", "total_equity")),
    marketValue: num(pick(data, "equity_value", "market_value", "portfolio_market_value")),
    buyingPower,
    cash: num(pick(data, "cash", "uninvested_cash", "cash_available")),
    // Day change isn't in get_portfolio — the poller derives it from quotes.
    dayChange: null,
    dayChangePct: null,
    optionsValue: num(pick(data, "options_value")),
    cryptoValue: num(pick(data, "crypto_value")),
  };
}

export function mapPositions(payload: unknown): Position[] {
  return asArray(payload, "positions", "equity_positions").map((p) => {
    const qty = num(pick(p, "quantity", "shares")) ?? 0;
    const avg = num(pick(p, "average_cost", "average_buy_price", "avg_cost"));
    const last = num(pick(p, "last_price", "price", "mark_price"));
    const mv = num(pick(p, "market_value")) ?? (last !== null ? last * qty : null);
    const pnl = avg !== null && last !== null ? (last - avg) * qty : num(pick(p, "unrealized_pnl"));
    return {
      symbol: String(pick(p, "symbol", "ticker", "chain_symbol") ?? ""),
      quantity: qty,
      intradayQuantity: num(pick(p, "intraday_quantity")),
      averageCost: avg,
      lastPrice: last,
      marketValue: mv,
      unrealizedPnl: pnl,
    };
  });
}

/**
 * Map a `get_equity_orders` envelope into the authoritative OrderStatus[]. The
 * fill fields are taken exactly: `average_price` → avgPrice (VWAP),
 * `cumulative_quantity` → cumulativeQuantity (executed). `price` is the limit
 * price (null for market orders) and is kept as `limitPrice` only. `quantity` is
 * the *ordered* size. `dollar_based_amount` is a nested `{ amount }`.
 */
export function mapOrderStatuses(payload: unknown): OrderStatus[] {
  return asArray(payload, "orders", "equity_orders").map(mapOrderStatus);
}

export function mapOrderStatus(o: unknown): OrderStatus {
  const dollar = pick(o, "dollar_based_amount");
  return {
    id: String(pick(o, "id", "order_id") ?? ""),
    assetType: "equity",
    symbol: (pick(o, "symbol", "chain_symbol") as string) ?? null,
    side: (pick(o, "side", "direction") as string) ?? null,
    type: (pick(o, "type", "order_type") as string) ?? null,
    state: (pick(o, "state", "status") as string) ?? null,
    quantity: num(pick(o, "quantity", "shares")),
    cumulativeQuantity: num(pick(o, "cumulative_quantity", "filled_quantity")),
    avgPrice: num(pick(o, "average_price")),
    limitPrice: num(pick(o, "price", "limit_price")),
    fees: num(pick(o, "fees")),
    dollarAmount: dollar && typeof dollar === "object" ? num(pick(dollar, "amount")) : num(dollar),
    createdAt: (pick(o, "created_at") as string) ?? null,
    lastTransactionAt: (pick(o, "last_transaction_at", "updated_at") as string) ?? null,
  };
}

/**
 * Extract the pagination cursor from a `get_equity_orders` response, if any. RH
 * returns a `next` URL carrying a `cursor` query param; null when there's no
 * further page (the agentic list is small, so this is usually null).
 */
export function nextCursor(payload: unknown): string | null {
  const data = (pick(payload, "data") ?? payload) as unknown;
  const next = pick(data, "next", "next_url");
  if (typeof next !== "string" || !next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    const m = next.match(/[?&]cursor=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

export function mapQuotes(payload: unknown): Quote[] {
  // Each result pairs a live `quote` with the prior-session `close`; the quote
  // fields live one level down under `.quote`.
  return asArray(payload, "results", "quotes").map((r) => {
    const q = (pick(r, "quote") ?? r) as unknown;
    return {
      symbol: String(pick(q, "symbol", "ticker") ?? ""),
      last: num(
        pick(
          q,
          "last_trade_price",
          "last_non_reg_trade_price",
          "last_price",
          "price",
          "mark_price",
        ),
      ),
      previousClose: num(
        pick(q, "adjusted_previous_close", "previous_close", "last_session_close"),
      ),
      askPrice: num(pick(q, "ask_price", "ask")),
      bidPrice: num(pick(q, "bid_price", "bid")),
    };
  });
}

// ---- options ----

/**
 * Map a `get_option_orders` envelope onto the same `OrderStatus` the equity ledger
 * uses, in per-contract/per-share units. Verified against the live response
 * (2026-08-27): `quantity`/`processed_quantity` are contracts, `price` is the limit
 * per share, `premium`/`processed_premium` are net dollars for the whole order, and
 * each leg carries the contract's expiry/strike/type — so the ledger alone can name
 * every contract an order touched, with no instrument lookup.
 */
export function mapOptionOrderStatuses(payload: unknown): OrderStatus[] {
  return asArray(payload, "orders", "option_orders").map(mapOptionOrderStatus);
}

export function mapOptionOrderStatus(o: unknown): OrderStatus {
  const chainSymbol = (pick(o, "chain_symbol") as string) ?? null;
  const multiplier = num(pick(o, "trade_value_multiplier"));
  const legs = mapOrderLegs(pick(o, "legs"), chainSymbol, multiplier);
  const processedQty = num(pick(o, "processed_quantity", "cumulative_quantity"));
  const processedPremium = num(pick(o, "processed_premium"));
  // Executed price per share: net premium over executed contracts (correct for a
  // spread too), else the legs' execution VWAP (a single leg with no premium field).
  let avgPrice: number | null = null;
  if (processedPremium != null && processedQty && multiplier) {
    avgPrice = processedPremium / (processedQty * multiplier);
  } else {
    avgPrice = executionsVwap(pick(o, "legs"));
  }
  const direction = (pick(o, "direction") as string) ?? null;
  return {
    id: String(pick(o, "id", "order_id") ?? ""),
    assetType: "option",
    symbol: chainSymbol,
    // A single leg has a real side; a spread only has a net direction.
    side: legs.length === 1 ? legs[0].side : direction,
    type: (pick(o, "type", "order_type") as string) ?? null,
    state: (pick(o, "state", "status") as string) ?? null,
    quantity: num(pick(o, "quantity")),
    cumulativeQuantity: processedQty,
    avgPrice,
    limitPrice: num(pick(o, "price", "limit_price")),
    fees: num(pick(o, "fees")),
    dollarAmount: null,
    createdAt: (pick(o, "created_at") as string) ?? null,
    // RH sends `last_transaction_at: null` even on a filled option order (verified
    // live), so fall through to `updated_at` on null, not just on absence.
    lastTransactionAt:
      (pick(o, "last_transaction_at") as string | null) ??
      (pick(o, "updated_at") as string | null) ??
      null,
    multiplier,
    direction,
    strategy:
      (pick(o, "opening_strategy") as string) ?? (pick(o, "closing_strategy") as string) ?? null,
    legs,
    premium: num(pick(o, "premium")),
    processedPremium,
  };
}

function mapOrderLegs(
  raw: unknown,
  chainSymbol: string | null,
  multiplier: number | null,
): OptionLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => {
    const optionId = String(pick(l, "option_id", "option") ?? "");
    const type = low(pick(l, "option_type", "type"));
    const contract: OptionContract = {
      optionId,
      chainSymbol,
      expirationDate: (pick(l, "expiration_date") as string) ?? null,
      strikePrice: num(pick(l, "strike_price")),
      optionType: type === "call" || type === "put" ? type : null,
      multiplier,
    };
    return {
      optionId,
      side: low(pick(l, "side")),
      positionEffect: low(pick(l, "position_effect")),
      ratioQuantity: num(pick(l, "ratio_quantity")),
      contract,
    };
  });
}

/** Volume-weighted average of every execution across the legs, per share. */
function executionsVwap(legs: unknown): number | null {
  if (!Array.isArray(legs)) return null;
  let notional = 0;
  let qty = 0;
  for (const l of legs) {
    const ex = pick(l, "executions");
    if (!Array.isArray(ex)) continue;
    for (const e of ex) {
      const p = num(pick(e, "price"));
      const q = num(pick(e, "quantity"));
      if (p == null || q == null) continue;
      notional += p * q;
      qty += q;
    }
  }
  return qty > 0 ? notional / qty : null;
}

/**
 * `get_option_positions` → OptionPosition[]. Positions carry no strike/type (RH:
 * "look up via get_option_instruments") and no price — the poller folds in the
 * resolved contract and a quote. `average_price` is per contract, multiplier
 * included (`79` for a $0.79 contract), and is kept in those units.
 */
export function mapOptionPositions(payload: unknown): OptionPosition[] {
  return asArray(payload, "positions", "option_positions").map((p) => ({
    optionId: String(pick(p, "option_id", "option") ?? ""),
    chainId: (pick(p, "chain_id") as string) ?? null,
    chainSymbol: String(pick(p, "chain_symbol", "symbol") ?? ""),
    type: low(pick(p, "type")),
    quantity: num(pick(p, "quantity")) ?? 0,
    intradayQuantity: num(pick(p, "intraday_quantity")),
    averagePrice: num(pick(p, "average_price")),
    intradayAverageOpenPrice: num(pick(p, "intraday_average_open_price")),
    expirationDate: (pick(p, "expiration_date") as string) ?? null,
    multiplier: num(pick(p, "trade_value_multiplier")),
    strikePrice: null,
    optionType: null,
    lastPrice: null,
    previousClose: null,
    marketValue: null,
    unrealizedPnl: null,
    pendingQuantity: sumNums(
      pick(p, "pending_exercise_quantity"),
      pick(p, "pending_assignment_quantity"),
      pick(p, "pending_expiration_quantity"),
    ),
  }));
}

/** `get_option_instruments` → the contract identity behind each `option_id`. */
export function mapOptionInstruments(payload: unknown): OptionContract[] {
  return asArray(payload, "instruments", "results").map((i) => {
    const type = low(pick(i, "type", "option_type"));
    return {
      optionId: String(pick(i, "id", "option_id") ?? ""),
      chainSymbol: (pick(i, "chain_symbol") as string) ?? null,
      expirationDate: (pick(i, "expiration_date") as string) ?? null,
      strikePrice: num(pick(i, "strike_price")),
      optionType: type === "call" || type === "put" ? type : null,
      multiplier: num(pick(i, "trade_value_multiplier")),
    };
  });
}

/**
 * `get_option_quotes` → per-share quotes. Like equity quotes, each result pairs the
 * live `quote` with an official prior-session `close`; the close is preferred as the
 * day-change reference (RH's guide), falling back to `previous_close_price`.
 */
export function mapOptionQuotes(payload: unknown): OptionQuote[] {
  return asArray(payload, "results", "quotes").map((r) => {
    const q = (pick(r, "quote") ?? r) as unknown;
    const close = pick(r, "close");
    return {
      optionId: String(pick(q, "instrument_id", "option_id", "id") ?? ""),
      mark: num(pick(q, "mark_price", "adjusted_mark_price", "last_trade_price")),
      bidPrice: num(pick(q, "bid_price")),
      askPrice: num(pick(q, "ask_price")),
      previousClose: num(pick(close, "price")) ?? num(pick(q, "previous_close_price")),
      impliedVolatility: num(pick(q, "implied_volatility")),
      delta: num(pick(q, "delta")),
      theta: num(pick(q, "theta")),
    };
  });
}

// ---- crypto ----

/**
 * `get_crypto_orders` → the shared `OrderStatus`, `assetType: "crypto"`. Quantities
 * are coins, prices per coin. Field names follow the tool's documented response
 * (`currency_code`, `cumulative_quantity`, `average_price` VWAP, `fee`,
 * `state_group`); the envelope key is `results`. Built before a live order existed
 * on this account — verify against the first real gated crypto order (TODO.md).
 */
export function mapCryptoOrderStatuses(payload: unknown): OrderStatus[] {
  return asArray(payload, "results", "orders").map((o) => {
    const dollar = pick(o, "dollar_based_amount", "dollar_amount");
    return {
      id: String(pick(o, "id", "order_id") ?? ""),
      assetType: "crypto" as const,
      symbol: (pick(o, "currency_code", "symbol") as string) ?? null,
      side: (pick(o, "side") as string) ?? null,
      type: (pick(o, "type", "order_type") as string) ?? null,
      state: (pick(o, "state", "status") as string) ?? null,
      quantity: num(pick(o, "quantity")),
      cumulativeQuantity: num(pick(o, "cumulative_quantity", "filled_quantity")),
      avgPrice: num(pick(o, "average_price")),
      limitPrice: num(pick(o, "limit_price", "price")),
      fees: num(pick(o, "fee", "fees")),
      dollarAmount:
        dollar && typeof dollar === "object" ? num(pick(dollar, "amount")) : num(dollar),
      createdAt: (pick(o, "created_at") as string) ?? null,
      lastTransactionAt:
        (pick(o, "last_transaction_at") as string | null) ??
        (pick(o, "updated_at") as string | null) ??
        null,
    };
  });
}

/**
 * `get_crypto_positions` → CryptoPosition[]. No price in the response (folded in
 * from quotes at poll time). Per-coin average cost = Σ direct_cost_basis /
 * Σ direct_quantity across `cost_bases` (multi-entry after forks); transfers and
 * rewards carry no basis, so `directQuantity` can trail `quantity`.
 */
export function mapCryptoPositions(payload: unknown): CryptoPosition[] {
  return asArray(payload, "results", "positions").map((p) => {
    const currency = pick(p, "currency");
    let basis = 0;
    let directQty = 0;
    const bases = pick(p, "cost_bases");
    if (Array.isArray(bases)) {
      for (const b of bases) {
        basis += num(pick(b, "direct_cost_basis")) ?? 0;
        directQty += num(pick(b, "direct_quantity")) ?? 0;
        // Best-effort intraday portion; exact field names unverified live.
      }
    }
    return {
      assetCode: String(pick(currency, "code") ?? pick(p, "currency_code", "symbol") ?? ""),
      quantity: num(pick(p, "quantity")) ?? 0,
      transferableQuantity: num(pick(p, "quantity_transferable")),
      avgCost: directQty > 0 ? basis / directQty : null,
      directQuantity: Array.isArray(bases) ? directQty : null,
      intradayQuantity: num(pick(p, "intraday_quantity")),
      lastPrice: null,
      previousClose: null,
      marketValue: null,
      unrealizedPnl: null,
    };
  });
}

/** `get_crypto_quotes` → per-coin quotes; `open_price` is the prior midnight-ET close. */
export function mapCryptoQuotes(payload: unknown): CryptoQuote[] {
  return asArray(payload, "results", "quotes").map((q) => ({
    symbol: String(pick(q, "symbol") ?? ""),
    mark: num(pick(q, "mark_price")),
    bidPrice: num(pick(q, "bid_price")),
    askPrice: num(pick(q, "ask_price")),
    previousClose: num(pick(q, "open_price", "previous_close_price")),
  }));
}

function low(v: unknown): string | null {
  return typeof v === "string" && v ? v.toLowerCase() : null;
}

/** Sum of the numeric inputs, ignoring the unparsable; null when none parsed. */
function sumNums(...vs: unknown[]): number | null {
  let total = 0;
  let any = false;
  for (const v of vs) {
    const n = num(v);
    if (n == null) continue;
    total += n;
    any = true;
  }
  return any ? total : null;
}
