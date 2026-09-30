import {
  type AgentIntegrations,
  envVarFor,
  type IntegrationId,
  type KalshiEnv,
  KEY_NAMES_ENV,
  PMXT_KEY_ENV,
  SaveKalshiInput,
  SaveKeyInput,
  secretHint,
  type VaultKey,
  type VaultStatus,
} from "@shared/vault";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings as settingsTable } from "../../db/schema";
import { bus } from "../event-bus";
import type { IntegrationSource } from "../integrations";
import { type KalshiCredentials, parseKalshiKey } from "../venues/kalshi/client";

// kv keys. Secrets live in the app DB like the Robinhood OAuth tokens: plaintext in a
// 0600 file under the 0700 ~/.opentrade (no safeStorage under ELECTRON_RUN_AS_NODE —
// see broker/robinhood/oauth.ts SecureStore).
const K_KALSHI = "vault_kalshi";
const K_KEYS = "vault_keys";
/** Pre-list single PMXT slot; folded into `vault_keys` on first read. */
const K_LEGACY_PMXT = "vault_pmxt";
const K_ROBINHOOD_ENABLED = "vault_robinhood_enabled";

/**
 * Env vars an agent key may NOT take over: the host's own plumbing and the CLIs'
 * billing keys (a vault key must never silently switch an agent onto API billing).
 */
const RESERVED_ENV =
  /^(OPENTRADE_|ELECTRON_|CLAUDE_|CODEX_)|^(PATH|HOME|SHELL|USER|TERM|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/;

/** Keys the vault recognizes and wires beyond the plain env var. */
const KNOWN_KEYS: Record<string, { wiredAs: string; testable: boolean }> = {
  [PMXT_KEY_ENV]: { wiredAs: "PMXT market data (MCP)", testable: true },
};

interface StoredKalshi extends KalshiCredentials {
  enabled: boolean;
}
interface StoredKey {
  name: string;
  envVar: string;
  value: string;
}

/**
 * The Key Vault: optional venue credentials + the per-integration on/off switches.
 * The single owner of that state — the renderer only ever sees `status()` (hints, not
 * secrets), and agents only see what `IntegrationSource` derives from it.
 */
export class VaultService implements IntegrationSource {
  constructor(private db: Db) {}

  status(): VaultStatus {
    const kalshi = this.kalshiStored();
    return {
      robinhood: { enabled: this.robinhoodEnabled() },
      kalshi: {
        configured: kalshi !== null,
        enabled: kalshi?.enabled ?? false,
        env: kalshi?.env ?? "prod",
        keyIdHint: kalshi ? secretHint(kalshi.keyId, 6) : null,
      },
      keys: this.keysStored().map(
        (k): VaultKey => ({
          name: k.name,
          envVar: k.envVar,
          hint: secretHint(k.value),
          wiredAs: KNOWN_KEYS[k.envVar]?.wiredAs ?? null,
          testable: KNOWN_KEYS[k.envVar]?.testable ?? false,
        }),
      ),
    };
  }

  /**
   * Store Kalshi credentials (validated: the PEM must parse as an RSA/Ed25519 key, so a
   * paste error surfaces here rather than as a signing failure mid-trade). Omitting the
   * PEM keeps the stored key — lets the user switch prod/demo or fix the key id.
   */
  saveKalshi(input: SaveKalshiInput): VaultStatus {
    const clean = SaveKalshiInput.parse(input);
    const prior = this.kalshiStored();
    const pem = clean.privateKeyPem?.trim() || prior?.privateKeyPem;
    if (!pem) throw new Error("A private key is required.");
    parseKalshiKey(pem);
    this.write(K_KALSHI, {
      keyId: clean.keyId,
      privateKeyPem: normalizePem(pem),
      env: clean.env,
      enabled: prior?.enabled ?? true,
    } satisfies StoredKalshi);
    return this.changed();
  }

  /**
   * Add a key, or replace the value of the key with the same env var (so re-adding
   * "PMXT" rotates it rather than duplicating it).
   */
  saveKey(input: SaveKeyInput): VaultStatus {
    const clean = SaveKeyInput.parse(input);
    const envVar = envVarFor(clean.name);
    if (!envVar) throw new Error("Give the key a name with letters or numbers.");
    if (RESERVED_ENV.test(envVar))
      throw new Error(`${envVar} is reserved by OpenTrade; pick another name.`);
    const keys = this.keysStored().filter((k) => k.envVar !== envVar);
    keys.push({ name: clean.name, envVar, value: clean.value });
    this.write(K_KEYS, keys);
    return this.changed();
  }

  removeKey(envVar: string): VaultStatus {
    this.write(
      K_KEYS,
      this.keysStored().filter((k) => k.envVar !== envVar),
    );
    return this.changed();
  }

  removeKalshi(): VaultStatus {
    this.db.delete(settingsTable).where(eq(settingsTable.key, K_KALSHI)).run();
    return this.changed();
  }

  setEnabled(id: IntegrationId, enabled: boolean): VaultStatus {
    if (id === "robinhood") {
      this.writeRaw(K_ROBINHOOD_ENABLED, enabled ? "1" : "0");
    } else {
      const k = this.kalshiStored();
      if (!k) throw new Error("Add Kalshi credentials first.");
      this.write(K_KALSHI, { ...k, enabled });
    }
    return this.changed();
  }

  /** Credentials for the host's Kalshi client, or null when Kalshi is off/absent. */
  kalshiCredentials(opts: { includeDisabled?: boolean } = {}): KalshiCredentials | null {
    const k = this.kalshiStored();
    if (!k || (!k.enabled && !opts.includeDisabled)) return null;
    return { keyId: k.keyId, privateKeyPem: k.privateKeyPem, env: k.env };
  }

  /** A stored key's value by env var (host-only: for live checks, never the renderer). */
  keyValue(envVar: string): string | null {
    return this.keysStored().find((k) => k.envVar === envVar)?.value ?? null;
  }

  // ---- IntegrationSource ----

  agentIntegrations(): AgentIntegrations {
    return {
      robinhood: this.robinhoodEnabled(),
      kalshi: this.kalshiCredentials() !== null,
      pmxt: this.keyValue(PMXT_KEY_ENV) !== null,
    };
  }

  /** Every key as an env var, plus the list of their NAMES so agents know what they have. */
  agentEnv(): Record<string, string> {
    const keys = this.keysStored();
    const env: Record<string, string> = {};
    for (const k of keys) env[k.envVar] = k.value;
    if (keys.length > 0) env[KEY_NAMES_ENV] = keys.map((k) => k.envVar).join(",");
    return env;
  }

  // ---- internals ----

  private robinhoodEnabled(): boolean {
    return this.readRaw(K_ROBINHOOD_ENABLED) !== "0"; // default on (pre-vault behavior)
  }

  private kalshiStored(): StoredKalshi | null {
    const v = this.read<Partial<StoredKalshi>>(K_KALSHI);
    if (!v?.keyId || !v.privateKeyPem) return null;
    const env: KalshiEnv = v.env === "demo" ? "demo" : "prod";
    return { keyId: v.keyId, privateKeyPem: v.privateKeyPem, env, enabled: v.enabled !== false };
  }

  private keysStored(): StoredKey[] {
    const list = this.read<Partial<StoredKey>[]>(K_KEYS);
    if (list === null) return this.migrateLegacyPmxt();
    return (Array.isArray(list) ? list : []).filter(
      (k): k is StoredKey =>
        typeof k?.name === "string" && typeof k.envVar === "string" && typeof k.value === "string",
    );
  }

  /** The first vault build kept PMXT in its own slot; carry it into the key list once. */
  private migrateLegacyPmxt(): StoredKey[] {
    const legacy = this.read<{ apiKey?: string }>(K_LEGACY_PMXT);
    const keys: StoredKey[] = legacy?.apiKey
      ? [{ name: "PMXT", envVar: PMXT_KEY_ENV, value: legacy.apiKey }]
      : [];
    this.write(K_KEYS, keys);
    this.db.delete(settingsTable).where(eq(settingsTable.key, K_LEGACY_PMXT)).run();
    return keys;
  }

  private changed(): VaultStatus {
    const status = this.status();
    bus.emitEvent("vault:changed", status);
    return status;
  }

  private readRaw(key: string): string | undefined {
    return this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
  }

  private read<T>(key: string): T | null {
    const raw = this.readRaw(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    this.writeRaw(key, JSON.stringify(value));
  }

  private writeRaw(key: string, value: string): void {
    this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }
}

/** Pasted keys often arrive with CRLFs or indentation; PEM wants bare `\n` lines. */
function normalizePem(pem: string): string {
  return `${pem
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")}\n`;
}
