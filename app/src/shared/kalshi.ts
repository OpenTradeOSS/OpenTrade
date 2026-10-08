import type { KalshiEnv } from "./vault";

/**
 * OpenTrade's own read-only view of the Kalshi account (the right panel's Portfolio →
 * Kalshi view and the "Kalshi connected" indicator), polled by the host with the vault
 * key. Dollar amounts are dollars (Kalshi reports balances in cents; converted here).
 */
export type KalshiConnection = "off" | "connecting" | "connected" | "error";

export interface KalshiStatus {
  state: KalshiConnection;
  env: KalshiEnv | null;
  /** Last error, when `state` is `error` (e.g. "Kalshi 401: …"). */
  message: string | null;
  /** When the last successful poll landed. */
  at: number | null;
}

export interface KalshiPosition {
  ticker: string;
  /** Market question, when the market lookup succeeded. */
  title: string | null;
  /** The outcome held. */
  side: "yes" | "no";
  contracts: number;
  /** What the open contracts cost (average-cost basis over the agents' fills). */
  cost: number | null;
  /** Liquidation mark per contract of the held side (that side's best bid). */
  mark: number | null;
  /** contracts × mark. */
  marketValue: number | null;
  /** marketValue − cost. */
  unrealizedPnl: number | null;
  /** Agent(s) whose orders built this position. */
  agentIds: string[];
}

/**
 * The Kalshi view. Kalshi has no agent-only sub-account (Robinhood agents trade a
 * dedicated one), so positions are ATTRIBUTED: only fills of orders an agent placed
 * through the approval gate count. Cash is the shared account's.
 */
export interface KalshiPortfolio {
  /** Uninvested cash in the (shared) Kalshi account. */
  cash: number | null;
  /** Mark value of the agents' positions. */
  positionsValue: number;
  /** Σ unrealized P&L of the agents' positions (null when any mark is missing). */
  unrealizedPnl: number | null;
  positions: KalshiPosition[];
  at: number;
}

/**
 * The Kalshi web page for a market. Kalshi's canonical market URLs are keyed by the
 * series (a market ticker's first segment: `KXMARSVRAIL-50` → series `KXMARSVRAIL`, as
 * the API's `series_ticker` confirms) and redirect to the current event page.
 */
export function kalshiMarketUrl(ticker: string, env: KalshiEnv | null): string {
  const series = ticker.split("-")[0].toLowerCase();
  const host = env === "demo" ? "https://demo.kalshi.co" : "https://kalshi.com";
  return `${host}/markets/${encodeURIComponent(series)}`;
}
