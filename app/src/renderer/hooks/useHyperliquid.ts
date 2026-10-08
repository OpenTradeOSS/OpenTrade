import type { OrderStatus } from "@shared/broker";
import { useMemo } from "react";
import { trpc } from "../lib/trpc";

/** Hyperliquid connection state (off / connecting / connected / error), kept live. */
export function useHyperliquidStatus() {
  const utils = trpc.useUtils();
  const query = trpc.hyperliquid.status.useQuery();
  trpc.hyperliquid.onStatus.useSubscription(undefined, {
    onData: (s) => utils.hyperliquid.status.setData(undefined, s),
  });
  return query.data;
}

/** The Hyperliquid account view (equity, positions, balances), refreshed on every host poll. */
export function useHyperliquidPortfolio() {
  const utils = trpc.useUtils();
  const query = trpc.hyperliquid.portfolio.useQuery();
  trpc.hyperliquid.onUpdated.useSubscription(undefined, {
    onData: () => utils.hyperliquid.portfolio.invalidate(),
  });
  return query.data ?? null;
}

/** Recent Hyperliquid orders keyed by id, in the ledger shape Activity joins on. */
export function useHyperliquidOrders(): Map<string, OrderStatus> {
  const utils = trpc.useUtils();
  const query = trpc.hyperliquid.orders.useQuery();
  trpc.hyperliquid.onUpdated.useSubscription(undefined, {
    onData: () => utils.hyperliquid.orders.invalidate(),
  });
  return useMemo(() => new Map((query.data ?? []).map((o) => [o.id, o])), [query.data]);
}
