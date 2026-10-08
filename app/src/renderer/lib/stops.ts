import type { ParsedOrder } from "@shared/approval";
import type { OrderStatus } from "@shared/broker";
import { usd } from "./format";

/**
 * Stop-losses and take-profits in the Activity list.
 *
 * A stop is its own order at the venue — a SELL that waits for a price — so shown
 * naively it is an unexplained sell next to the buy it protects. Two rules fix that:
 *  - a stop placed WITH an entry (Hyperliquid `stop_loss` / `take_profit`) is folded
 *    into the entry's row: the buy shows its stop, and what became of it;
 *  - a stop on its own row is labelled as a stop, and once it fills the row says the
 *    position was sold BECAUSE the stop triggered.
 */

const NAME = { sl: "Stop-loss", tp: "Take-profit" } as const;

function isOpen(o: OrderStatus): boolean {
  return o.state === "confirmed" || o.state === "partially_filled";
}

const isStopOrder = (parsed: ParsedOrder) => /^(stop|take_profit)/.test(parsed.orderType ?? "");

/** An order row that can own protection: its key, what was proposed, and its venue order. */
export interface EntryRef {
  key: string;
  parsed: ParsedOrder | null;
  status: OrderStatus | null;
}

/**
 * Which venue stop / take-profit orders protect which entry. A protecting order is a
 * reduce-only trigger order; it belongs to the most recent entry on the same market,
 * on the opposite side, placed no later than it. That covers both a stop sent WITH the
 * entry and one the agent placed right after as its own order. (The venue returns no
 * id for an attached stop until it activates, so the link is made by these fields.)
 */
export function assignProtection(
  entries: EntryRef[],
  orders: Iterable<OrderStatus>,
): Map<string, OrderStatus[]> {
  const candidates = entries
    .filter(
      (e) =>
        e.parsed?.kind === "place" &&
        !isStopOrder(e.parsed) &&
        e.status?.createdAt &&
        !e.status.trigger &&
        !e.status.reduceOnly,
    )
    .map((e) => ({ e, at: Date.parse(e.status?.createdAt ?? "") }))
    .sort((a, b) => b.at - a.at);
  const out = new Map<string, OrderStatus[]>();
  for (const o of orders) {
    if (!o.trigger || !o.reduceOnly || !o.createdAt) continue;
    const at = Date.parse(o.createdAt);
    const owner = candidates.find(
      (c) => c.at <= at && c.e.status?.symbol === o.symbol && c.e.status?.side !== o.side,
    );
    if (!owner) continue;
    out.set(owner.e.key, [...(out.get(owner.e.key) ?? []), o]);
  }
  return out;
}

/**
 * The entry row's protection line. Once the stop fires it says so (and at what price
 * the position was sold); while it waits it names the live stop; before the venue
 * order is linked it falls back to what the entry was proposed with.
 */
export function protectionNote(
  parsed: ParsedOrder | null,
  protection: OrderStatus[],
): string | null {
  const fired = protection.find((o) => o.state === "filled");
  if (fired) return protectionStage(fired).label;
  const live = protection.filter(isOpen);
  if (live.length > 0) {
    return live
      .map((o) => `${NAME[o.trigger?.kind ?? "sl"]} ${usd(o.trigger?.price ?? null)}`)
      .join(" · ");
  }
  if (protection.length > 0) return protectionStage(protection[protection.length - 1]).label;
  if (!parsed || parsed.kind !== "place" || isStopOrder(parsed)) return null;
  const parts = [
    parsed.stopPrice != null ? `${NAME.sl} ${usd(parsed.stopPrice)}` : null,
    parsed.takeProfitPrice != null ? `${NAME.tp} ${usd(parsed.takeProfitPrice)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** What became of one protecting order, as a timeline line for the entry's row. */
export function protectionStage(o: OrderStatus): { label: string; tone: string } {
  const name = NAME[o.trigger?.kind ?? "sl"];
  const at = usd(o.trigger?.price ?? null);
  if (o.state === "filled" || (o.cumulativeQuantity ?? 0) > 0) {
    const fill =
      o.avgPrice != null
        ? `: ${o.side === "buy" ? "bought" : "sold"} ${o.cumulativeQuantity} at ${usd(o.avgPrice)}`
        : "";
    return {
      label: `${name} triggered at ${at}${fill}`,
      tone: o.trigger?.kind === "tp" ? "bg-success" : "bg-destructive",
    };
  }
  if (isOpen(o)) return { label: `${name} waiting at ${at}`, tone: "bg-warning" };
  if (o.state === "rejected")
    return { label: `${name} at ${at} was rejected`, tone: "bg-destructive" };
  return { label: `${name} at ${at} cancelled`, tone: "bg-muted-foreground/60" };
}

/**
 * The action line for an order that is itself a stop / take-profit:
 * "STOP-LOSS SELL BTC @ $75,000", and once it has filled
 * "SELL BTC · stop-loss triggered at $75,000".
 */
export function triggerAction(
  side: string | null,
  name: string,
  trigger: { kind: "sl" | "tp"; price: number },
  filled: boolean,
): string {
  const s = (side ?? "order").toUpperCase();
  return filled
    ? `${s} ${name} · ${NAME[trigger.kind].toLowerCase()} triggered at ${usd(trigger.price)}`
    : `${NAME[trigger.kind].toUpperCase()} ${s} ${name} @ ${usd(trigger.price)}`;
}

/** The trigger a parsed stop ORDER (not an entry with protection) describes. */
export function parsedTrigger(parsed: ParsedOrder): { kind: "sl" | "tp"; price: number } | null {
  const type = parsed.orderType ?? "";
  if (parsed.stopPrice == null || !isStopOrder(parsed)) return null;
  return { kind: type.startsWith("take_profit") ? "tp" : "sl", price: parsed.stopPrice };
}
