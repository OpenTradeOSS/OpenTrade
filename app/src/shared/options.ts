import { z } from "zod";

/**
 * An option contract as Robinhood identifies it. Everywhere an option *order* is
 * expressed (tool input, ledger, positions) the contract is referenced by its
 * `option_id` UUID alone — the human-readable identity (underlying, expiry, strike,
 * call/put) comes from `get_option_instruments` (or, for ledger orders, the legs of
 * the order response). Fields are nullable so a partially-resolved contract still
 * renders something rather than nothing.
 */
export const OptionContract = z.object({
  optionId: z.string(),
  chainSymbol: z.string().nullable(),
  /** YYYY-MM-DD. */
  expirationDate: z.string().nullable(),
  strikePrice: z.number().nullable(),
  optionType: z.enum(["call", "put"]).nullable(),
  /** Shares per contract (`trade_value_multiplier`); 100 for a standard contract. */
  multiplier: z.number().nullable(),
});
export type OptionContract = z.infer<typeof OptionContract>;

/** One leg of an option order, as the agent submitted it (plus the resolved contract). */
export const OptionLeg = z.object({
  optionId: z.string(),
  side: z.string().nullable(),
  /** "open" | "close". */
  positionEffect: z.string().nullable(),
  ratioQuantity: z.number().nullable(),
  contract: OptionContract.nullable(),
});
export type OptionLeg = z.infer<typeof OptionLeg>;

export const STANDARD_MULTIPLIER = 100;

/** "86", "86.5", "1,250" — a strike with the trailing zeros RH pads it with dropped. */
function strike(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** "2026-11-20" → "11/20/26". Anything unparsable passes through verbatim. */
export function shortExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`;
}

/**
 * The compact contract line used everywhere a symbol would go for an equity:
 * `TLT $86C 11/20/26`. Degrades field by field — a contract we only know the
 * underlying of reads `TLT option`; one we know nothing about reads `option`.
 */
export function contractLabel(c: OptionContract | null | undefined): string {
  if (!c) return "option";
  const sym = c.chainSymbol ?? "";
  const cp = c.optionType === "call" ? "C" : c.optionType === "put" ? "P" : "";
  const strikePart = c.strikePrice != null ? `$${strike(c.strikePrice)}${cp}` : cp;
  const exp = shortExpiry(c.expirationDate) ?? "";
  const parts = [sym, strikePart, exp].filter(Boolean);
  if (parts.length === 0) return "option";
  if (parts.length === 1 && sym) return `${sym} option`;
  return parts.join(" ");
}

/**
 * The instrument line for a whole order. A single leg is its contract; a multi-leg
 * strategy names the underlying and the leg count (`TLT 2-leg spread`) — the legs
 * themselves are listed separately where there's room.
 */
export function legsLabel(legs: OptionLeg[]): string {
  if (legs.length === 0) return "option";
  if (legs.length === 1) return contractLabel(legs[0].contract);
  const sym = legs.find((l) => l.contract?.chainSymbol)?.contract?.chainSymbol;
  return `${sym ? `${sym} ` : ""}${legs.length}-leg spread`;
}

/** "long_call" → "Long call"; null/empty → null. RH's strategy names are snake_case. */
export function strategyLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  const words = s.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}

/** "buy" + "open" → "Buy to open"; a missing effect gives just the side. */
export function legActionLabel(side: string | null, positionEffect: string | null): string {
  const s = side ? side[0].toUpperCase() + side.slice(1).toLowerCase() : "Order";
  return positionEffect ? `${s} to ${positionEffect.toLowerCase()}` : s;
}
