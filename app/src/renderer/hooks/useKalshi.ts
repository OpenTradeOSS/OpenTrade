import type { OrderStatus } from "@shared/broker";
import { useMemo } from "react";
import { trpc } from "../lib/trpc";

/** Kalshi connection state (off / connecting / connected / error), kept live. */
export function useKalshiStatus() {
  const utils = trpc.useUtils();
  const query = trpc.kalshi.status.useQuery();
  trpc.kalshi.onStatus.useSubscription(undefined, {
    onData: (s) => utils.kalshi.status.setData(undefined, s),
  });
  return query.data;
}

/** The Kalshi account view (cash, positions), refreshed on every host poll. */
export function useKalshiPortfolio() {
  const utils = trpc.useUtils();
  const query = trpc.kalshi.portfolio.useQuery();
  trpc.kalshi.onUpdated.useSubscription(undefined, {
    onData: () => utils.kalshi.portfolio.invalidate(),
  });
  return query.data ?? null;
}

/** Recent Kalshi orders keyed by id, in the ledger shape Activity joins on. */
export function useKalshiOrders(): Map<string, OrderStatus> {
  const utils = trpc.useUtils();
  const query = trpc.kalshi.orders.useQuery();
  trpc.kalshi.onUpdated.useSubscription(undefined, {
    onData: () => utils.kalshi.orders.invalidate(),
  });
  return useMemo(() => new Map((query.data ?? []).map((o) => [o.id, o])), [query.data]);
}
