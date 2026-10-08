import type { HyperliquidEnv } from "./vault";

/**
 * OpenTrade's own read-only view of the Hyperliquid account (the right panel's
 * Portfolio → Hyperliquid view and the connected indicator), polled by the host. Reads
 * need no key — they are public queries on the ACCOUNT address (never the API wallet's,
 * which is always empty).
 */
export type HyperliquidConnection = "off" | "connecting" | "connected" | "error";

export interface HyperliquidStatus {
  state: HyperliquidConnection;
  env: HyperliquidEnv | null;
  /** The account traded. */
  account: string | null;
  /** Last error, when `state` is `error`. */
  message: string | null;
  /** When the last successful poll landed. */
  at: number | null;
}

/** An open perpetual position. */
export interface HyperliquidPosition {
  /** Perp name (`BTC`, or `dex:NAME` on a builder-deployed dex). */
  symbol: string;
  side: "long" | "short";
  /** Position size in the coin, always positive (`side` carries the direction). */
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  /** Notional (size × mark). */
  positionValue: number | null;
  unrealizedPnl: number | null;
  /** Margin posted for the position — the cost basis its return is measured on. */
  marginUsed: number | null;
  leverage: number | null;
  liquidationPrice: number | null;
}

/** A spot token balance. */
export interface HyperliquidBalance {
  coin: string;
  total: number;
  /** Locked in open orders. */
  hold: number;
  /** USD price (1 for USDC; null when no USDC pair quotes it). */
  price: number | null;
  value: number | null;
  /** What the balance cost (`entryNtl`), for P&L. */
  cost: number | null;
}

/**
 * The whole account — unlike Kalshi's view this is NOT narrowed to agent-placed orders:
 * a perp position is one net number per coin, so it can't be split between the user's
 * own trades and the agents'. Point agents at a sub-account to keep them separate.
 */
export interface HyperliquidPortfolio {
  /** Total account value in USD (perp equity + spot balances). */
  equity: number | null;
  /** USDC free to trade or withdraw. */
  withdrawable: number | null;
  /** Σ unrealized P&L of the perp positions. */
  unrealizedPnl: number | null;
  positions: HyperliquidPosition[];
  balances: HyperliquidBalance[];
  at: number;
}

/** The Hyperliquid trade page for a market. */
export function hyperliquidMarketUrl(symbol: string, env: HyperliquidEnv | null): string {
  const host =
    env === "testnet" ? "https://app.hyperliquid-testnet.xyz" : "https://app.hyperliquid.xyz";
  return `${host}/trade/${encodeURIComponent(symbol)}`;
}
