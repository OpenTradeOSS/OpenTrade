import type { OrderStatus } from "@shared/broker";
import type {
  HyperliquidBalance,
  HyperliquidPortfolio,
  HyperliquidPosition,
} from "@shared/hyperliquid";

/**
 * Pure mappers from Hyperliquid info responses to OpenTrade's panel shapes. Field names
 * verified against the live API (2026-09-30); every number arrives as a string.
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

const DUST_USD = 0.5;

/** Tokens that are a dollar by construction (Hyperliquid's quote assets). */
const DOLLAR_COINS = new Set(["USDC", "USDT0", "USDH", "USDE"]);

/** `clearinghouseState.assetPositions` → open perp positions (largest first). */
export function mapPositions(state: unknown, mids: Record<string, string>): HyperliquidPosition[] {
  const rows = ((state as Json | null)?.assetPositions ?? []) as { position?: Json }[];
  const out: HyperliquidPosition[] = [];
  for (const row of rows) {
    const p = row.position;
    const szi = num(p?.szi);
    if (!p || typeof p.coin !== "string" || !szi) continue;
    const size = Math.abs(szi);
    const value = num(p.positionValue);
    out.push({
      symbol: p.coin,
      side: szi > 0 ? "long" : "short",
      size,
      entryPrice: num(p.entryPx),
      markPrice: num(mids[p.coin]) ?? (value !== null ? value / size : null),
      positionValue: value,
      unrealizedPnl: num(p.unrealizedPnl),
      marginUsed: num(p.marginUsed),
      leverage: num((p.leverage as Json | undefined)?.value),
      liquidationPrice: num(p.liquidationPx),
    });
  }
  return out.sort((a, b) => (b.positionValue ?? 0) - (a.positionValue ?? 0));
}

/**
 * `spotClearinghouseState.balances` → non-empty balances priced in USD. `priceOf` is
 * the coin's USDC mid (null when nothing quotes it).
 */
export function mapBalances(
  spot: unknown,
  priceOf: (coin: string) => number | null,
): HyperliquidBalance[] {
  const rows = ((spot as Json | null)?.balances ?? []) as Json[];
  const out: HyperliquidBalance[] = [];
  for (const b of rows) {
    const total = num(b.total);
    if (typeof b.coin !== "string" || !total) continue;
    const dollar = DOLLAR_COINS.has(b.coin);
    const price = dollar ? 1 : priceOf(b.coin);
    // Dust left by a sale (a fraction of a cent to a few cents) is noise in the panel.
    if (price !== null && total * price < DUST_USD) continue;
    out.push({
      coin: b.coin,
      total,
      hold: num(b.hold) ?? 0,
      price,
      value: price !== null ? round2(total * price) : null,
      cost: dollar ? null : num(b.entryNtl),
    });
  }
  return out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

/**
 * The account headline. Hyperliquid has two bookkeeping modes:
 *  - default: perps and spot are separate ledgers — equity is the perp account value
 *    plus the spot balances, and `withdrawable` is the perp ledger's;
 *  - unified / portfolio margin: one ledger, where the spot balances ARE the collateral
 *    and the perp ledger's own totals are not meaningful (per the docs). The spot USDC
 *    total already moves with the open positions' P&L (observed live: the USDC `hold`
 *    tracks an isolated position's account value), so equity is just the spot balances,
 *    and free USDC is the part not held as margin or by orders.
 *
 * `states` is the main dex's `clearinghouseState` followed by each builder dex's.
 */
export function mapPortfolio(
  states: unknown[],
  positions: HyperliquidPosition[],
  balances: HyperliquidBalance[],
  mode: string,
  at: number,
): HyperliquidPortfolio {
  const spotValue = balances.reduce((sum, b) => sum + (b.value ?? 0), 0);
  const pnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
  const usdc = balances.find((b) => b.coin === "USDC");
  const ledgers = states.map((s) => (s ?? {}) as Json);
  const sum = (f: (s: Json) => unknown) => ledgers.reduce((t, s) => t + (num(f(s)) ?? 0), 0);
  const perpValue = sum((s) => (s.marginSummary as Json | undefined)?.accountValue);
  return {
    equity: round2(unified ? spotValue : perpValue + spotValue),
    withdrawable: unified
      ? usdc
        ? round2(Math.max(0, usdc.total - usdc.hold))
        : 0
      : round2(sum((s) => s.withdrawable)),
    unrealizedPnl: positions.length ? round2(pnl) : null,
    positions,
    balances,
    at,
  };
}

/** One fill, as `userFills` returns it. */
export interface HyperliquidFill {
  coin?: string;
  px?: string;
  sz?: string;
  oid?: number;
  fee?: string;
  time?: number;
}

/**
 * `historicalOrders` (+ fills, for the average price and fees) → the shared
 * `OrderStatus` ledger shape, so Activity joins a Hyperliquid order by id exactly like
 * a Robinhood one. `state` uses the ledger's vocabulary.
 */
export function mapOrders(
  historical: unknown,
  fills: HyperliquidFill[],
  symbolOf: (coin: string) => string,
): OrderStatus[] {
  const byOid = new Map<number, { qty: number; notional: number; fees: number }>();
  for (const f of fills) {
    const qty = num(f.sz);
    const px = num(f.px);
    if (typeof f.oid !== "number" || !qty || px === null) continue;
    const agg = byOid.get(f.oid) ?? { qty: 0, notional: 0, fees: 0 };
    agg.qty += qty;
    agg.notional += qty * px;
    agg.fees += num(f.fee) ?? 0;
    byOid.set(f.oid, agg);
  }

  const seen = new Set<number>();
  const out: OrderStatus[] = [];
  for (const row of (Array.isArray(historical) ? historical : []) as Json[]) {
    const o = row.order as Json | undefined;
    if (!o || typeof o.oid !== "number" || seen.has(o.oid)) continue; // newest status first
    seen.add(o.oid);
    const fill = byOid.get(o.oid);
    const filled = fill?.qty ?? 0;
    const status = String(row.status ?? "");
    const state =
      status === "filled"
        ? "filled"
        : status === "open" || status === "triggered"
          ? filled > 0
            ? "partially_filled"
            : "confirmed"
          : /reject/i.test(status)
            ? "rejected"
            : filled > 0
              ? "partially_filled_cancelled"
              : "cancelled";
    const type = String(o.orderType ?? "Limit").toLowerCase();
    const triggerPx = o.isTrigger === true ? num(o.triggerPx) : null;
    const at = typeof o.timestamp === "number" ? new Date(o.timestamp).toISOString() : null;
    const updated =
      typeof row.statusTimestamp === "number" ? new Date(row.statusTimestamp).toISOString() : at;
    out.push({
      id: String(o.oid),
      assetType: "crypto",
      symbol: symbolOf(String(o.coin ?? "?")),
      side: o.side === "B" ? "buy" : "sell",
      type,
      state,
      quantity: num(o.origSz),
      cumulativeQuantity: filled,
      avgPrice: fill && fill.qty > 0 ? fill.notional / fill.qty : null,
      limitPrice: type.includes("market") ? null : num(o.limitPx),
      fees: fill ? round2(fill.fees) : null,
      dollarAmount: null,
      createdAt: at,
      lastTransactionAt: updated,
      // "Stop Market" / "Stop Limit" vs "Take Profit Market" / "Take Profit Limit".
      ...(triggerPx !== null
        ? {
            trigger: {
              kind: type.startsWith("take") ? ("tp" as const) : ("sl" as const),
              price: triggerPx,
            },
          }
        : {}),
      ...(o.reduceOnly === true ? { reduceOnly: true } : {}),
    });
  }
  return out;
}
