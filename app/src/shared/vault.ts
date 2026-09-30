import { z } from "zod";

/**
 * The Key Vault: everything agents may use, all optional.
 *
 *  - **Venues** (dedicated setup):
 *    - `robinhood` — Robinhood's Agentic Trading MCP. No secret here (each agent CLI runs
 *      its own OAuth), so only an on/off switch. On by default (the pre-vault behavior).
 *    - `kalshi` — Kalshi event contracts, reads + writes, through OpenTrade's own
 *      `kalshi` MCP server. The host holds the key and signs every request; order writes
 *      pass the same approval gate as Robinhood orders.
 *  - **API keys** (any number, just a name + a value): each is handed to every agent as
 *    an environment variable (`PMXT` → `PMXT_API_KEY`). A few names are recognized and
 *    wired further — `PMXT_API_KEY` also connects PMXT's hosted, read-only MCP.
 *
 * What an agent gets is recomputed from the vault on every launch (the harness
 * `writeConfig` step + `buildAgentEnv`), so a change applies the next time an agent
 * starts.
 */
export const IntegrationId = z.enum(["robinhood", "kalshi"]);
export type IntegrationId = z.infer<typeof IntegrationId>;

/** Env var PMXT's key is recognized by (agents' PMXT MCP entries reference it by name). */
export const PMXT_KEY_ENV = "PMXT_API_KEY";

/** Env var listing the NAMES (never values) of every vault key handed to an agent. */
export const KEY_NAMES_ENV = "OPENTRADE_KEYS";

export const KalshiEnv = z.enum(["prod", "demo"]);
export type KalshiEnv = z.infer<typeof KalshiEnv>;

/** What the harness wires into each agent. `true` = present and switched on. */
export interface AgentIntegrations {
  robinhood: boolean;
  kalshi: boolean;
  pmxt: boolean;
}

/** Robinhood-only — the pre-vault behavior, and the fallback before the vault is wired. */
export const DEFAULT_AGENT_INTEGRATIONS: AgentIntegrations = {
  robinhood: true,
  kalshi: false,
  pmxt: false,
};

export const SaveKalshiInput = z.object({
  keyId: z.string().trim().min(1).max(200),
  /** PEM private key (RSA or Ed25519). Omit to keep the stored one (e.g. switching env). */
  privateKeyPem: z.string().trim().max(10_000).optional(),
  env: KalshiEnv,
});
export type SaveKalshiInput = z.infer<typeof SaveKalshiInput>;

export const SaveKeyInput = z.object({
  /** Human name, e.g. "PMXT" or "News API". Drives the env var (see `envVarFor`). */
  name: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(4_000),
});
export type SaveKeyInput = z.infer<typeof SaveKeyInput>;

/**
 * The env var a key is exposed to agents as: the name upper-snake-cased, with
 * `_API_KEY` appended unless it already reads as a credential: "PMXT" → `PMXT_API_KEY`,
 * "News API" → `NEWS_API_KEY`, "NEWS_API_KEY" → `NEWS_API_KEY`, "github token" →
 * `GITHUB_TOKEN`.
 */
export function envVarFor(name: string): string {
  let v = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!v) return "";
  if (/^[0-9]/.test(v)) v = `KEY_${v}`;
  if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(v)) return v;
  return v.endsWith("_API") || v === "API" ? `${v}_KEY` : `${v}_API_KEY`;
}

/** A stored key as the renderer sees it — never the value. */
export interface VaultKey {
  name: string;
  envVar: string;
  hint: string;
  /** What else this key unlocks beyond the env var ("PMXT market data (MCP)"). */
  wiredAs: string | null;
  /** Whether the vault can run a live check on it (see `vault.testKey`). */
  testable: boolean;
}

/**
 * The renderer's view of the vault. Secrets never leave the host: keys are reduced to
 * a short hint (`…d808e`) so the user can tell which key is stored.
 */
export interface VaultStatus {
  robinhood: { enabled: boolean };
  kalshi: {
    configured: boolean;
    enabled: boolean;
    env: KalshiEnv;
    keyIdHint: string | null;
  };
  keys: VaultKey[];
}

export interface VaultTestResult {
  ok: boolean;
  /** One line for the UI: the balance on success, the venue's error otherwise. */
  message: string;
}

/** `…` + the last few characters — enough to recognize a key, useless to replay it. */
export function secretHint(secret: string, tail = 5): string {
  const s = secret.trim();
  return s.length <= tail ? "…" : `…${s.slice(-tail)}`;
}
