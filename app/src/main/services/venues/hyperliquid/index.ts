import type { OrderStatus } from "@shared/broker";
import type { HyperliquidPortfolio, HyperliquidStatus } from "@shared/hyperliquid";
import { HYPERLIQUID_TOOL_BY_NAME } from "@shared/hyperliquid-tools";
import type { SaveHyperliquidInput, VaultStatus, VaultTestResult } from "@shared/vault";
import { hostLog } from "../../../host/log";
import type { ApprovalService } from "../../approvals";
import { HYPERLIQUID_TOOL_PREFIX } from "../../approvals/parse-hyperliquid";
import { bus } from "../../event-bus";
import type { VaultService } from "../../vault";
import {
  addressOf,
  createHyperliquidApi,
  type HyperliquidApi,
  HyperliquidApiError,
  type HyperliquidCredentials,
  hyperliquidInfo,
  normalizePrivateKey,
  type OrderStatusWire,
} from "./client";
import {
  type HyperliquidFill,
  mapBalances,
  mapOrders,
  mapPortfolio,
  mapPositions,
  num,
} from "./portfolio";
import {
  buildOrder,
  buildProtection,
  dexOf,
  HyperliquidInputError,
  intArg,
  isSpot,
  type MarketRef,
  positive,
  slippageArg,
  symbolArg,
} from "./requests";

/**
 * Account poll cadence. One poll is ~70 of the 1200/min request weight Hyperliquid
 * allows per IP, so this leaves the agents' own reads plenty of room.
 */
const POLL_MS = 20_000;
/** How long the list of builder-deployed dexs is trusted (new ones appear rarely). */
const DEXS_TTL_MS = 3_600_000;

export type HyperliquidCallResult = { ok: true; result: unknown } | { ok: false; error: string };

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;
type InfoFn = <T = unknown>(payload: Record<string, unknown>) => Promise<T>;

/** A write, validated and ready: what the approval card shows and how to send it. */
interface Prepared {
  /** The agent's args plus the card-only fields (see parse-hyperliquid.ts). */
  cardInput: Args;
  send: () => Promise<Json>;
}

/**
 * Executes the `hyperliquid` MCP server's tool calls on the host, where the API wallet
 * key lives.
 *
 * Same contract as `KalshiService`: every `write` tool waits on
 * `ApprovalService.request` — the same card, audit trail, timeout, and auto/approve
 * modes as every other order — before anything is signed. The key never leaves this
 * process, so an agent has no road to the account except through this path. Signing in
 * one process also keeps the API wallet's nonces (millisecond timestamps, tracked per
 * signer by Hyperliquid) from colliding.
 */
export class HyperliquidService {
  /** Rebuilt when the stored credentials change. */
  private client: { fingerprint: string; api: HyperliquidApi } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: HyperliquidStatus = OFF;
  private portfolio: HyperliquidPortfolio | null = null;
  private orders: OrderStatus[] = [];
  /** The account's bookkeeping mode (see `mapPortfolio`); changes rarely, read once. */
  private mode = new Map<string, string>();
  private dexs: { names: string[]; at: number } | null = null;

  constructor(
    private vault: VaultService,
    private approvals: ApprovalService,
    /** Injected in tests. */
    private makeApi: (creds: HyperliquidCredentials) => HyperliquidApi = createHyperliquidApi,
    private makeInfo: (env: HyperliquidCredentials["env"]) => InfoFn = hyperliquidInfo,
  ) {}

  // ---- vault: saving credentials needs the venue (which account approved this key?) ----

  /**
   * Store an API wallet key. The account it trades is looked up on Hyperliquid — an
   * approved API wallet reports the wallet that approved it — so the user pastes one
   * secret and nothing else. A MAIN wallet's key is refused: it can withdraw, and
   * OpenTrade should never hold one.
   */
  async save(input: SaveHyperliquidInput): Promise<VaultStatus> {
    const prior = this.vault.hyperliquidCredentials({ includeDisabled: true });
    const privateKey = input.privateKey ? normalizePrivateKey(input.privateKey) : prior?.privateKey;
    if (!privateKey) throw new Error("An API wallet private key is required.");
    const info = this.makeInfo(input.env);
    const apiWallet = addressOf(privateKey);
    const network = input.env === "testnet" ? "testnet" : "mainnet";

    const role = await info<{ role?: string; data?: { user?: string } }>({
      type: "userRole",
      user: apiWallet,
    });
    if (role?.role === "user" || role?.role === "subAccount" || role?.role === "vault") {
      throw new Error(
        "That is the key of a funded account, which can withdraw. Create an API wallet at app.hyperliquid.xyz/API and paste ITS private key instead.",
      );
    }
    const master = role?.role === "agent" ? role.data?.user?.toLowerCase() : undefined;
    if (!master) {
      throw new Error(
        `Hyperliquid ${network} doesn't know this API wallet (${apiWallet}). Approve it at app.hyperliquid.xyz/API first, or check you picked the right network.`,
      );
    }

    let account = master;
    const wanted = input.accountAddress?.toLowerCase();
    if (wanted && wanted !== master) {
      const r = await info<{ role?: string; data?: { master?: string } }>({
        type: "userRole",
        user: wanted,
      });
      const ownSub = r?.role === "subAccount" && r.data?.master?.toLowerCase() === master;
      if (!ownSub && r?.role !== "vault") {
        throw new Error(
          `${wanted} is not a sub-account or vault of ${master}, the wallet that approved this API wallet.`,
        );
      }
      account = wanted;
    }
    return this.vault.saveHyperliquid({
      privateKey,
      accountAddress: account as `0x${string}`,
      masterAddress: master as `0x${string}`,
      env: input.env,
    });
  }

  // ---- account view (right panel: Portfolio → Hyperliquid, the connected indicator) ----

  /** Start polling the account; re-evaluated whenever the vault changes. */
  start(): void {
    bus.onEvent("vault:changed", () => this.restart());
    this.restart();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): HyperliquidStatus {
    return this.state;
  }

  getPortfolio(): HyperliquidPortfolio | null {
    return this.portfolio;
  }

  /** Recent orders in the shared ledger shape (Activity joins them by order id). */
  getOrders(): OrderStatus[] {
    return this.orders;
  }

  private restart(): void {
    this.stop();
    const creds = this.vault.hyperliquidCredentials();
    if (!creds) {
      this.portfolio = null;
      this.orders = [];
      this.setState(OFF);
      return;
    }
    this.setState({
      ...this.state,
      state: "connecting",
      env: creds.env,
      account: creds.accountAddress,
      message: null,
    });
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  /** One account refresh: balances, positions, and recent orders for Activity. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    const creds = this.vault.hyperliquidCredentials();
    const api = this.apiFor(creds);
    if (!creds || !api) return;
    this.polling = true;
    try {
      const user = creds.accountAddress;
      const [portfolio, historical, fills] = await Promise.all([
        this.readAccount(api, user),
        api.info({ type: "historicalOrders", user }),
        api.info<HyperliquidFill[]>({ type: "userFills", user, aggregateByTime: false }),
      ]);
      this.portfolio = portfolio;
      this.orders = mapOrders(historical, Array.isArray(fills) ? fills : [], (c) => api.symbol(c));
      this.setState({
        state: "connected",
        env: creds.env,
        account: user,
        message: null,
        at: portfolio.at,
      });
      bus.emitEvent("hyperliquid:updated", { at: portfolio.at });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.state.message !== message) hostLog.warn("hyperliquid poll failed", message);
      this.setState({
        ...this.state,
        state: "error",
        env: creds.env,
        account: creds.accountAddress,
        message,
      });
    } finally {
      this.polling = false;
    }
  }

  private async readAccount(api: HyperliquidApi, user: string): Promise<HyperliquidPortfolio> {
    await api.loadSymbols();
    const dexs = await this.dexsOf(api);
    // Each builder-deployed dex (`xyz`, where the stock/commodity perps live, …) keeps
    // its own perp ledger, and the default query only covers the main one — so a
    // position in `xyz:BRENTOIL` is invisible unless every dex is asked.
    const [state, spot, mids, mode, ...dexStates] = await Promise.all([
      api.info({ type: "clearinghouseState", user }),
      api.info({ type: "spotClearinghouseState", user }),
      api.info<Record<string, string>>({ type: "allMids" }),
      this.modeOf(api, user),
      ...dexs.map((dex) => api.info({ type: "clearinghouseState", user, dex }).catch(() => null)),
    ]);
    const positions = [state, ...dexStates]
      .flatMap((s) => mapPositions(s, mids ?? {}))
      .sort((a, b) => (b.positionValue ?? 0) - (a.positionValue ?? 0));
    const balances = mapBalances(spot, (coin) => num(mids?.[api.coin(`${coin}/USDC`)]));
    return mapPortfolio([state, ...dexStates], positions, balances, mode, Date.now());
  }

  /** Names of the builder-deployed perp dexs (the main dex is the unnamed first entry). */
  private async dexsOf(api: HyperliquidApi): Promise<string[]> {
    if (this.dexs && Date.now() - this.dexs.at < DEXS_TTL_MS) return this.dexs.names;
    const list = await api
      .info<({ name?: string } | null)[]>({ type: "perpDexs" })
      .catch(() => null);
    if (!Array.isArray(list)) return this.dexs?.names ?? [];
    const names = list.map((d) => d?.name).filter((n): n is string => !!n);
    this.dexs = { names, at: Date.now() };
    return names;
  }

  private async modeOf(api: HyperliquidApi, user: string): Promise<string> {
    const cached = this.mode.get(user);
    if (cached) return cached;
    const mode = await api.info<unknown>({ type: "userAbstraction", user }).catch(() => null);
    if (typeof mode !== "string") return "default";
    this.mode.set(user, mode);
    return mode;
  }

  private setState(next: HyperliquidStatus): void {
    const changed =
      next.state !== this.state.state ||
      next.message !== this.state.message ||
      next.env !== this.state.env ||
      next.account !== this.state.account;
    this.state = next;
    if (changed) bus.emitEvent("hyperliquid:status", next);
  }

  // ---- agent tool calls ----

  async call(
    agentId: string,
    tool: string,
    args: Args,
    signal?: AbortSignal,
  ): Promise<HyperliquidCallResult> {
    const def = HYPERLIQUID_TOOL_BY_NAME.get(tool);
    if (!def) return { ok: false, error: `unknown tool: ${tool}` };
    const creds = this.vault.hyperliquidCredentials();
    const api = this.apiFor(creds);
    if (!creds || !api) {
      return {
        ok: false,
        error:
          "Hyperliquid is not connected. Ask the user to add a Hyperliquid API wallet in OpenTrade's Key Vault.",
      };
    }

    if (def.kind === "read") return guard(() => this.read(api, creds.accountAddress, tool, args));

    // Validate and resolve the write BEFORE the human sees it: a malformed order never
    // raises a card, and the card shows the real side/size/price.
    let prepared: Prepared;
    try {
      prepared = await this.prepare(api, creds.accountAddress, tool, args);
    } catch (err) {
      return { ok: false, error: describe(err) };
    }

    // ---- human gate ----
    const toolName = `${HYPERLIQUID_TOOL_PREFIX}${tool}`;
    const decision = await this.approvals.request(
      { agentId, toolName, rawInput: prepared.cardInput },
      { signal },
    );
    const out = decision.hookSpecificOutput;
    if (out.permissionDecision !== "allow") {
      return { ok: false, error: out.permissionDecisionReason ?? "Order declined." };
    }

    const sent = await guard(prepared.send);
    this.approvals.recordOutcome({
      agentId,
      toolName,
      rawInput: prepared.cardInput,
      result: outcomeResult(tool, sent),
    });
    this.mode.delete(creds.accountAddress);
    void this.pollOnce(); // the new/cancelled order shows up in Activity right away
    return sent;
  }

  private async prepare(
    api: HyperliquidApi,
    user: string,
    tool: string,
    args: Args,
  ): Promise<Prepared> {
    const symbol = symbolArg(args);
    const market = await this.market(api, symbol);

    if (tool === "cancel_order") {
      const oid = intArg(args.order_id, "order_id");
      return {
        cardInput: args,
        send: async () => {
          await api.cancel(market.asset, oid);
          return { cancelled: true, order_id: oid };
        },
      };
    }

    if (tool === "set_leverage") {
      if (market.kind === "spot")
        throw new HyperliquidInputError("Leverage applies to perps, not spot.");
      const leverage = intArg(args.leverage, "leverage");
      const cross = args.cross !== false;
      return {
        cardInput: args,
        send: async () => {
          await api.updateLeverage(market.asset, cross, leverage);
          return { symbol, leverage, margin: cross ? "cross" : "isolated" };
        },
      };
    }

    let order: Args = args;
    if (tool === "close_position") {
      if (market.kind === "spot") {
        throw new HyperliquidInputError(
          "close_position is for perps; sell a spot balance with place_order.",
        );
      }
      const dex = dexOf(symbol);
      const state = await api.info({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) });
      const open = mapPositions(state, {}).find((p) => p.symbol === symbol);
      if (!open) throw new HyperliquidInputError(`No open ${symbol} position to close.`);
      const size =
        args.size === undefined || args.size === null ? open.size : positive(args.size, "size");
      if (size > open.size) {
        throw new HyperliquidInputError(
          `The ${symbol} position is ${open.size}; can't close ${size}.`,
        );
      }
      order = {
        symbol,
        side: open.side === "long" ? "sell" : "buy",
        size,
        order_type: "market",
        reduce_only: true,
        slippage: slippageArg(args.slippage),
      };
    }

    // Validates; the wire orders are rebuilt at send time.
    const protection = buildProtection(order, market, buildOrder(order, market));
    return {
      cardInput: { ...order, ref_price: market.mid },
      send: async () => {
        // The card may have waited minutes: a market order is re-priced off the mid at
        // send time, so its slippage cap is measured from the price it actually meets.
        const fresh = order.order_type === "market" ? await this.market(api, symbol) : market;
        const entry = buildOrder(order, fresh);
        if (protection.length === 0) {
          const [status] = await api.order([entry]);
          return orderResult(symbol, status);
        }
        const [status] = await api.order(
          [entry, ...buildProtection(order, fresh, entry)],
          "normalTpsl",
        );
        return {
          ...orderResult(symbol, status),
          ...(order.stop_loss != null ? { stop_loss: order.stop_loss } : {}),
          ...(order.take_profit != null ? { take_profit: order.take_profit } : {}),
        };
      },
    };
  }

  /** Resolve a symbol to its asset id, lot size and current mid. */
  private async market(api: HyperliquidApi, symbol: string): Promise<MarketRef> {
    const dex = dexOf(symbol);
    await api.loadSymbols(dex);
    const asset = api.assetId(symbol);
    const szDecimals = api.szDecimals(symbol);
    if (asset === undefined || szDecimals === undefined) {
      throw new HyperliquidInputError(
        `Unknown market "${symbol}". Perps are named by coin (BTC), spot as BASE/QUOTE (HYPE/USDC), builder dex perps as dex:NAME (xyz:TSLA); spot BTC/ETH/SOL are UBTC/USDC, UETH/USDC, USOL/USDC; names are case-sensitive. See get_markets / get_spot_markets.`,
      );
    }
    const mids = await api.info<Record<string, string>>({
      type: "allMids",
      ...(dex ? { dex } : {}),
    });
    return {
      symbol,
      asset,
      szDecimals,
      kind: isSpot(symbol) ? "spot" : "perp",
      mid: num(mids?.[api.coin(symbol)]),
    };
  }

  private async read(
    api: HyperliquidApi,
    user: string,
    tool: string,
    args: Args,
  ): Promise<unknown> {
    switch (tool) {
      case "get_account": {
        const p = await this.readAccount(api, user);
        return {
          account: user,
          equity: p.equity,
          withdrawable_usdc: p.withdrawable,
          unrealized_pnl: p.unrealizedPnl,
          positions: p.positions,
          spot_balances: p.balances,
        };
      }
      case "get_markets": {
        const dex = typeof args.dex === "string" && args.dex ? args.dex : undefined;
        const [meta, ctxs] = await api.info<[{ universe: Json[] }, Json[]]>({
          type: "metaAndAssetCtxs",
          ...(dex ? { dex } : {}),
        });
        const keep = symbolSet(args.symbols);
        return meta.universe.flatMap((m, i): Json[] => {
          if (m.isDelisted === true || (keep && !keep.has(String(m.name)))) return [];
          return [
            {
              ...pick(m, "name", "szDecimals", "maxLeverage", "onlyIsolated"),
              ...pick(
                ctxs[i] ?? {},
                "markPx",
                "midPx",
                "oraclePx",
                "funding",
                "openInterest",
                "dayNtlVlm",
                "prevDayPx",
              ),
            },
          ];
        });
      }
      case "get_spot_markets": {
        await api.loadSymbols();
        const [meta, ctxs] = await api.info<[{ universe: Json[]; tokens: Json[] }, Json[]]>({
          type: "spotMetaAndAssetCtxs",
        });
        const ctxByCoin = new Map(ctxs.map((c) => [String(c.coin), c]));
        const keep = symbolSet(args.symbols);
        return meta.universe.flatMap((u): Json[] => {
          const coin = String(u.name);
          const symbol = api.symbol(coin);
          const ctx = ctxByCoin.get(coin) ?? {};
          // Unfiltered, skip the long tail of pairs nobody traded today.
          if (keep ? !keep.has(symbol) : !num(ctx.dayNtlVlm)) return [];
          return [
            {
              symbol,
              szDecimals: api.szDecimals(symbol),
              ...pick(ctx, "markPx", "midPx", "prevDayPx", "dayNtlVlm"),
            },
          ];
        });
      }
      case "get_mids": {
        await api.loadSymbols();
        const mids = await api.info<Record<string, string>>({ type: "allMids" });
        const keep = symbolSet(args.symbols);
        const out: Record<string, string> = {};
        for (const [coin, px] of Object.entries(mids ?? {})) {
          const symbol = api.symbol(coin);
          if (!keep || keep.has(symbol)) out[symbol] = px;
        }
        for (const dex of new Set([...(keep ?? [])].map(dexOf).filter((d): d is string => !!d))) {
          const dexMids = await api.info<Record<string, string>>({ type: "allMids", dex });
          for (const [coin, px] of Object.entries(dexMids ?? {}))
            if (keep?.has(coin)) out[coin] = px;
        }
        return out;
      }
      case "get_orderbook": {
        const symbol = symbolArg(args);
        await api.loadSymbols(dexOf(symbol));
        const depth = Math.min(20, Math.max(1, Number(args.depth) || 10));
        const book = await api.info<{ levels?: [Json[], Json[]]; time?: number } | null>({
          type: "l2Book",
          coin: api.coin(symbol),
        });
        if (!book?.levels) throw new HyperliquidInputError(`No order book for "${symbol}".`);
        return {
          symbol,
          time: book.time,
          bids: book.levels[0].slice(0, depth),
          asks: book.levels[1].slice(0, depth),
        };
      }
      case "get_candles": {
        const symbol = symbolArg(args);
        await api.loadSymbols(dexOf(symbol));
        const interval = String(args.interval ?? "");
        const ms = INTERVAL_MS[interval];
        if (!ms)
          throw new HyperliquidInputError("interval must be one of 1m, 5m, 15m, 1h, 4h, 1d.");
        const count = Math.min(500, Math.max(1, Number(args.count) || 100));
        const endTime = Date.now();
        const rows = await api.info<Json[]>({
          type: "candleSnapshot",
          req: { coin: api.coin(symbol), interval, startTime: endTime - count * ms, endTime },
        });
        return (rows ?? []).map((c) => ({
          time: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
        }));
      }
      case "get_open_orders": {
        await api.loadSymbols();
        // Open orders are per dex too (a stop on `xyz:BRENTOIL` is on the `xyz` dex).
        const dexs = await this.dexsOf(api);
        const lists = await Promise.all([
          api.info<Json[]>({ type: "frontendOpenOrders", user }),
          ...dexs.map((dex) =>
            api.info<Json[]>({ type: "frontendOpenOrders", user, dex }).catch(() => []),
          ),
        ]);
        return lists.flat().map((o) => ({
          order_id: o.oid,
          symbol: api.symbol(String(o.coin)),
          side: o.side === "B" ? "buy" : "sell",
          ...pick(
            o,
            "limitPx",
            "sz",
            "origSz",
            "orderType",
            "tif",
            "reduceOnly",
            "isTrigger",
            "triggerPx",
            "triggerCondition",
            "timestamp",
          ),
        }));
      }
      case "get_order": {
        await api.loadSymbols();
        const r = await api.info<Json>({
          type: "orderStatus",
          user,
          oid: intArg(args.order_id, "order_id"),
        });
        const order = (r?.order as Json | undefined)?.order as Json | undefined;
        if (order && typeof order.coin === "string") order.symbol = api.symbol(order.coin);
        return r;
      }
      case "get_fills": {
        await api.loadSymbols();
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
        const rows = await api.info<Json[]>({ type: "userFills", user, aggregateByTime: false });
        return (rows ?? []).slice(0, limit).map((f) => ({
          symbol: api.symbol(String(f.coin)),
          side: f.side === "B" ? "buy" : "sell",
          order_id: f.oid,
          ...pick(f, "px", "sz", "fee", "feeToken", "closedPnl", "dir", "time"),
        }));
      }
      default:
        throw new HyperliquidInputError(`unknown tool: ${tool}`);
    }
  }

  /**
   * Settings/onboarding "Test": prove the stored key is still an approved API wallet
   * for the account (the reads are public, so a balance alone would prove nothing).
   */
  async test(): Promise<VaultTestResult> {
    const creds = this.vault.hyperliquidCredentials({ includeDisabled: true });
    if (!creds) return { ok: false, message: "No Hyperliquid API wallet saved." };
    try {
      const info = this.makeInfo(creds.env);
      const wallet = addressOf(creds.privateKey);
      const role = await info<{ role?: string; data?: { user?: string } }>({
        type: "userRole",
        user: wallet,
      });
      if (role?.role !== "agent" || role.data?.user?.toLowerCase() !== creds.masterAddress) {
        return {
          ok: false,
          message:
            "This API wallet is no longer approved for the account (expired or replaced). Create a new one at app.hyperliquid.xyz/API.",
        };
      }
      const agents = await info<{ address?: string; validUntil?: number }[]>({
        type: "extraAgents",
        user: creds.masterAddress,
      }).catch(() => []);
      const until = (agents ?? []).find((a) => a.address?.toLowerCase() === wallet)?.validUntil;
      const api = this.apiFor(creds) ?? this.makeApi(creds);
      const p = await this.readAccount(api, creds.accountAddress);
      const net = creds.env === "testnet" ? " (testnet)" : "";
      const value = (p.equity ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
      const expiry = until
        ? ` API wallet valid until ${new Date(until).toISOString().slice(0, 10)}.`
        : "";
      return { ok: true, message: `Connected${net}. Account value ${value}.${expiry}` };
    } catch (err) {
      return { ok: false, message: describe(err) };
    }
  }

  private apiFor(creds: HyperliquidCredentials | null): HyperliquidApi | null {
    if (!creds) return null;
    const fingerprint = `${creds.env}|${creds.accountAddress}|${addressOf(creds.privateKey)}`;
    if (this.client?.fingerprint !== fingerprint) {
      try {
        this.client = { fingerprint, api: this.makeApi(creds) };
      } catch (err) {
        hostLog.warn("hyperliquid client init failed", String(err));
        return null;
      }
    }
    return this.client.api;
  }
}

const OFF: HyperliquidStatus = { state: "off", env: null, account: null, message: null, at: null };

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

async function guard(fn: () => Promise<unknown>): Promise<HyperliquidCallResult> {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    if (!(err instanceof HyperliquidInputError) && !(err instanceof HyperliquidApiError)) {
      hostLog.warn("hyperliquid call failed", String(err));
    }
    return { ok: false, error: describe(err) };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pick(o: Json, ...keys: string[]): Json {
  const out: Json = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function symbolSet(v: unknown): Set<string> | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return new Set(v.filter((s): s is string => typeof s === "string"));
}

/** An order action's per-order status → what the agent reads back. */
function orderResult(symbol: string, status: OrderStatusWire | undefined): Json {
  if (status && typeof status === "object") {
    if ("resting" in status) return { symbol, status: "open", order_id: status.resting.oid };
    if ("filled" in status) {
      return {
        symbol,
        status: "filled",
        order_id: status.filled.oid,
        filled_size: status.filled.totalSz,
        avg_price: status.filled.avgPx,
      };
    }
    if ("error" in status) throw new HyperliquidApiError(`Hyperliquid: ${status.error}`);
  }
  // e.g. "waitingForTrigger" (a trigger order has no id until it activates).
  return { symbol, status: typeof status === "string" ? status : "accepted" };
}

/**
 * Shape the result into what `parseOrderResult` (the outcome classifier shared with
 * Robinhood and Kalshi) reads: a place exposes `order_id` (a string, the ledger's join
 * key) + `status`; a cancel reads `data.accepted`; a failure is an MCP-style error.
 */
function outcomeResult(tool: string, sent: HyperliquidCallResult): unknown {
  if (!sent.ok) return { isError: true, content: [{ type: "text", text: sent.error }] };
  if (tool === "cancel_order") return { data: { accepted: true } };
  const r = (sent.result ?? {}) as Json;
  const id = r.order_id;
  return {
    ...r,
    order_id: id === undefined || id === null ? null : String(id),
    status: r.status ?? "accepted",
  };
}
