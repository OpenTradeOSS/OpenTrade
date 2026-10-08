import { randomUUID } from "node:crypto";
import type { OrderStatus } from "@shared/broker";
import type { KalshiPortfolio, KalshiStatus } from "@shared/kalshi";
import { KALSHI_TOOL_BY_NAME } from "@shared/kalshi-tools";
import type { VaultTestResult } from "@shared/vault";
import { hostLog } from "../../../host/log";
import type { ApprovalService } from "../../approvals";
import { KALSHI_TOOL_PREFIX } from "../../approvals/parse-kalshi";
import { bus } from "../../event-bus";
import type { VaultService } from "../../vault";
import { KalshiApiError, KalshiClient, type KalshiCredentials } from "./client";
import { agentPositions, type KalshiFill, mapOrder, mapOrders, mapPortfolio } from "./portfolio";
import { buildKalshiRequest, KalshiInputError } from "./requests";

/** Account poll cadence for the Portfolio panel (Kalshi's read limits are generous). */
const POLL_MS = 20_000;

export type KalshiCallResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Executes the `kalshi` MCP server's tool calls on the host, where the key lives.
 *
 * The approval gate is enforced HERE, server-side, not by a CLI hook: every `write`
 * tool (place/cancel) waits on `ApprovalService.request` — the same card, audit trail,
 * timeout, and auto/approve modes as Robinhood orders — before anything is signed and
 * sent. Because the private key never leaves this process, an agent has no way to
 * reach Kalshi except through this path, so the gate can't be routed around from the
 * agent's shell, and both harnesses (claude, codex) get identical gating for free.
 */
export class KalshiService {
  /** Rebuilt when the stored credentials change (keyed by their identity). */
  private client: { fingerprint: string; client: KalshiClient } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: KalshiStatus = { state: "off", env: null, message: null, at: null };
  private portfolio: KalshiPortfolio | null = null;
  private orders: OrderStatus[] = [];
  /** Fills of agent orders that can no longer change (executed/canceled), by order id. */
  private finalFills = new Map<string, KalshiFill[]>();
  /** Agent orders in a final state, so they aren't re-fetched every poll. */
  private finalOrders = new Map<string, OrderStatus>();

  constructor(
    private vault: VaultService,
    private approvals: ApprovalService,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  // ---- account view (right panel: Portfolio → Kalshi, the connected indicator) ----

  /** Start polling the account; re-evaluated whenever the vault changes. */
  start(): void {
    bus.onEvent("vault:changed", () => this.restart());
    this.restart();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): KalshiStatus {
    return this.state;
  }

  getPortfolio(): KalshiPortfolio | null {
    return this.portfolio;
  }

  /** Recent orders in the shared ledger shape (Activity joins them by order id). */
  getOrders(): OrderStatus[] {
    return this.orders;
  }

  private restart(): void {
    this.stop();
    const creds = this.vault.kalshiCredentials();
    if (!creds) {
      this.portfolio = null;
      this.orders = [];
      this.setState({ state: "off", env: null, message: null, at: null });
      return;
    }
    this.setState({ state: "connecting", env: creds.env, message: null, at: this.state.at });
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  /**
   * One account refresh: cash, the AGENTS' positions (attributed from the fills of
   * orders they placed through the gate — Kalshi has no agent-only sub-account), the
   * markets those positions are in, and recent orders for Activity.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    const creds = this.vault.kalshiCredentials();
    const client = this.clientFor(creds);
    if (!creds || !client) return;
    this.polling = true;
    try {
      const agentOrders = this.approvals.kalshiAgentOrders?.() ?? new Map<string, string>();
      const [balance, recent] = await Promise.all([
        client.send({ method: "GET", path: "/portfolio/balance" }),
        client.send({ method: "GET", path: "/portfolio/orders", query: { limit: "200" } }),
      ]);
      const orders = new Map(mapOrders(recent).map((o) => [o.id, o]));

      const fills: KalshiFill[] = [];
      for (const orderId of agentOrders.keys()) {
        const order = orders.get(orderId) ?? (await this.agentOrder(client, orderId));
        if (order) orders.set(orderId, order);
        const cached = this.finalFills.get(orderId);
        if (cached) {
          fills.push(...cached);
          continue;
        }
        const r = (await client
          .send({
            method: "GET",
            path: "/portfolio/fills",
            query: { order_id: orderId, limit: "200" },
          })
          .catch(() => null)) as { fills?: KalshiFill[] } | null;
        const got = r?.fills ?? [];
        if (order && isFinal(order)) this.finalFills.set(orderId, got);
        fills.push(...got);
      }

      const tickers = [...new Set(fills.map((f) => f.ticker).filter((t): t is string => !!t))];
      const markets = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < tickers.length; i += 100) {
        const chunk = tickers.slice(i, i + 100);
        const r = (await client.send({
          method: "GET",
          path: "/markets",
          query: { tickers: chunk.join(","), limit: String(chunk.length) },
        })) as { markets?: Record<string, unknown>[] };
        for (const m of r?.markets ?? [])
          if (typeof m.ticker === "string") markets.set(m.ticker, m);
      }

      const at = Date.now();
      this.portfolio = mapPortfolio(balance, agentPositions(fills, agentOrders, markets), at);
      this.orders = [...orders.values()];
      this.setState({ state: "connected", env: creds.env, message: null, at });
      bus.emitEvent("kalshi:updated", { at });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.state.message !== message) hostLog.warn("kalshi poll failed", message);
      this.setState({ state: "error", env: creds.env, message, at: this.state.at });
    } finally {
      this.polling = false;
    }
  }

  /** An agent order outside the recent window (cached once final). Null if unreadable. */
  private async agentOrder(client: KalshiClient, orderId: string): Promise<OrderStatus | null> {
    const cached = this.finalOrders.get(orderId);
    if (cached) return cached;
    const r = (await client
      .send({ method: "GET", path: `/portfolio/orders/${encodeURIComponent(orderId)}` })
      .catch(() => null)) as { order?: Record<string, unknown> } | null;
    const order = r?.order ? mapOrder(r.order) : null;
    if (order && isFinal(order)) this.finalOrders.set(orderId, order);
    return order;
  }

  private setState(next: KalshiStatus): void {
    const changed =
      next.state !== this.state.state ||
      next.message !== this.state.message ||
      next.env !== this.state.env;
    this.state = next;
    if (changed) bus.emitEvent("kalshi:status", next);
  }

  async call(
    agentId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<KalshiCallResult> {
    const def = KALSHI_TOOL_BY_NAME.get(tool);
    if (!def) return { ok: false, error: `unknown tool: ${tool}` };
    const client = this.clientFor(this.vault.kalshiCredentials());
    if (!client) {
      return {
        ok: false,
        error:
          "Kalshi is not connected. Ask the user to add Kalshi credentials in OpenTrade's Key Vault.",
      };
    }

    let req: ReturnType<typeof buildKalshiRequest>;
    try {
      req = buildKalshiRequest(tool, args);
    } catch (err) {
      if (err instanceof KalshiInputError) return { ok: false, error: err.message };
      throw err;
    }

    if (def.kind === "read") return this.send(client, req);

    // ---- write: human gate first ----
    const toolName = `${KALSHI_TOOL_PREFIX}${tool}`;
    const decision = await this.approvals.request(
      { agentId, toolName, rawInput: args },
      { signal },
    );
    const out = decision.hookSpecificOutput;
    if (out.permissionDecision !== "allow") {
      return { ok: false, error: out.permissionDecisionReason ?? "Order declined." };
    }

    // Idempotency key minted after approval, so the approved input is exactly what
    // the agent sent; a transport retry of this same request can't double-place.
    if (req.body) req.body.client_order_id = randomUUID();
    const sent = await this.send(client, req);
    this.approvals.recordOutcome({
      agentId,
      toolName,
      rawInput: args,
      result: outcomeResult(tool, sent),
    });
    void this.pollOnce(); // the new/cancelled order shows up in Activity right away
    return sent;
  }

  /** Settings/onboarding "Test": an authenticated balance read with the stored key. */
  async test(): Promise<VaultTestResult> {
    const creds = this.vault.kalshiCredentials({ includeDisabled: true });
    if (!creds) return { ok: false, message: "No Kalshi credentials saved." };
    let client: KalshiClient;
    try {
      client = new KalshiClient(creds, this.fetchImpl);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    const r = await this.send(client, { method: "GET", path: "/portfolio/balance" });
    if (!r.ok) return { ok: false, message: r.error };
    const cents = (r.result as { balance?: number } | null)?.balance;
    const env = creds.env === "demo" ? " (demo)" : "";
    return {
      ok: true,
      message:
        typeof cents === "number"
          ? `Connected${env}. Cash balance ${(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}.`
          : `Connected${env}.`,
    };
  }

  private clientFor(creds: KalshiCredentials | null): KalshiClient | null {
    if (!creds) return null;
    const fingerprint = `${creds.env}|${creds.keyId}|${creds.privateKeyPem.length}|${creds.privateKeyPem.slice(-40)}`;
    if (this.client?.fingerprint !== fingerprint) {
      try {
        this.client = { fingerprint, client: new KalshiClient(creds, this.fetchImpl) };
      } catch (err) {
        hostLog.warn("kalshi client init failed", String(err));
        return null;
      }
    }
    return this.client.client;
  }

  private async send(
    client: KalshiClient,
    req: ReturnType<typeof buildKalshiRequest>,
  ): Promise<KalshiCallResult> {
    try {
      return { ok: true, result: await client.send(req) };
    } catch (err) {
      if (err instanceof KalshiApiError) return { ok: false, error: err.message };
      const msg = err instanceof Error ? err.message : String(err);
      hostLog.warn("kalshi request failed", req.method, req.path, msg);
      return { ok: false, error: `Kalshi request failed: ${msg}` };
    }
  }
}

/** Filled or cancelled: its fills can't change any more. */
function isFinal(o: OrderStatus): boolean {
  return o.state === "filled" || /cancel/.test(o.state ?? "");
}

/**
 * Shape the Kalshi response into what `parseOrderResult` (the PostToolUse classifier
 * shared with Robinhood) reads: a place exposes `order_id`; a cancel reads
 * `data.accepted`; a failure is an MCP-style error result.
 */
function outcomeResult(tool: string, sent: KalshiCallResult): unknown {
  if (!sent.ok) return { isError: true, content: [{ type: "text", text: sent.error }] };
  if (tool === "cancel_order") return { data: { accepted: true } };
  const r = (sent.result ?? {}) as Record<string, unknown>;
  return { order_id: r.order_id ?? null, status: "accepted", ...r };
}
