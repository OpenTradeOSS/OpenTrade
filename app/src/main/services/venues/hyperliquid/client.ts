import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";
import type { HyperliquidEnv } from "@shared/vault";
import { privateKeyToAccount } from "viem/accounts";

/**
 * What the host needs to trade a Hyperliquid account.
 *
 * `privateKey` is an API (agent) wallet's key: Hyperliquid lets the account's main
 * wallet approve a separate key that may trade for it but can never withdraw or
 * transfer funds out, and that is what OpenTrade asks for — never the main wallet's
 * key. The API wallet only SIGNS; every query is made on `accountAddress` (the API
 * wallet's own address always reads as an empty account).
 */
export interface HyperliquidCredentials {
  privateKey: `0x${string}`;
  /** The account traded: the wallet that approved the key, or a sub-account/vault of it. */
  accountAddress: `0x${string}`;
  /** Who approved the key (differs from `accountAddress` for a sub-account/vault). */
  masterAddress: `0x${string}`;
  env: HyperliquidEnv;
}

export class HyperliquidApiError extends Error {}

/** `0x`-prefixed, lowercased private key; throws on anything that isn't 32 bytes of hex. */
export function normalizePrivateKey(key: string): `0x${string}` {
  const k = key.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(k)) throw new Error("A private key is 64 hex characters.");
  return `0x${k}`;
}

/** The address a private key signs as (lowercase, the form Hyperliquid's API uses). */
export function addressOf(privateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t:
    | { limit: { tif: "Gtc" | "Ioc" | "Alo" } }
    | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
}

/** One entry of an order action's `statuses`. */
export type OrderStatusWire =
  | { resting: { oid: number } }
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { error: string }
  | string;

/**
 * The slice of Hyperliquid the service uses, narrow enough to fake in tests: public
 * reads (`info`), the three signed actions, and symbol → asset id / lot size lookups.
 */
export interface HyperliquidApi {
  info<T = unknown>(payload: Record<string, unknown>): Promise<T>;
  /** `normalTpsl`: the first order is an entry, the rest its attached stop / take-profit. */
  order(orders: OrderWire[], grouping?: "na" | "normalTpsl"): Promise<OrderStatusWire[]>;
  cancel(asset: number, oid: number): Promise<void>;
  updateLeverage(asset: number, isCross: boolean, leverage: number): Promise<void>;
  assetId(symbol: string): number | undefined;
  szDecimals(symbol: string): number | undefined;
  /** The name info endpoints know a market by (`@107` for most spot pairs). */
  coin(symbol: string): string;
  /** The symbol for an info-endpoint coin (`@107` → `HYPE/USDC`). */
  symbol(coin: string): string;
  /** Load asset ids for the main dex, spot, and (once named) a builder dex. */
  loadSymbols(dex?: string): Promise<void>;
}

/** Reads only: no key needed (used to resolve an API wallet's account before saving). */
export function hyperliquidInfo(
  env: HyperliquidEnv,
): <T = unknown>(payload: Record<string, unknown>) => Promise<T> {
  const transport = makeTransport(env);
  return (payload) => wrap(() => transport.request("info", payload)) as never;
}

export function createHyperliquidApi(creds: HyperliquidCredentials): HyperliquidApi {
  const transport = makeTransport(creds.env);
  // A sub-account or vault has no key of its own: the master's API wallet signs and
  // names it as `vaultAddress`.
  const delegated = creds.accountAddress !== creds.masterAddress;
  const exchange = new ExchangeClient({
    transport,
    wallet: privateKeyToAccount(creds.privateKey),
    ...(delegated ? { defaultVaultAddress: creds.accountAddress } : {}),
  });
  const dexs = new Set<string>();
  let symbols: SymbolConverter | null = null;

  return {
    info: (payload) => wrap(() => transport.request("info", payload)) as never,
    order: async (orders, grouping = "na") => {
      const res = await wrap(() => exchange.order({ orders, grouping }));
      return res.response.data.statuses as OrderStatusWire[];
    },
    cancel: async (asset, oid) => {
      await wrap(() => exchange.cancel({ cancels: [{ a: asset, o: oid }] }));
    },
    updateLeverage: async (asset, isCross, leverage) => {
      await wrap(() => exchange.updateLeverage({ asset, isCross, leverage }));
    },
    assetId: (s) => symbols?.getAssetId(s),
    szDecimals: (s) => symbols?.getSzDecimals(s),
    coin: (s) => (s.includes("/") ? (symbols?.getSpotPairId(s) ?? s) : s),
    symbol: (c) => symbols?.getSymbolBySpotPairId(c) ?? c,
    loadSymbols: async (dex) => {
      if (symbols && (!dex || dexs.has(dex))) return;
      if (dex) dexs.add(dex);
      symbols = await wrap(() => SymbolConverter.create({ transport, dexs: [...dexs] }));
    },
  };
}

function makeTransport(env: HyperliquidEnv): HttpTransport {
  return new HttpTransport({ isTestnet: env === "testnet", timeout: 20_000 });
}

/**
 * The SDK throws on every failure, including a per-order rejection inside an otherwise
 * "ok" response; fold them into one error type whose message is the venue's own words.
 */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new HyperliquidApiError(describe(err));
  }
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiRequestError) {
    // The signer isn't a wallet this account approved: Hyperliquid reports it as an
    // unknown address (which differs per payload, so quoting it would only confuse).
    if (/does not exist/i.test(msg)) {
      return "Hyperliquid rejected the signature: this API wallet is not approved for the account (it may have expired or been replaced). Re-create it at app.hyperliquid.xyz/API and update the key in OpenTrade's Key Vault.";
    }
    return `Hyperliquid: ${msg}`;
  }
  return `Hyperliquid request failed: ${msg}`;
}
