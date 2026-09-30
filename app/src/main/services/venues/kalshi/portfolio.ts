import type { OrderStatus } from "@shared/broker";
import type { KalshiPortfolio, KalshiPosition } from "@shared/kalshi";

/**
 * Pure mappers from Kalshi Trade API v2 responses to OpenTrade's panel shapes.
 * Field names verified against docs.kalshi.com (GetBalance / GetPositions / GetOrders,
 * 2026-09-30): counts and prices are fixed-point strings (`*_fp`, `*_dollars`), and the
 * balance is integer cents.
 */

type Json = Record<string, unknown>;

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One fill, as `GET /portfolio/fills` returns it (fixed-point strings). */
export interface KalshiFill {
  order_id?: string;
  ticker?: string;
  outcome_side?: string;
  count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  created_time?: string;
  ts?: number;
}

/**
 * Net the agents' fills into open positions, per market, with average-cost accounting.
 * Kalshi nets opposite outcomes (buying NO while holding YES reduces the YES position,
 * exactly as the account's `position_fp` does), so a fill on the other side first closes
 * contracts (releasing their share of the cost basis) and only the remainder opens the
 * new side at its own price. Marked at the held side's current bid.
 */
export function agentPositions(
  fills: KalshiFill[],
  agentByOrder: Map<string, string>,
  marketsByTicker: Map<string, Json>,
): KalshiPosition[] {
  const book = new Map<string, { signed: number; cost: number; agents: Set<string> }>();
  const ordered = [...fills].sort((a, b) => fillTime(a) - fillTime(b));
  for (const f of ordered) {
    const agent = f.order_id ? agentByOrder.get(f.order_id) : undefined;
    const qty = num(f.count_fp);
    if (!agent || !f.ticker || !qty || qty <= 0) continue;
    const yes = f.outcome_side !== "no";
    const price = num(yes ? f.yes_price_dollars : f.no_price_dollars) ?? 0;
    const dir = yes ? 1 : -1;
    const p = book.get(f.ticker) ?? { signed: 0, cost: 0, agents: new Set<string>() };
    p.agents.add(agent);
    if (p.signed === 0 || Math.sign(p.signed) === dir) {
      p.signed += dir * qty;
      p.cost += qty * price;
    } else {
      const held = Math.abs(p.signed);
      const closing = Math.min(qty, held);
      p.cost -= p.cost * (closing / held);
      p.signed += dir * closing;
      const rest = qty - closing;
      if (rest > 0) {
        p.signed = dir * rest;
        p.cost = rest * price;
      }
    }
    book.set(f.ticker, p);
  }

  const out: KalshiPosition[] = [];
  for (const [ticker, p] of book) {
    const contracts = Math.round(Math.abs(p.signed) * 100) / 100;
    if (contracts === 0) continue;
    const side = p.signed > 0 ? "yes" : "no";
    const m = marketsByTicker.get(ticker);
    const mark = num(m?.[side === "yes" ? "yes_bid_dollars" : "no_bid_dollars"]);
    const cost = round2(p.cost);
    const marketValue = mark !== null ? round2(contracts * mark) : null;
    out.push({
      ticker,
      title: typeof m?.title === "string" ? m.title : null,
      side,
      contracts,
      cost,
      mark,
      marketValue,
      unrealizedPnl: marketValue !== null ? round2(marketValue - cost) : null,
      agentIds: [...p.agents],
    });
  }
  return out.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
}

function fillTime(f: KalshiFill): number {
  if (typeof f.ts === "number") return f.ts;
  const t = f.created_time ? Date.parse(f.created_time) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

export function mapPortfolio(
  balanceResp: unknown,
  positions: KalshiPosition[],
  at: number,
): KalshiPortfolio {
  const b = (balanceResp ?? {}) as Json;
  const cents = num(b.balance);
  const cash = num(b.balance_dollars) ?? (cents !== null ? cents / 100 : null);
  const positionsValue = round2(positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0));
  const unrealizedPnl = positions.every((p) => p.unrealizedPnl !== null)
    ? round2(positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0))
    : null;
  return { cash, positionsValue, unrealizedPnl, positions, at };
}

/**
 * A Kalshi order in the shared `OrderStatus` shape, so Activity joins it by order id
 * exactly like a Robinhood ledger order. `side` is "buy" (Kalshi V2 orders express the
 * exposure bought — `outcome_side` — not buy/sell), `symbol` names ticker + outcome,
 * and prices are dollars per contract of that outcome. `state` uses the ledger's
 * vocabulary (`filled` / `partially_filled` / `confirmed` / `cancelled`).
 */
export function mapOrder(o: Json): OrderStatus | null {
  const id = typeof o.order_id === "string" ? o.order_id : null;
  if (!id) return null;
  const outcome = o.outcome_side === "no" ? "no" : "yes";
  const filled = num(o.fill_count_fp) ?? 0;
  const initial = num(o.initial_count_fp);
  const status = String(o.status ?? "");
  const state =
    status === "executed"
      ? "filled"
      : status === "canceled"
        ? filled > 0
          ? "partially_filled_cancelled"
          : "cancelled"
        : filled > 0
          ? "partially_filled"
          : "confirmed";
  const fillCost = (num(o.taker_fill_cost_dollars) ?? 0) + (num(o.maker_fill_cost_dollars) ?? 0);
  const fees = (num(o.taker_fees_dollars) ?? 0) + (num(o.maker_fees_dollars) ?? 0);
  return {
    id,
    symbol: `${String(o.ticker ?? "?")} ${outcome.toUpperCase()}`,
    side: "buy",
    type: "limit",
    state,
    quantity: initial,
    cumulativeQuantity: filled,
    avgPrice: filled > 0 ? round2(fillCost / filled) : null,
    limitPrice: num(o[outcome === "yes" ? "yes_price_dollars" : "no_price_dollars"]),
    fees: round2(fees),
    dollarAmount: null,
    createdAt: typeof o.created_time === "string" ? o.created_time : null,
    lastTransactionAt: typeof o.last_update_time === "string" ? o.last_update_time : null,
  };
}

export function mapOrders(ordersResp: unknown): OrderStatus[] {
  const rows = ((ordersResp as Json | null)?.orders ?? []) as Json[];
  return rows.map(mapOrder).filter((o): o is OrderStatus => o !== null);
}
