import { errorNameOf } from "@shared/analytics";
import type {
  Account,
  BrokerConnectionStatus,
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
import { STANDARD_MULTIPLIER } from "@shared/options";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { brokerCache } from "../../db/schema";
import { hostLog } from "../../host/log";
import { analytics } from "../analytics";
import { bus } from "../event-bus";
import type { SettingsService } from "../settings";
import { type BrokerAdapter, ConnectSuperseded } from "./adapter";
import { brokerErrorCode, isTransientNetworkError } from "./network-error";
import { orderNotification, terminalTransition } from "./order-notify";

/**
 * The order ledger is kept *complete* via two tiers: a full history sweep that
 * rebuilds the whole map (at startup and once a day), plus a cheap recent window
 * fetched every poll to keep in-flight orders live. A complete ledger is what lets
 * the UI treat "no matching order" as a definitive non-execution rather than gray.
 */
const LEDGER_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Robinhood's MCP rate limits are generous, so we poll often for a near-live
// panel. The cadence (focused-during-market-hours vs otherwise) is user-tunable
// in Settings; see SettingsService.pollInterval{Focused,Blurred}Ms.

/**
 * A broker failure rendered for the **local** host log: class, machine code, message,
 * and the `cause` chain that carries the real reason for a wrapped `fetch failed`.
 *
 * `host.log` never leaves the machine — telemetry sends only the allowlisted class,
 * code and frames — so this is the one place the actual message survives, and the thing
 * that makes a poll failure diagnosable after the fact instead of only countable.
 * Bounded in depth and length: the log is append-only and never rotated, so a verbose
 * MCP payload must not be able to bloat it.
 */
function describeError(err: unknown): string {
  // Every read is guarded: this runs *first* in pollOnce's catch, so a throw here would
  // skip the telemetry below and convert a handled poll failure into an unhandled
  // rejection. A null-prototype object makes `String()` throw, and a `message`/`code`
  // getter can throw anything at all.
  try {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let depth = 0; cur != null && depth < 3; depth++) {
      const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
      let part: string;
      try {
        const code = e.code === undefined ? "" : ` (code=${String(e.code)})`;
        const msg = typeof e.message === "string" ? e.message : String(cur);
        part = `${errorNameOf(cur)}${code}: ${msg}`;
      } catch {
        part = "<unprintable>";
      }
      parts.push(part);
      cur = e.cause;
    }
    return parts.join(" ← ").slice(0, 500);
  } catch {
    return "<unprintable>";
  }
}

/** True during NY regular + extended hours on a weekday (holidays not handled). */
function marketActive(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 4 * 60 && minutes < 20 * 60; // 4:00–20:00 ET
}

/**
 * Owns the app's own read-only broker connection. Runs a single poller that
 * keeps a pull-through cache warm (Portfolio panel) and serves agents'
 * market-data faucet. The cache is freshness-tracked so faucet reads with a
 * maxAge can trigger an immediate live refetch.
 */
export class BrokerService {
  private status: BrokerConnectionStatus = "disconnected";
  private account: Account | null = null;
  private timer: NodeJS.Timeout | null = null;
  // Default to blurred: the host runs headless (often with no GUI), so it should
  // poll at the slower cadence until a connected GUI reports focus (see the
  // launcher's relay → broker.setFocused). Avoids hammering RH with the app closed.
  private focused = false;
  /** Guards against overlapping polls when a poll outlasts the poll interval. */
  private polling = false;
  /** Canonical order ledger (equity + option), merged across full sweeps + recent polls, keyed by id. */
  private ledger = new Map<string, OrderStatus>();
  /**
   * Every option contract we've learned the identity of, by `option_id`. Seeded
   * from the ledger's legs (each carries expiry/strike/type) and from
   * `get_option_instruments` lookups; persisted under cache key `option_contracts`
   * so a restart doesn't re-resolve. Contracts are immutable, so this never expires.
   */
  private contracts = new Map<string, OptionContract>();
  /** When the last full-history sweep ran; 0 forces a sweep on the next poll. */
  private lastFullSweepAt = 0;
  /**
   * The connect in flight, if any — two never run at once (the adapter's consent flow
   * relies on that). A silent connect joins it; an interactive one (a Connect click)
   * supersedes it, since a pending flow is most likely a browser consent the user
   * abandoned. Best-effort: if the click lands before the pending flow has bound its
   * loopback (a tick or two), the cancel is a no-op and the click just waits for it.
   */
  private inflight: Promise<void> | null = null;

  constructor(
    private db: Db,
    private adapter: BrokerAdapter,
    private settings: SettingsService,
    /** Links a broker order back to the agent that placed it (via the approval
     *  `outcome.orderId`), so order notifications fire only for agent-placed
     *  orders. A narrow slice of ApprovalService (§12.4). */
    private orderLinks: {
      agentForOrder(orderId: string): { agentId: string; agentName: string | null } | null;
    },
  ) {
    // Re-apply the poll cadence live when the user changes it in Settings.
    bus.onEvent("settings:changed", () => {
      if (this.timer) this.startPolling();
    });
    for (const c of this.readCache<OptionContract[]>("option_contracts")?.value ?? []) {
      if (c?.optionId) this.contracts.set(c.optionId, c);
    }
  }

  getStatus(): BrokerConnectionStatus {
    return this.status;
  }

  getAccount(): Account | null {
    return this.account;
  }

  mcpServerConfig() {
    return this.adapter.mcpServerConfig();
  }

  private setStatus(status: BrokerConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    bus.emitEvent("broker:status", { status });
  }

  /**
   * Connect and start polling. `interactive` (the explicit Connect button) allows a
   * browser re-consent when the stored session is dead; the silent boot auto-connect
   * omits it and just stays disconnected on a dead grant (§6.6).
   */
  async connect(opts: { interactive?: boolean } = {}): Promise<void> {
    // Join or supersede whatever is in flight, then re-check — another caller may
    // have started a new attempt while we waited.
    while (this.inflight) {
      if (this.status === "connected") return;
      if (!opts.interactive) return this.inflight;
      const current = this.inflight;
      this.adapter.cancelConnect?.();
      await current.catch(() => {});
    }
    if (this.status === "connected") return;
    const promise = this.runConnect(opts);
    this.inflight = promise;
    try {
      await promise;
    } finally {
      if (this.inflight === promise) this.inflight = null;
    }
  }

  private async runConnect(opts: { interactive?: boolean }): Promise<void> {
    this.setStatus("connecting");
    analytics.track("broker_connect_started", {
      mode: opts.interactive ? "interactive" : "silent",
    });
    try {
      await this.adapter.connect(opts);
      // A silent connect can end without a session — the stored grant was dead and the
      // adapter dropped it rather than pop a browser. That's not an error: reflect it as
      // disconnected so the UI shows the Connect CTA (which re-consents).
      if (!this.adapter.isConnected()) {
        this.setStatus("disconnected");
        return;
      }
      const accounts = await this.adapter.listAccounts();
      this.account = pickAccount(accounts);
      this.setStatus("connected");
      analytics.track("broker_connected");
      await this.pollOnce();
      this.startPolling();
    } catch (err) {
      // A newer connect took this one over (the user clicked Connect again): not a
      // failure — the newer attempt owns the status now, so leave it and report nothing.
      // The abandoned call resolves quietly rather than surfacing a spurious error.
      if (err instanceof ConnectSuperseded) return;
      this.setStatus("error");
      const code = brokerErrorCode(err);
      analytics.track("broker_connect_failed", {
        error_name: errorNameOf(err),
        ...(code ? { error_code: code } : {}),
      });
      throw err;
    }
  }

  /**
   * The explicit Reset/Disconnect action: abandon a consent still waiting on the
   * browser (the user closed the tab — nothing else can unstick "connecting"), forget
   * the stored session, stop polling. Status → `disconnected`, so the Connect CTA comes
   * back and the next Connect is a fresh consent. Also how a user switches accounts.
   */
  async disconnect(): Promise<void> {
    this.adapter.cancelConnect?.();
    // Let the in-flight connect unwind (a superseded one resolves quietly and leaves the
    // status alone — it's ours to set below).
    await this.inflight?.catch(() => {});
    this.stopPolling();
    this.adapter.reset();
    this.account = null;
    this.ledger.clear();
    this.offlineSince = null; // an outage doesn't span a deliberate disconnect
    this.failedPolls = 0;
    this.setStatus("disconnected");
  }

  /** True if we already have tokens and can connect without a browser. */
  isAuthorized(): boolean {
    return "hasTokens" in this.adapter
      ? (this.adapter as { hasTokens(): boolean }).hasTokens()
      : false;
  }

  setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    if (this.timer) this.startPolling();
  }

  private startPolling() {
    if (this.timer) clearInterval(this.timer);
    const interval =
      this.focused && marketActive()
        ? this.settings.pollIntervalFocusedMs
        : this.settings.pollIntervalBlurredMs;
    this.timer = setInterval(() => void this.pollOnce(), interval);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- pull-through cache ----

  private writeCache(key: string, payload: unknown) {
    this.db
      .insert(brokerCache)
      .values({ key, payload: JSON.stringify(payload), fetchedAt: Date.now() })
      .onConflictDoUpdate({
        target: brokerCache.key,
        set: { payload: JSON.stringify(payload), fetchedAt: Date.now() },
      })
      .run();
  }

  private readCache<T>(key: string): { value: T; fetchedAt: number } | null {
    const row = this.db.select().from(brokerCache).where(eq(brokerCache.key, key)).get();
    if (!row) return null;
    try {
      return { value: JSON.parse(row.payload) as T, fetchedAt: row.fetchedAt };
    } catch {
      return null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.account || this.polling) return;
    this.polling = true;
    const acct = this.account.accountNumber;
    const updated: string[] = [];
    try {
      const portfolio = await this.adapter.getPortfolio(acct);

      // Positions carry no price (RH: "call get_equity_quotes and multiply"), so
      // fetch quotes for the held symbols and fold last/marketValue/PnL into them
      // before caching — the Portfolio table and faucet read the enriched rows.
      const positions = await this.adapter.getPositions(acct);
      const symbols = positions.map((p) => p.symbol).filter(Boolean);
      let quotes: Quote[] = [];
      if (symbols.length > 0) {
        quotes = await this.adapter.getQuotes(symbols);
        for (const q of quotes) this.writeCache(`quote:${q.symbol}`, q);
        updated.push(...quotes.map((q) => `quote:${q.symbol}`));
      }
      const quoteBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
      const enriched = positions.map((p) => enrichPosition(p, quoteBySymbol.get(p.symbol)));
      this.writeCache("positions", enriched);
      updated.push("positions");

      // Options and crypto positions are ISOLATED failure domains: their APIs are
      // newer (crypto row shapes not yet live-verified), and a persistent failure
      // there must not stall the equity/portfolio refresh above or the order-ledger
      // sync below. On failure: keep the last cached value, log once per distinct
      // failure, and carry on. (The ledger stays all-or-nothing by design — the
      // "no match = definitive non-execution" verdict needs a COMPLETE ledger, so
      // a failed sweep keeping the previous complete one is safer than a partial.)
      // Options: positions name only the contract id + underlying; the contract's
      // strike/type comes from the resolved-contract map and the price from a quote.
      let optionPositions: OptionPosition[] = [];
      try {
        optionPositions = await this.pollOptionPositions(acct);
        this.writeCache("option_positions", optionPositions);
        updated.push("option_positions");
        this.assetPollWarnings.delete("option positions");
      } catch (err) {
        this.warnAssetPoll("option positions", describeError(err));
        optionPositions = this.readCache<OptionPosition[]>("option_positions")?.value ?? [];
      }

      // Crypto: positions carry no price either; fold in the pair quotes' mark.
      let cryptoPositions: CryptoPosition[] = [];
      try {
        cryptoPositions = await this.pollCryptoPositions();
        this.writeCache("crypto_positions", cryptoPositions);
        updated.push("crypto_positions");
        this.assetPollWarnings.delete("crypto positions");
      } catch (err) {
        this.warnAssetPoll("crypto positions", describeError(err));
        cryptoPositions = this.readCache<CryptoPosition[]>("crypto_positions")?.value ?? [];
      }

      // Today's account move: derived here because get_portfolio doesn't carry it.
      this.writeCache(
        "portfolio",
        withDayChange(portfolio, positions, quoteBySymbol, optionPositions, cryptoPositions),
      );
      updated.push("portfolio");

      await this.syncLedger(acct);
      this.writeCache("agentic_orders", [...this.ledger.values()]);
      updated.push("agentic_orders");

      bus.emitEvent("broker:updated", { keys: updated });
      this.notePollRecovered();
      this.noteOnline();
    } catch (err) {
      // `console.error` here went to the detached host's stdout, i.e. nowhere: the log
      // file had no record of a poll failure at all. hostLog is the only durable sink.
      this.logPollFailure(describeError(err));
      // A poll that was in flight when disconnect() ran fails by design (its client was
      // closed under it) — nothing to report, and it must not reopen outage tracking.
      if (this.status !== "connected") return;
      // Network outage (laptop sleep/wake, Wi‑Fi blip) → broker_offline; else app_error.
      if (isTransientNetworkError(err)) this.noteOffline(err);
      else analytics.trackError("broker", err, "caught", brokerErrorCode(err));
    } finally {
      this.polling = false;
    }
  }

  /** Last logged failure per isolated asset domain, so a persistent option/crypto
   *  fault writes ONE host.log line per distinct message, not one per 5s poll. */
  private assetPollWarnings = new Map<string, string>();

  private warnAssetPoll(domain: string, description: string): void {
    if (this.assetPollWarnings.get(domain) === description) return;
    this.assetPollWarnings.set(domain, description);
    hostLog.warn(`${domain} poll failed: ${description}`);
  }

  // ---- poll-failure logging (deduped) ----

  /** The last failure written to host.log, and how many identical ones followed it. */
  private lastFailureLog: string | null = null;
  private suppressedFailures = 0;

  /**
   * Log a poll failure once per *run* of identical failures. `host.log` is append-only
   * and never rotated, and the poll runs every 5–10 s, so logging every failure would
   * let one persistent fault (a revoked grant, a laptop offline overnight) grow the file
   * unboundedly — megabytes a day. A change in the failure is always logged; a repeat is
   * counted and reported once on recovery. This mirrors the dedup `broker_offline`
   * already applies to telemetry.
   */
  private logPollFailure(description: string): void {
    if (description === this.lastFailureLog) {
      this.suppressedFailures++;
      return;
    }
    if (this.lastFailureLog !== null) this.flushSuppressedFailures();
    this.lastFailureLog = description;
    hostLog.warn(`broker poll failed: ${description}`);
  }

  /** First success after failures: close the books so the next failure logs again. */
  private notePollRecovered(): void {
    if (this.lastFailureLog === null) return;
    this.flushSuppressedFailures();
    this.lastFailureLog = null;
  }

  private flushSuppressedFailures(): void {
    if (this.suppressedFailures > 0) {
      hostLog.info(`broker poll: ${this.suppressedFailures} further identical failure(s)`);
    }
    this.suppressedFailures = 0;
  }

  // ---- outage tracking (poll loop) ----

  /** When the current network outage began (first failed poll), or null if online. */
  private offlineSince: number | null = null;
  private failedPolls = 0;

  private noteOffline(err: unknown) {
    this.failedPolls++;
    if (this.offlineSince !== null) return;
    this.offlineSince = Date.now();
    const code = brokerErrorCode(err);
    analytics.track("broker_offline", code ? { error_code: code } : {});
  }

  private noteOnline() {
    if (this.offlineSince === null) return;
    analytics.track("broker_online", {
      offline_ms: Date.now() - this.offlineSince,
      failed_polls: this.failedPolls,
    });
    this.offlineSince = null;
    this.failedPolls = 0;
  }

  // ---- reads (cache-first) ----

  getCachedPortfolio(): { value: Portfolio; fetchedAt: number } | null {
    return this.readCache<Portfolio>("portfolio");
  }
  getCachedPositions(): { value: Position[]; fetchedAt: number } | null {
    return this.readCache<Position[]>("positions");
  }
  getAgenticOrdersCached(): { value: OrderStatus[]; fetchedAt: number } | null {
    return this.readCache<OrderStatus[]>("agentic_orders");
  }
  getCachedOptionPositions(): { value: OptionPosition[]; fetchedAt: number } | null {
    return this.readCache<OptionPosition[]>("option_positions");
  }
  getCachedCryptoPositions(): { value: CryptoPosition[]; fetchedAt: number } | null {
    return this.readCache<CryptoPosition[]>("crypto_positions");
  }

  /** The numeric brokerage id crypto tools key on (falls back to the account number). */
  private rhsAccount(): string | null {
    return this.account ? (this.account.rhsAccountNumber ?? this.account.accountNumber) : null;
  }

  /** Single-order lookup by id (resolves orders aged out of the poll window). */
  async getOrder(orderId: string): Promise<OrderStatus | null> {
    if (!this.account) return null;
    const acct = this.account.accountNumber;
    const rhs = this.rhsAccount();
    return (
      (await this.adapter.getOrder(acct, orderId)) ??
      (await this.adapter.getOptionOrder?.(acct, orderId)) ??
      (rhs ? await this.adapter.getCryptoOrder?.(rhs, orderId) : null) ??
      null
    );
  }

  // ---- option contracts ----

  /**
   * Resolve option contract ids to their identity, for the approval gate's card
   * (an order's `tool_input` names a contract only by UUID). Cache-first: the map
   * already holds every contract the ledger or positions have ever mentioned;
   * only genuinely new contracts (a first trade in a strike) go to
   * `get_option_instruments`, in one batched call. Unknown ids are simply absent
   * from the result — the card degrades to "option", never fails.
   */
  async resolveOptionContracts(optionIds: string[]): Promise<Map<string, OptionContract>> {
    const out = new Map<string, OptionContract>();
    const missing: string[] = [];
    for (const id of new Set(optionIds)) {
      const c = this.contracts.get(id);
      if (c) out.set(id, c);
      else missing.push(id);
    }
    if (missing.length > 0 && this.status === "connected" && this.adapter.getOptionContracts) {
      const fetched = await this.adapter.getOptionContracts(missing);
      this.rememberContracts(fetched);
      for (const c of fetched) out.set(c.optionId, c);
    }
    return out;
  }

  /** Learn contracts (from a lookup or a ledger's legs) and persist the map. */
  private rememberContracts(contracts: Iterable<OptionContract | null | undefined>): void {
    let changed = false;
    for (const c of contracts) {
      if (!c?.optionId) continue;
      const prev = this.contracts.get(c.optionId);
      // Keep the most complete record; a ledger leg may lack a field a lookup has.
      const merged: OptionContract = {
        optionId: c.optionId,
        chainSymbol: c.chainSymbol ?? prev?.chainSymbol ?? null,
        expirationDate: c.expirationDate ?? prev?.expirationDate ?? null,
        strikePrice: c.strikePrice ?? prev?.strikePrice ?? null,
        optionType: c.optionType ?? prev?.optionType ?? null,
        multiplier: c.multiplier ?? prev?.multiplier ?? null,
      };
      if (JSON.stringify(merged) !== JSON.stringify(prev)) {
        this.contracts.set(c.optionId, merged);
        changed = true;
      }
    }
    if (changed) this.writeCache("option_contracts", [...this.contracts.values()]);
  }

  /**
   * Open option positions with their contract identity and a live quote folded in.
   * Positions carry neither (RH: "look up strike/type via get_option_instruments";
   * price via get_option_quotes). Empty when the adapter has no options API.
   */
  private async pollOptionPositions(account: string): Promise<OptionPosition[]> {
    if (!this.adapter.getOptionPositions) return [];
    const raw = await this.adapter.getOptionPositions(account);
    if (raw.length === 0) return [];
    const ids = raw.map((p) => p.optionId).filter(Boolean);
    const contracts = await this.resolveOptionContracts(ids);
    const quotes = new Map<string, OptionQuote>();
    if (this.adapter.getOptionQuotes) {
      for (const q of await this.adapter.getOptionQuotes(ids)) quotes.set(q.optionId, q);
    }
    const positions = raw.map((p) =>
      enrichOptionPosition(p, contracts.get(p.optionId), quotes.get(p.optionId)),
    );
    return positions;
  }

  /** Faucet: cached option positions if fresh enough, else a live poll. */
  async getOptionPositionsLive(maxAgeMs: number): Promise<OptionPosition[]> {
    const cached = this.readCache<OptionPosition[]>("option_positions");
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status === "connected") await this.pollOnce();
    return this.readCache<OptionPosition[]>("option_positions")?.value ?? cached?.value ?? [];
  }

  /**
   * Open crypto holdings with each pair's quote folded in (positions ship without
   * a price, like equities). Quotes come back with unhyphenated symbols ("BTCUSD"),
   * so they're matched to positions by `assetCode + "USD"`. Empty when the adapter
   * has no crypto API or the account holds no coins.
   */
  private async pollCryptoPositions(): Promise<CryptoPosition[]> {
    const rhs = this.rhsAccount();
    if (!rhs || !this.adapter.getCryptoPositions) return [];
    const raw = await this.adapter.getCryptoPositions(rhs);
    if (raw.length === 0) return [];
    const quotes = new Map<string, CryptoQuote>();
    if (this.adapter.getCryptoQuotes) {
      const pairs = raw.map((p) => `${p.assetCode}-USD`);
      for (const q of await this.adapter.getCryptoQuotes(pairs)) quotes.set(q.symbol, q);
    }
    return raw.map((p) => enrichCryptoPosition(p, quotes.get(`${p.assetCode}USD`)));
  }

  /** Faucet: cached crypto positions if fresh enough, else a live poll. */
  async getCryptoPositionsLive(maxAgeMs: number): Promise<CryptoPosition[]> {
    const cached = this.readCache<CryptoPosition[]>("crypto_positions");
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status === "connected") await this.pollOnce();
    return this.readCache<CryptoPosition[]>("crypto_positions")?.value ?? cached?.value ?? [];
  }

  /**
   * Force a full-history sweep now, write the cache, and notify the GUI. Backs the
   * Activity "refresh" button — resolves only once the whole ledger is rebuilt, so
   * the button can spin until it returns.
   */
  async refreshOrders(): Promise<void> {
    if (!this.account) return;
    const acct = this.account.accountNumber;
    await this.fullSweep(acct);
    this.writeCache("agentic_orders", [...this.ledger.values()]);
    bus.emitEvent("broker:updated", { keys: ["agentic_orders"] });
  }

  /**
   * Keep the in-memory ledger complete. Every poll fetches the recent window
   * (cheap) and upserts it so in-flight orders stay live; once a day (and at
   * startup, since `lastFullSweepAt` begins at 0) it also rebuilds the whole map
   * from a full-history sweep so aged-out orders never silently disappear.
   */
  private async syncLedger(account: string): Promise<void> {
    if (Date.now() - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS) {
      await this.fullSweep(account);
    }
    const since = new Date(Date.now() - LEDGER_RECENT_WINDOW_MS).toISOString();
    for (const o of await this.fetchHistory(account, { createdAtGte: since })) {
      const prev = this.ledger.get(o.id);
      this.ledger.set(o.id, o); // recent wins: freshest state for in-flight orders
      // An order just reached a terminal state (filled/rejected/cancelled/…) → notify,
      // but only for orders an agent placed (linked via the approval outcome). On the
      // first poll the full sweep above has already seeded pre-existing terminal orders
      // with a terminal `prev`, so a host restart never re-notifies. Terminal states are
      // absorbing, so the prev-check dedupes without a separate notified-set. Gap: a
      // transition landing exactly in the daily full-sweep rebuild is silently absorbed.
      if (terminalTransition(prev, o)) {
        const link = this.orderLinks.agentForOrder(o.id); // only on transitions — rare
        if (link) bus.emitEvent("notify", orderNotification(o, link.agentName, link.agentId));
      }
    }
  }

  /** Rebuild the ledger from the account's entire order history. */
  private async fullSweep(account: string): Promise<void> {
    const all = await this.fetchHistory(account, {});
    this.ledger = new Map(all.map((o) => [o.id, o]));
    this.lastFullSweepAt = Date.now();
  }

  /**
   * Page through the account's order history via the pagination cursor — the
   * equity ledger plus, when the adapter has them, the option and crypto ledgers
   * (RH keeps three lists; we hold one). With no `createdAtGte` this walks the
   * *entire* history (higher page cap); with one it fetches just that recent
   * window. RH's lists for this account are small, so even a full sweep is a
   * handful of calls; the page guard caps it defensively. Option orders' legs name
   * their contracts, so the contract map learns every traded contract for free here.
   */
  private async fetchHistory(
    account: string,
    opts: { createdAtGte?: string },
  ): Promise<OrderStatus[]> {
    const all = await this.fetchPages((cursor) =>
      this.adapter.getAgenticOrders(account, { createdAtGte: opts.createdAtGte, cursor }),
    );
    const getOptionOrders = this.adapter.getOptionOrders?.bind(this.adapter);
    if (getOptionOrders) {
      const options = await this.fetchPages((cursor) =>
        getOptionOrders(account, { createdAtGte: opts.createdAtGte, cursor }),
      );
      this.rememberContracts(options.flatMap((o) => (o.legs ?? []).map((l) => l.contract)));
      all.push(...options);
    }
    const rhs = this.rhsAccount();
    const getCryptoOrders = this.adapter.getCryptoOrders?.bind(this.adapter);
    if (rhs && getCryptoOrders) {
      all.push(
        ...(await this.fetchPages((cursor) =>
          getCryptoOrders(rhs, { createdAtGte: opts.createdAtGte, cursor }),
        )),
      );
    }
    return all;
  }

  private async fetchPages(
    fetch: (cursor?: string) => Promise<{ orders: OrderStatus[]; cursor: string | null }>,
    maxPages = 100,
  ): Promise<OrderStatus[]> {
    const all: OrderStatus[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const { orders, cursor: next } = await fetch(cursor);
      all.push(...orders);
      if (!next) break;
      cursor = next;
    }
    return all;
  }

  /** Faucet: return cached quote if fresher than maxAgeMs, else fetch live. */
  async getQuote(symbol: string, maxAgeMs: number): Promise<Quote | null> {
    const cached = this.readCache<Quote>(`quote:${symbol}`);
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status !== "connected") return cached?.value ?? null;
    const [quote] = await this.adapter.getQuotes([symbol]);
    if (quote) {
      this.writeCache(`quote:${symbol}`, quote);
      bus.emitEvent("broker:updated", { keys: [`quote:${symbol}`] });
    }
    return quote ?? cached?.value ?? null;
  }

  async getPositionsLive(maxAgeMs: number): Promise<Position[]> {
    const cached = this.readCache<Position[]>("positions");
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status === "connected") await this.pollOnce();
    return this.readCache<Position[]>("positions")?.value ?? cached?.value ?? [];
  }
}

/** Prefer the funded agentic sub-account; fall back to default, then first. */
function pickAccount(accounts: Account[]): Account | null {
  return (
    accounts.find((a) => a.agentic) ?? accounts.find((a) => a.isDefault) ?? accounts[0] ?? null
  );
}

/** Fold a symbol's live quote into its position (last price, market value, PnL). */
function enrichPosition(p: Position, quote: Quote | undefined): Position {
  const last = quote?.last ?? p.lastPrice;
  if (last === null || last === undefined) return p;
  return {
    ...p,
    lastPrice: last,
    marketValue: last * p.quantity,
    unrealizedPnl: p.averageCost !== null ? (last - p.averageCost) * p.quantity : p.unrealizedPnl,
  };
}

/**
 * Fold a contract's identity and live quote into an option position. Units follow
 * RH: the quote is per share, the position's `averagePrice` is per contract with
 * the multiplier already in — so P&L is `(mark × multiplier − averagePrice) ×
 * contracts`, inverted for a short.
 */
export function enrichOptionPosition(
  p: OptionPosition,
  contract: OptionContract | undefined,
  quote: OptionQuote | undefined,
): OptionPosition {
  const out: OptionPosition = {
    ...p,
    strikePrice: contract?.strikePrice ?? p.strikePrice,
    optionType: contract?.optionType ?? p.optionType,
    expirationDate: p.expirationDate ?? contract?.expirationDate ?? null,
    multiplier: p.multiplier ?? contract?.multiplier ?? null,
  };
  const mark = quote?.mark ?? null;
  if (mark === null) return out;
  const mult = out.multiplier ?? STANDARD_MULTIPLIER;
  const sign = out.type === "short" ? -1 : 1;
  const perContract = mark * mult;
  return {
    ...out,
    lastPrice: mark,
    previousClose: quote?.previousClose ?? null,
    marketValue: perContract * p.quantity * sign,
    unrealizedPnl:
      p.averagePrice !== null ? (perContract - p.averagePrice) * p.quantity * sign : null,
  };
}

/**
 * Fold a pair quote into a crypto holding: mark → lastPrice, market value, and
 * P&L. The cost basis covers only **directly purchased** coins (transfers,
 * rewards, and forks carry none), so P&L is computed over `directQuantity` — the
 * lots whose cost is actually known — never extrapolated across the whole
 * holding. Identical to whole-position P&L in the common all-direct case; null
 * when no lot has a basis. All per coin; no multiplier, no shorts.
 */
export function enrichCryptoPosition(
  p: CryptoPosition,
  quote: CryptoQuote | undefined,
): CryptoPosition {
  const mark = quote?.mark ?? null;
  if (mark === null) return p;
  const basisQty = p.directQuantity ?? 0;
  return {
    ...p,
    lastPrice: mark,
    previousClose: quote?.previousClose ?? null,
    marketValue: mark * p.quantity,
    unrealizedPnl: p.avgCost !== null && basisQty > 0 ? (mark - p.avgCost) * basisQty : null,
  };
}

/**
 * Derive today's account $/% move and attach it to the portfolio. Robinhood
 * doesn't return a daily figure, so we sum each position's intraday-aware change
 * (RH's own method): shares held since yesterday move from previous_close; shares
 * bought today move from their cost basis. Option positions contribute the same
 * way in contract units (× multiplier, inverted for a short); crypto in coins,
 * against the prior **midnight-ET** boundary close (RH's "previous close" for a
 * 24/7 market — so "Today" for crypto means "since midnight ET"). % is against
 * the prior account value (total − today's change). Positions without a usable
 * quote are skipped.
 */
export function withDayChange(
  portfolio: Portfolio,
  positions: Position[],
  quotes: Map<string, Quote>,
  optionPositions: OptionPosition[] = [],
  cryptoPositions: CryptoPosition[] = [],
): Portfolio {
  let dayChange = 0;
  let counted = 0;
  for (const p of positions) {
    const q = quotes.get(p.symbol);
    if (!q || q.last === null || q.previousClose === null) continue;
    const intraday = p.intradayQuantity ?? 0;
    const overnight = p.quantity - intraday;
    const costToday = p.averageCost ?? q.last; // best available basis for today's shares
    dayChange += (q.last - q.previousClose) * overnight + (q.last - costToday) * intraday;
    counted++;
  }
  for (const p of optionPositions) {
    // Prices ride the enriched position itself (folded from the contract quote at
    // enrichment) — like crypto below. Reading them here, not a parallel quote map,
    // keeps options in "Today" even when a poll served cached positions (an
    // options-API outage would otherwise silently drop their whole contribution).
    if (p.lastPrice === null || p.previousClose === null) continue;
    const mult = p.multiplier ?? STANDARD_MULTIPLIER;
    const sign = p.type === "short" ? -1 : 1;
    const intraday = p.intradayQuantity ?? 0;
    const overnight = p.quantity - intraday;
    // Today's contracts move from their own (per-contract, multiplier-included) basis.
    const costToday = p.intradayAverageOpenPrice ?? p.averagePrice ?? p.lastPrice * mult;
    dayChange +=
      ((p.lastPrice - p.previousClose) * mult * overnight +
        (p.lastPrice * mult - costToday) * intraday) *
      sign;
    counted++;
  }
  for (const p of cryptoPositions) {
    // Prices ride the enriched position itself (folded from the pair quote).
    if (p.lastPrice === null || p.previousClose === null) continue;
    const intraday = p.intradayQuantity ?? 0;
    const overnight = p.quantity - intraday;
    const costToday = p.avgCost ?? p.lastPrice;
    dayChange += (p.lastPrice - p.previousClose) * overnight + (p.lastPrice - costToday) * intraday;
    counted++;
  }
  if (counted === 0) return { ...portfolio, dayChange: null, dayChangePct: null };

  const prior = portfolio.equity !== null ? portfolio.equity - dayChange : null;
  const dayChangePct = prior !== null && prior > 0 ? dayChange / prior : null;
  return { ...portfolio, dayChange, dayChangePct };
}
