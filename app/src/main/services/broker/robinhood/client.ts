import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  Account,
  CryptoPosition,
  CryptoQuote,
  OptionContract,
  OptionPosition,
  OptionQuote,
  OrderStatus,
  Portfolio,
  Position,
  Quote,
} from "@shared/broker";
import type { Db } from "../../../db/client";
import { type BrokerAdapter, ConnectSuperseded, type McpServerConfig } from "../adapter";
import {
  mapAccounts,
  mapCryptoOrderStatuses,
  mapCryptoPositions,
  mapCryptoQuotes,
  mapOptionInstruments,
  mapOptionOrderStatuses,
  mapOptionPositions,
  mapOptionQuotes,
  mapOrderStatuses,
  mapPortfolio,
  mapPositions,
  mapQuotes,
  nextCursor,
  RH_TOOLS,
  unwrap,
} from "./mapping";
import { BrokerOAuthProvider, ConsentRequired } from "./oauth";

const SERVER_URL = "https://agent.robinhood.com/mcp/trading";
const LOOPBACK_HOST = "127.0.0.1";
/** Generous: a Robinhood login can involve 2FA. Waiting is cheap (ephemeral, cancellable). */
const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A consent flow that ended without an authorization code. `code` says why, as a
 * bounded token telemetry can carry (`error_code`): `OAUTH_TIMEOUT` when nobody came
 * back to the loopback, or `OAUTH_<ERROR>` for the RFC 6749 error the authorization
 * server sent to the callback (`OAUTH_ACCESS_DENIED` = the user declined).
 */
export class OAuthFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

/** The closed set of `error` values an authorization server may send (RFC 6749 §4.1.2.1). */
const OAUTH_ERRORS = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

/** `access_denied` → `OAUTH_ACCESS_DENIED`; anything off the RFC list → `OAUTH_UNKNOWN`. */
export function oauthErrorCode(error: string | null | undefined): string {
  return error && OAUTH_ERRORS.has(error) ? `OAUTH_${error.toUpperCase()}` : "OAUTH_UNKNOWN";
}

/** A bound loopback redirect listener for one consent flow. */
export interface Loopback {
  /** `http://127.0.0.1:<port>/callback` — the port is ephemeral, chosen at bind. */
  readonly redirectUrl: string;
  /**
   * The authorization code, once the browser is redirected back. Rejects with
   * `OAuthFlowError` (declined / timed out), `ConnectSuperseded` (cancelled), or the
   * listener's own error. Safe to leave un-awaited for a while: a rejection is
   * pre-handled here so it can never surface as an `unhandledRejection`.
   */
  readonly code: Promise<string>;
  /** Release the port; if `code` is still pending, reject it with `reason`. Idempotent. */
  close(reason?: Error): void;
}

/**
 * Bind the loopback redirect listener for a consent flow on an **ephemeral** port
 * (RFC 8252 §7.3). Why ephemeral, awaited, bounded: a fixed port (8771) failed with
 * `EADDRINUSE` whenever anything else held it — another app, a second OpenTrade host,
 * or an earlier consent of the *same* host still waiting on a browser tab the user had
 * closed (the wait had no timeout, so that pinned the port for the life of the host and
 * failed every later Connect). And its listener error rejected a promise nobody was
 * awaiting yet, surfacing as an `unhandledRejection` while the browser opened anyway.
 * Now: the port is per flow, this resolves only once actually listening (a bind failure
 * is an ordinary rejection *before* any browser opens), and the wait times out.
 */
export async function openLoopback(
  opts: { timeoutMs?: number; port?: number } = {},
): Promise<Loopback> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  // The consumer awaits `code` only after kicking off the authorization request (a
  // network round-trip); a rejection landing before then must not become an
  // unhandledRejection. This marks it handled; the consumer's own await still sees it.
  code.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    const authCode = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<html><body style="font-family:-apple-system,sans-serif;padding:3rem;background:#1c1c1c;color:#fafafa">` +
        `<h2>${authCode ? "OpenTrade connected ✓" : "Authorization failed"}</h2>` +
        `<p>You can close this tab and return to OpenTrade.</p></body></html>`,
    );
    if (authCode) resolveCode(authCode);
    else
      rejectCode(
        new OAuthFlowError(
          oauthErrorCode(url.searchParams.get("error")),
          "authorization server returned an error",
        ),
      );
  });

  // A bind failure rejects *this* call (and, harmlessly, the pre-handled `code`);
  // a later listener error rejects `code`.
  await new Promise<void>((res, rej) => {
    server.on("error", (err) => {
      rej(err);
      rejectCode(err);
    });
    server.listen(opts.port ?? 0, LOOPBACK_HOST, res);
  });

  const { port } = server.address() as AddressInfo;
  const close = (reason: Error = new ConnectSuperseded()) => {
    clearTimeout(timer);
    rejectCode(reason); // no-op if `code` already settled
    server.close(); // frees the port at once; a keep-alive socket drains on its own
  };
  const timer = setTimeout(
    () => close(new OAuthFlowError("OAUTH_TIMEOUT", "consent flow timed out")),
    opts.timeoutMs ?? CONSENT_TIMEOUT_MS,
  );
  return { redirectUrl: `http://${LOOPBACK_HOST}:${port}/callback`, code, close };
}

/**
 * Whether a failed token-authenticated connect means we should drop the stored
 * session and re-run interactive consent (open the browser), rather than surface a
 * hard error. Two cases qualify:
 *  - `UnauthorizedError` — a 401 from the resource (no/invalid access token).
 *  - `InvalidGrantError` — the refresh token expired or was revoked. The MCP SDK's
 *    `auth()` re-throws this instead of auto-restarting the flow, so without handling
 *    it here an expired grant leaves the user permanently unable to reconnect.
 * A transient `ServerError` (or any other error) is NOT re-auth — we must not nuke a
 * still-valid session on a blip — so it propagates.
 */
export function isReauthRequired(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof InvalidGrantError;
}

export interface RobinhoodAdapterOptions {
  db: Db;
  openBrowser: (url: string) => void;
}

export class RobinhoodAdapter implements BrokerAdapter {
  readonly id = "robinhood";
  protected provider: BrokerOAuthProvider;
  private client: Client | null = null;
  /** The interactive consent currently waiting on the browser, if any. */
  private pending: Loopback | null = null;

  constructor(opts: RobinhoodAdapterOptions) {
    this.provider = new BrokerOAuthProvider({ db: opts.db, openBrowser: opts.openBrowser });
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  hasTokens(): boolean {
    return this.provider.hasTokens();
  }

  reset() {
    this.cancelConnect();
    this.provider.reset();
    void this.client?.close().catch(() => {});
    this.client = null;
  }

  async connect(opts: { interactive?: boolean } = {}): Promise<void> {
    if (this.client) return;
    // Cached tokens (or a refreshable session) connect with no browser.
    if (this.provider.hasTokens()) {
      try {
        await this.doConnect();
        return;
      } catch (err) {
        if (err instanceof ConsentRequired) {
          // The SDK wanted a browser after a refresh failed for a *non*-grant reason
          // (network, 5xx, no refresh token). Silent: keep the tokens — likely still
          // good — and stay disconnected. Interactive: a fresh consent replaces them.
          if (!opts.interactive) return;
          this.provider.reset();
        } else if (isReauthRequired(err)) {
          // Dead session (401 / invalid_grant): drop it so an interactive connect
          // starts clean instead of retrying the same dead refresh. Silent: stay
          // disconnected rather than pop a browser unprompted.
          this.provider.reset();
          if (!opts.interactive) return;
        } else {
          throw err;
        }
      }
    }
    // Only the explicit Connect action opens a browser.
    if (opts.interactive) await this.interactiveConnect();
  }

  /** Abandon the consent waiting on the browser, if any: its `connect()` rejects with `ConnectSuperseded`. */
  cancelConnect(): void {
    this.pending?.close();
    this.pending = null;
  }

  protected async doConnect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      // biome-ignore lint/suspicious/noExplicitAny: provider matches SDK's structural OAuthClientProvider
      authProvider: this.provider as any,
    });
    const client = new Client({ name: "opentrade", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  /** Exchange the loopback's authorization code for tokens (saved via the provider). */
  protected async exchangeCode(code: string): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      // biome-ignore lint/suspicious/noExplicitAny: structural provider
      authProvider: this.provider as any,
    });
    await transport.finishAuth(code);
  }

  /**
   * The browser consent flow. Entered only with no usable tokens (fresh install, or
   * after `connect()` dropped a dead/unrefreshable session), so the first `doConnect`
   * is *expected* to end in a redirect: the SDK registers a client under this flow's
   * loopback URL, opens the browser, and throws `UnauthorizedError`; the code then
   * arrives on the loopback and is exchanged for tokens. Two flows must never overlap
   * (both would write the same client-registration + PKCE rows and open a browser
   * each) — `BrokerService.connect` guarantees that by cancelling and awaiting any
   * pending connect before starting another; the cancel here is just hygiene.
   */
  private async interactiveConnect(): Promise<void> {
    this.cancelConnect();
    const loopback = await openLoopback();
    this.pending = loopback;
    this.provider.beginAuthorization(loopback.redirectUrl);
    try {
      try {
        await this.doConnect();
        return;
      } catch (err) {
        if (!isReauthRequired(err)) throw err;
      }
      const code = await loopback.code;
      await this.exchangeCode(code);
      await this.doConnect();
    } finally {
      this.provider.endAuthorization();
      loopback.close();
      if (this.pending === loopback) this.pending = null;
    }
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error("broker not connected");
    const result = await this.client.callTool({ name, arguments: args });
    return unwrap(result);
  }

  async listAccounts(): Promise<Account[]> {
    return mapAccounts(await this.call(RH_TOOLS.getAccounts));
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return mapPortfolio(
      await this.call(RH_TOOLS.getPortfolio, { account_number: accountNumber }),
      accountNumber,
    );
  }

  async getPositions(accountNumber: string): Promise<Position[]> {
    return mapPositions(
      await this.call(RH_TOOLS.getEquityPositions, { account_number: accountNumber }),
    );
  }

  async getAgenticOrders(
    accountNumber: string,
    opts: { createdAtGte?: string; cursor?: string } = {},
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }> {
    // No `placed_agent` filter: we want *every* order on the agentic account,
    // including ones placed manually in the RH app, so Activity can show them all.
    const args: Record<string, unknown> = {
      account_number: accountNumber,
    };
    if (opts.createdAtGte) args.created_at_gte = opts.createdAtGte;
    if (opts.cursor) args.cursor = opts.cursor;
    const payload = await this.call(RH_TOOLS.getEquityOrders, args);
    return { orders: mapOrderStatuses(payload), cursor: nextCursor(payload) };
  }

  async getOrder(accountNumber: string, orderId: string): Promise<OrderStatus | null> {
    const payload = await this.call(RH_TOOLS.getEquityOrders, {
      account_number: accountNumber,
      order_id: orderId,
    });
    return mapOrderStatuses(payload)[0] ?? null;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    return mapQuotes(await this.call(RH_TOOLS.getEquityQuotes, { symbols }));
  }

  // ---- options ----

  async getOptionOrders(
    accountNumber: string,
    opts: { createdAtGte?: string; cursor?: string } = {},
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }> {
    // As with equities: no `placed_agent` filter, so manual RH-app orders show too.
    const args: Record<string, unknown> = { account_number: accountNumber };
    if (opts.createdAtGte) args.created_at_gte = opts.createdAtGte;
    if (opts.cursor) args.cursor = opts.cursor;
    const payload = await this.call(RH_TOOLS.getOptionOrders, args);
    return { orders: mapOptionOrderStatuses(payload), cursor: nextCursor(payload) };
  }

  async getOptionOrder(accountNumber: string, orderId: string): Promise<OrderStatus | null> {
    const payload = await this.call(RH_TOOLS.getOptionOrders, {
      account_number: accountNumber,
      order_id: orderId,
    });
    return mapOptionOrderStatuses(payload)[0] ?? null;
  }

  async getOptionPositions(accountNumber: string): Promise<OptionPosition[]> {
    return mapOptionPositions(
      await this.call(RH_TOOLS.getOptionPositions, {
        account_number: accountNumber,
        nonzero: true,
      }),
    );
  }

  async getOptionContracts(optionIds: string[]): Promise<OptionContract[]> {
    if (optionIds.length === 0) return [];
    // `ids` is comma-separated; the tool takes a whole batch in one call.
    return mapOptionInstruments(
      await this.call(RH_TOOLS.getOptionInstruments, { ids: optionIds.join(",") }),
    );
  }

  async getOptionQuotes(optionIds: string[]): Promise<OptionQuote[]> {
    if (optionIds.length === 0) return [];
    return mapOptionQuotes(
      await this.call(RH_TOOLS.getOptionQuotes, { instrument_ids: optionIds }),
    );
  }

  // ---- crypto (keyed by the numeric rhs account number) ----

  async getCryptoOrders(
    rhsAccountNumber: string,
    opts: { createdAtGte?: string; cursor?: string } = {},
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }> {
    const args: Record<string, unknown> = { rhs_account_number: rhsAccountNumber };
    if (opts.createdAtGte) args.created_at_gte = opts.createdAtGte;
    if (opts.cursor) args.cursor = opts.cursor;
    const payload = await this.call(RH_TOOLS.getCryptoOrders, args);
    return { orders: mapCryptoOrderStatuses(payload), cursor: nextCursor(payload) };
  }

  async getCryptoOrder(rhsAccountNumber: string, orderId: string): Promise<OrderStatus | null> {
    const payload = await this.call(RH_TOOLS.getCryptoOrders, {
      rhs_account_number: rhsAccountNumber,
      order_id: orderId,
    });
    return mapCryptoOrderStatuses(payload)[0] ?? null;
  }

  async getCryptoPositions(rhsAccountNumber: string): Promise<CryptoPosition[]> {
    return mapCryptoPositions(
      await this.call(RH_TOOLS.getCryptoPositions, { rhs_account_number: rhsAccountNumber }),
    );
  }

  async getCryptoQuotes(pairSymbols: string[]): Promise<CryptoQuote[]> {
    if (pairSymbols.length === 0) return [];
    return mapCryptoQuotes(await this.call(RH_TOOLS.getCryptoQuotes, { symbols: pairSymbols }));
  }

  mcpServerConfig(): { name: string; config: McpServerConfig } {
    return { name: "robinhood", config: { type: "http", url: SERVER_URL } };
  }
}
