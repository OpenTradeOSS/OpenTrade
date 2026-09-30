import { IS_NIGHTLY } from "./app-identity";

/**
 * Experimental features, Zed-style: the code lives on `main` and ships in every build,
 * but stays switched off outside OpenTrade Nightly until it graduates. Graduating a
 * feature means deleting its flag (and the checks); abandoning it means deleting the
 * code. Keep this list short — every entry is a fork in behavior someone has to test.
 *
 * A flag must be all-or-nothing at its gates: when off, stable behaves exactly as it
 * did before the feature landed (no UI, no agent config, no background work).
 */
export const FEATURES = {
  /**
   * Key Vault + optional venues: Kalshi (reads + gated writes via the built-in
   * `kalshi` MCP), PMXT market data, extra API keys as agent env vars, and Robinhood
   * as an optional venue. Off → agents get Robinhood only, as before.
   */
  venues: IS_NIGHTLY,
} as const;

export type FeatureName = keyof typeof FEATURES;
