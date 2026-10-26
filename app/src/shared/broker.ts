import { z } from "zod";
import { OptionContract, OptionLeg } from "./options";

export const Account = z.object({
  accountNumber: z.string(),
  /** Numeric brokerage id (`rhs_account_number`) — the key CRYPTO tools take. */
  rhsAccountNumber: z.string().nullable().optional(),
  type: z.string(),
  agentic: z.boolean(),
  isDefault: z.boolean(),
});
export type Account = z.infer<typeof Account>;

export const Portfolio = z.object({
  accountNumber: z.string(),
  equity: z.number().nullable(),
  marketValue: z.number().nullable(),
  buyingPower: z.number().nullable(),
  cash: z.number().nullable(),
  /** Today's account $ move (Σ per-position intraday-aware change); null if unknown. */
  dayChange: z.number().nullable(),
  /** Today's move as a fraction of the prior account value (e.g. 0.0072 = +0.72%). */
  dayChangePct: z.number().nullable(),
  /** Market value of option holdings (RH `options_value`); part of `equity`. Absent on
   *  rows cached before options were modelled. */
  optionsValue: z.number().nullable().optional(),
  /** Market value of crypto holdings (RH `crypto_value`); part of `equity`. */
  cryptoValue: z.number().nullable().optional(),
});
export type Portfolio = z.infer<typeof Portfolio>;

export const Position = z.object({
  symbol: z.string(),
  quantity: z.number(),
  /** Shares acquired today (drives the intraday-aware day-change split). */
  intradayQuantity: z.number().nullable(),
  averageCost: z.number().nullable(),
  lastPrice: z.number().nullable(),
  marketValue: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
});
export type Position = z.infer<typeof Position>;

/**
 * An open option position (`get_option_positions`). Prices follow Robinhood's own
 * units: `averagePrice` is the **per-contract** cost basis *including* the
 * multiplier (a $0.79 contract shows `79`), while `lastPrice`/`previousClose` are
 * **per-share** quotes (`mark_price`, `0.79`) — so market value is
 * `last × multiplier × quantity`. `type` is long/short; a short's P&L is inverted.
 */
export const OptionPosition = z.object({
  optionId: z.string(),
  chainId: z.string().nullable(),
  chainSymbol: z.string(),
  type: z.string().nullable(),
  quantity: z.number(),
  /** Contracts opened today (drives the intraday-aware day-change split). */
  intradayQuantity: z.number().nullable(),
  /** Per-contract cost basis, multiplier included (RH `average_price`). */
  averagePrice: z.number().nullable(),
  /** Per-contract basis of the contracts opened today, multiplier included. */
  intradayAverageOpenPrice: z.number().nullable(),
  expirationDate: z.string().nullable(),
  multiplier: z.number().nullable(),
  /** From the resolved contract; null until `get_option_instruments` has been consulted. */
  strikePrice: z.number().nullable(),
  optionType: z.enum(["call", "put"]).nullable(),
  /** Per-share mark (`mark_price`); null until a quote is folded in. */
  lastPrice: z.number().nullable(),
  /** Per-share prior-session close. */
  previousClose: z.number().nullable(),
  marketValue: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
  /** Contracts queued for exercise/assignment/expiry — RH asks these be surfaced. */
  pendingQuantity: z.number().nullable(),
});
export type OptionPosition = z.infer<typeof OptionPosition>;

/**
 * An open crypto holding (`get_crypto_positions`). Quantities are in coins (never
 * "shares"); prices are folded in from `get_crypto_quotes` at poll time. `avgCost`
 * is per coin, from the summed direct cost bases — transfers/rewards carry no
 * basis, so when `directQuantity < quantity` the average covers only a subset.
 */
export const CryptoPosition = z.object({
  /** Asset code, e.g. "BTC" (RH `currency.code`). */
  assetCode: z.string(),
  quantity: z.number(),
  /** Sellable right now (nets out open sells/holds); RH `quantity_transferable`. */
  transferableQuantity: z.number().nullable(),
  /** Per-coin average cost over direct purchases; null when no basis is captured. */
  avgCost: z.number().nullable(),
  /** Coins with a captured direct cost basis (≤ quantity). */
  directQuantity: z.number().nullable(),
  /** Coins acquired today (best-effort; drives the intraday day-change split). */
  intradayQuantity: z.number().nullable(),
  /** Per-coin mark, folded from the quote. */
  lastPrice: z.number().nullable(),
  /** Prior-day close (midnight-ET boundary, RH `open_price`). */
  previousClose: z.number().nullable(),
  marketValue: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
});
export type CryptoPosition = z.infer<typeof CryptoPosition>;

/**
 * The broker's authoritative view of an order's execution, read from
 * `get_equity_orders` / `get_option_orders` (the agentic ledger). This is the source
 * of truth for the Activity dot — never inferred from our own events. `state` is
 * RH's own status (`filled` / `partially_filled` / `queued` / `cancelled` /
 * `rejected` / …).
 *
 * Fill fields are exact: `avgPrice` is the VWAP (`average_price`) and
 * `cumulativeQuantity` the executed shares (`cumulative_quantity`) — distinct
 * from the *ordered* `quantity` and the limit `limitPrice` (`price`, null for
 * market orders), which is what the old mapper wrongly used.
 *
 * Option orders reuse the same shape in **per-contract, per-share** units — `quantity`
 * is contracts, `avgPrice`/`limitPrice` are per share (`$0.79`) — plus the fields
 * under "options": `multiplier` (100) turns a price into dollars, `legs` names the
 * contracts, `symbol` is the underlying (`chain_symbol`), `side` is the single leg's
 * side or, for a spread, the net `direction` (debit/credit). `assetType` is absent
 * on ledger rows cached before options were modelled — read absent as equity.
 */
export const OrderStatus = z.object({
  id: z.string(),
  assetType: z.enum(["equity", "option", "crypto"]).optional(),
  symbol: z.string().nullable(),
  side: z.string().nullable(),
  /** "market" | "limit" | … (RH `type`). */
  type: z.string().nullable(),
  /** RH lifecycle state, verbatim. */
  state: z.string().nullable(),
  /** Ordered quantity (shares). Null for some dollar-based orders until filled. */
  quantity: z.number().nullable(),
  /** Executed shares so far (drives partial-fill display). */
  cumulativeQuantity: z.number().nullable(),
  /** Volume-weighted average fill price; null until something executes. */
  avgPrice: z.number().nullable(),
  /** Limit price for limit orders; null for market orders. */
  limitPrice: z.number().nullable(),
  fees: z.number().nullable(),
  /** Notional for a dollar-based order ($ amount), else null. */
  dollarAmount: z.number().nullable(),
  createdAt: z.string().nullable(),
  lastTransactionAt: z.string().nullable(),
  // ---- options ----
  /** Shares per contract; null/absent for equities. */
  multiplier: z.number().nullable().optional(),
  /** Net "debit" | "credit" for the whole order. */
  direction: z.string().nullable().optional(),
  /** RH's `opening_strategy` / `closing_strategy` (`long_call`, `call_debit_spread`, …). */
  strategy: z.string().nullable().optional(),
  legs: z.array(OptionLeg).optional(),
  /** Net premium ordered (`premium`, dollars) and executed (`processed_premium`). */
  premium: z.number().nullable().optional(),
  processedPremium: z.number().nullable().optional(),
});
export type OrderStatus = z.infer<typeof OrderStatus>;

export const Quote = z.object({
  symbol: z.string(),
  last: z.number().nullable(),
  previousClose: z.number().nullable(),
  askPrice: z.number().nullable(),
  bidPrice: z.number().nullable(),
});
export type Quote = z.infer<typeof Quote>;

/** A live option-contract quote (`get_option_quotes`), per share. */
export const OptionQuote = z.object({
  optionId: z.string(),
  mark: z.number().nullable(),
  bidPrice: z.number().nullable(),
  askPrice: z.number().nullable(),
  /** The official prior-session close (`results[].close.price`), else RH's `previous_close_price`. */
  previousClose: z.number().nullable(),
  impliedVolatility: z.number().nullable(),
  delta: z.number().nullable(),
  theta: z.number().nullable(),
});
export type OptionQuote = z.infer<typeof OptionQuote>;

/** A live crypto pair quote (`get_crypto_quotes`), per coin. */
export const CryptoQuote = z.object({
  /** Unhyphenated pair symbol as RH returns it ("BTCUSD"); assetCode is the prefix. */
  symbol: z.string(),
  mark: z.number().nullable(),
  bidPrice: z.number().nullable(),
  askPrice: z.number().nullable(),
  /** RH `open_price` — the prior-day close at the midnight-ET boundary. */
  previousClose: z.number().nullable(),
});
export type CryptoQuote = z.infer<typeof CryptoQuote>;

export { OptionContract, OptionLeg };

export const BrokerConnectionStatus = z.enum(["disconnected", "connecting", "connected", "error"]);
export type BrokerConnectionStatus = z.infer<typeof BrokerConnectionStatus>;
