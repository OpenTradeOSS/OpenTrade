import type { OrderStatus } from "@shared/broker";
import { useEffect, useMemo } from "react";
import { trpc } from "../lib/trpc";

/** Broker connection status, kept live via the onStatus subscription. */
export function useBrokerStatus() {
  const query = trpc.broker.connectionStatus.useQuery();
  const utils = trpc.useUtils();
  trpc.broker.onStatus.useSubscription(undefined, {
    onData: () => utils.broker.connectionStatus.invalidate(),
  });
  return query.data;
}

/** Portfolio + positions (equity and option), invalidated whenever the poller updates the cache. */
export function useBrokerData() {
  const utils = trpc.useUtils();
  const portfolio = trpc.broker.portfolio.useQuery();
  const positions = trpc.broker.positions.useQuery();
  const optionPositions = trpc.broker.optionPositions.useQuery();
  const cryptoPositions = trpc.broker.cryptoPositions.useQuery();

  trpc.broker.onUpdated.useSubscription(undefined, {
    onData: () => {
      utils.broker.portfolio.invalidate();
      utils.broker.positions.invalidate();
      utils.broker.optionPositions.invalidate();
      utils.broker.cryptoPositions.invalidate();
    },
  });

  // Refresh the "as of Xs ago" label on a cadence even without new data.
  useEffect(() => {
    const t = setInterval(() => utils.broker.portfolio.invalidate(), 15_000);
    return () => clearInterval(t);
  }, [utils]);

  return {
    portfolio: portfolio.data,
    positions: positions.data,
    optionPositions: optionPositions.data,
    cryptoPositions: cryptoPositions.data,
  };
}

/**
 * Robinhood's agentic order ledger as a `Map<orderId, OrderStatus>` — the source
 * of truth for execution status, joined into Activity/Approvals by orderId. Kept
 * live by the same `broker:updated` subscription that refreshes the cache.
 */
export function useAgenticOrders(): Map<string, OrderStatus> {
  const utils = trpc.useUtils();
  const query = trpc.broker.agenticOrders.useQuery();

  trpc.broker.onUpdated.useSubscription(undefined, {
    onData: () => utils.broker.agenticOrders.invalidate(),
  });

  return useMemo(() => {
    const map = new Map<string, OrderStatus>();
    for (const o of query.data?.value ?? []) map.set(o.id, o);
    return map;
  }, [query.data]);
}

/**
 * Whether the order ledger cache has been populated at least once. The cache is
 * the *complete* history, so once it exists "no matching order" is a definitive
 * non-execution; until then the UI must not assert failure. `data` is non-null
 * only after the poller has written the cache (it's null when no row exists).
 */
export function useLedgerReady(): boolean {
  return trpc.broker.agenticOrders.useQuery().data != null;
}

/** Force a full-history order refresh; `isPending` drives the spin on the button. */
export function useRefreshOrders() {
  return trpc.broker.refreshOrders.useMutation();
}
