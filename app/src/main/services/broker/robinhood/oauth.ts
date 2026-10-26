import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { settings } from "../../../db/schema";
import { analytics } from "../../analytics";

/**
 * Read/write the settings kv. Values are stored as plaintext JSON: the backend
 * runs headless under ELECTRON_RUN_AS_NODE where Electron `safeStorage` is
 * unavailable. Confidentiality rests on the DB file + ~/.opentrade being 0600;
 * OS-keychain encryption is noted as future hardening.
 */
class SecureStore {
  constructor(private db: Db) {}

  private raw(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }

  private put(key: string, value: string) {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  getSecret<T>(key: string): T | undefined {
    const stored = this.raw(key);
    if (!stored) return undefined;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return undefined;
    }
  }

  setSecret(key: string, value: unknown) {
    this.put(key, JSON.stringify(value));
  }

  clear(key: string) {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}

// OAuth provider state keys.
const K_TOKENS = "rh_oauth_tokens";
const K_CLIENT = "rh_oauth_client";
const K_VERIFIER = "rh_oauth_verifier";

/**
 * Reported as `redirectUrl` outside an interactive consent. The SDK only checks that
 * a redirect URL is *present* on the token-refresh path (a missing one means a
 * non-interactive grant flow); the value is never sent. Nothing listens here.
 */
const IDLE_REDIRECT_URL = "http://127.0.0.1/callback";

/**
 * Thrown by `redirectToAuthorization` when the MCP SDK wants to start a browser
 * consent flow but the connect is *silent* (boot auto-connect). Opening a browser
 * unprompted is never acceptable there, and the tokens on hand may still be fine
 * (the SDK reaches this after a refresh failed for a *transient* reason — network,
 * 5xx — not just a dead grant), so the caller keeps them and stays disconnected; the
 * user re-consents explicitly via Connect. Distinct from `UnauthorizedError`, which
 * the SDK throws only *after* it has already redirected.
 */
export class ConsentRequired extends Error {
  constructor() {
    super("browser consent required but the connect is not interactive");
    this.name = "ConsentRequired";
  }
}

// Minimal structural types mirroring the MCP SDK's OAuth shapes (avoids a hard
// type import; the SDK validates these at runtime).
interface OAuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}
interface OAuthClientInformation {
  client_id: string;
  client_secret?: string;
  [k: string]: unknown;
}

export interface OAuthProviderOptions {
  db: Db;
  /** Open the consent URL in the user's browser. */
  openBrowser: (url: string) => void;
}

/**
 * App-side OAuthClientProvider for the Robinhood MCP: dynamic client
 * registration + loopback redirect + PKCE, with tokens/client-info persisted as
 * plaintext in the app DB (0600; no safeStorage under ELECTRON_RUN_AS_NODE — see
 * SecureStore). Shape matches the MCP SDK's OAuthClientProvider.
 *
 * The redirect URL is **per consent**, not a constant: each interactive consent binds
 * a fresh ephemeral loopback port, and the adapter calls `beginAuthorization(url)`
 * with it before the SDK registers the client. The SDK reads `redirectUrl` at
 * registration, in the authorization request, and at code exchange — all inside that
 * one flow, so they agree and match what Robinhood has on file.
 */
export class BrokerOAuthProvider {
  private store: SecureStore;
  /**
   * The loopback URL of the interactive consent in progress; null otherwise. Doubles
   * as the browser gate: the SDK may only open a browser while this is set.
   */
  private activeRedirectUrl: string | null = null;
  /**
   * When the current consent's loopback was bound — which is also when its timeout
   * started running. Used only to measure how much of that budget was gone by the time
   * the browser opened (`broker_consent_opened`).
   */
  private armedAt: number | null = null;

  constructor(private opts: OAuthProviderOptions) {
    this.store = new SecureStore(opts.db);
  }

  get redirectUrl(): string {
    return this.activeRedirectUrl ?? IDLE_REDIRECT_URL;
  }

  get clientMetadata() {
    return {
      client_name: "OpenTrade (read-only portfolio client)",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read",
    };
  }

  /**
   * Start an interactive consent on a freshly bound loopback: adopt its redirect URL
   * and drop any stored client registration so the SDK registers a new client under
   * this URL (one made for a different port would fail with redirect_uri mismatch).
   * Tokens are left alone — dropping them is the adapter's call.
   */
  beginAuthorization(redirectUrl: string) {
    this.store.clear(K_CLIENT);
    this.store.clear(K_VERIFIER);
    this.activeRedirectUrl = redirectUrl;
    this.armedAt = Date.now();
  }

  /** The interactive consent ended (however it ended): the browser gate closes again. */
  endAuthorization() {
    this.activeRedirectUrl = null;
    this.armedAt = null;
  }

  state() {
    return "opentrade";
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.store.getSecret<OAuthClientInformation>(K_CLIENT);
  }

  saveClientInformation(info: OAuthClientInformation) {
    this.store.setSecret(K_CLIENT, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.getSecret<OAuthTokens>(K_TOKENS);
  }

  saveTokens(tokens: OAuthTokens) {
    this.store.setSecret(K_TOKENS, tokens);
  }

  /**
   * The SDK wants the user to consent in a browser. Only an interactive connect may
   * open one; a silent connect (boot) that lands here throws `ConsentRequired` so the
   * caller stays disconnected — with its tokens — instead of popping a browser
   * unprompted onto a redirect URL nobody is listening on.
   */
  redirectToAuthorization(url: URL) {
    if (!this.activeRedirectUrl) throw new ConsentRequired();
    this.opts.openBrowser(url.toString());
    // After the open, so a browser we failed to launch isn't recorded as one the user saw.
    analytics.track("broker_consent_opened", {
      armed_ms: this.armedAt === null ? 0 : Math.max(0, Date.now() - this.armedAt),
    });
  }

  saveCodeVerifier(verifier: string) {
    this.store.setSecret(K_VERIFIER, verifier);
  }

  codeVerifier(): string {
    const v = this.store.getSecret<string>(K_VERIFIER);
    if (!v) throw new Error("missing PKCE code verifier");
    return v;
  }

  hasTokens(): boolean {
    return this.tokens() !== undefined;
  }

  reset() {
    this.store.clear(K_TOKENS);
    this.store.clear(K_CLIENT);
    this.store.clear(K_VERIFIER);
  }
}
