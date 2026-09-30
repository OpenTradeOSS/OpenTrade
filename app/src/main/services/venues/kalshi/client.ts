import { constants, createPrivateKey, type KeyObject, sign } from "node:crypto";
import type { KalshiEnv } from "@shared/vault";
import type { KalshiRequest } from "./requests";

export const KALSHI_BASE_URLS: Record<KalshiEnv, string> = {
  prod: "https://external-api.kalshi.com/trade-api/v2",
  // Kalshi documents two demo hosts; the "Trade API" one (external-api.demo.kalshi.co)
  // was answering 503 `exchange_active:false` on 2026-09-30 while this shared one served
  // normally, so demo uses the shared host.
  demo: "https://demo-api.kalshi.co/trade-api/v2",
};

const REQUEST_TIMEOUT_MS = 20_000;

export interface KalshiCredentials {
  keyId: string;
  privateKeyPem: string;
  env: KalshiEnv;
}

/** A non-2xx Kalshi response, carrying the venue's own error text for the agent. */
export class KalshiApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KalshiApiError";
  }
}

/** Parse the stored PEM once; throws a readable error for a malformed key. */
export function parseKalshiKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(
      "Could not read the private key. Paste the full PEM, including the BEGIN/END lines.",
    );
  }
  const type = key.asymmetricKeyType;
  if (type !== "rsa" && type !== "ed25519") {
    throw new Error(`Unsupported key type ${type ?? "unknown"}: Kalshi keys are RSA or Ed25519.`);
  }
  return key;
}

/**
 * Kalshi's request signature: `timestamp_ms + METHOD + path` (path from the root,
 * e.g. `/trade-api/v2/portfolio/balance`, WITHOUT the query string), signed with
 * RSA-PSS/SHA-256 (salt = digest length) or Ed25519, base64-encoded.
 */
export function signKalshi(
  key: KeyObject,
  timestampMs: string,
  method: string,
  path: string,
): string {
  const message = Buffer.from(`${timestampMs}${method}${path}`, "utf8");
  if (key.asymmetricKeyType === "ed25519") return sign(null, message, key).toString("base64");
  return sign("sha256", message, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

/** A signed Kalshi Trade API v2 client. Holds the key only in the host process. */
export class KalshiClient {
  private readonly key: KeyObject;
  private readonly base: string;

  constructor(
    private readonly creds: KalshiCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = parseKalshiKey(creds.privateKeyPem);
    this.base = KALSHI_BASE_URLS[creds.env];
  }

  async send(req: KalshiRequest): Promise<unknown> {
    const url = new URL(this.base + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const ts = String(Date.now());
    const headers: Record<string, string> = {
      "KALSHI-ACCESS-KEY": this.creds.keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": signKalshi(this.key, ts, req.method, url.pathname),
      Accept: "application/json",
    };
    if (req.body) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method: req.method,
      headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new KalshiApiError(res.status, errorText(res.status, json), json);
    return json;
  }
}

function errorText(status: number, json: unknown): string {
  const err = (json as { error?: { message?: string; details?: string; code?: string } } | null)
    ?.error;
  const detail =
    err?.message ??
    err?.details ??
    err?.code ??
    (typeof json === "string" ? json : json != null ? JSON.stringify(json) : "");
  return `Kalshi ${status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
}
