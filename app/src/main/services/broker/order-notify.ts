import type { OrderStatus } from "@shared/broker";
import type { HostNotification } from "@shared/notify";
import { legsLabel, STANDARD_MULTIPLIER } from "@shared/options";

/**
 * RH lifecycle states that are *absorbing* — an order never leaves them. Matched
 * case-insensitively; an unknown state simply never notifies (fail-quiet). Kept in
 * one place so extending the list is a one-line change.
 */
const TERMINAL_STATES = new Set([
  "filled",
  "rejected",
  "cancelled",
  "canceled",
  "failed",
  "expired",
  "voided",
]);

export function isTerminal(state: string | null): boolean {
  return state !== null && TERMINAL_STATES.has(state.toLowerCase());
}

/**
 * True when `next` has just *entered* a terminal state — i.e. an order-execution
 * notification is due. `prev === undefined` means the order appeared already
 * terminal between polls (genuinely new, worth notifying); a `prev` that was
 * already terminal is suppressed (terminal states are absorbing, so this also
 * dedupes across polls and suppresses the startup full-sweep, which seeds every
 * pre-existing terminal order before the recent-window diff runs).
 */
export function terminalTransition(prev: OrderStatus | undefined, next: OrderStatus): boolean {
  return isTerminal(next.state) && !(prev !== undefined && isTerminal(prev.state));
}

/** Human verb for a terminal state (drives both the title and body). */
function verbFor(state: string | null): string {
  switch ((state ?? "").toLowerCase()) {
    case "filled":
      return "filled";
    case "rejected":
      return "rejected";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    case "voided":
      return "voided";
    default:
      return "failed";
  }
}

/** "2 AAPL" / "$100 AAPL" / "AAPL" / "1 TLT $86C 11/20/26" — quantity clause of the body. */
function quantityClause(o: OrderStatus): string {
  const shares = o.cumulativeQuantity ?? o.quantity;
  const sym = o.assetType === "option" ? legsLabel(o.legs ?? []) : (o.symbol ?? "");
  // Coin quantities go far below equity precision — 6 decimals would round a
  // 1-satoshi (1e-8 BTC) fill to "0 BTC".
  const decimals = o.assetType === "crypto" ? 8 : 6;
  if (shares != null && shares > 0) return `${trimNum(shares, decimals)} ${sym}`.trim();
  if (o.dollarAmount != null && o.dollarAmount > 0)
    return `$${trimNum(o.dollarAmount)} ${sym}`.trim();
  return sym || "order";
}

/** Drop trailing zeros from a fractional quantity/price without losing precision.
 *  String-trimmed (not round-tripped through Number) so tiny coin quantities render
 *  as "0.00000001", never scientific notation. */
function trimNum(n: number, decimals = 6): string {
  return n
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/**
 * Format an order-execution notification. Body reads like
 * `"BUY 2 AAPL — filled at $182.34"`; price is included only for fills (via
 * `avgPrice`). An option fill quotes the per-contract cost (`$79.00`, the
 * per-share price × multiplier — what the account was actually debited per
 * contract). Title is `"<agent> — Order filled"`.
 */
export function orderNotification(
  o: OrderStatus,
  agentName: string | null,
  agentId?: string,
): HostNotification {
  const verb = verbFor(o.state);
  const side = o.side ? o.side.toUpperCase() : "ORDER";
  const perUnit =
    o.avgPrice == null
      ? null
      : o.assetType === "option"
        ? o.avgPrice * (o.multiplier ?? STANDARD_MULTIPLIER)
        : o.avgPrice;
  const priced = verb === "filled" && perUnit != null ? ` at $${trimNum(perUnit)}` : "";
  return {
    kind: "order",
    title: `${agentName ?? "agent"} — Order ${verb}`,
    body: `${side} ${quantityClause(o)} — ${verb}${priced}`,
    agentId,
  };
}
