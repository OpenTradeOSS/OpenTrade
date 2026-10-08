/**
 * The renderer runs in two places: the desktop app (with the preload bridge) and the
 * OpenTrade Cloud web app served by the gateway (no bridge). See lib/trpc.ts.
 */
export const IS_WEB = typeof window !== "undefined" && !window.__opentradeHost;
