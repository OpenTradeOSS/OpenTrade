import { assetTypeOf, orderKindOf, orderTypeOf, sideOf } from "@shared/analytics";
import type {
  Approval,
  ApprovalStatus,
  DecidedBy,
  OrderOutcome,
  ParsedOrder,
  PreToolUseDecision,
} from "@shared/approval";
import type { OrderStatus } from "@shared/broker";
import { legsLabel, type OptionContract } from "@shared/options";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { and, asc, desc, eq, isNull, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db/client";
import { approvals as approvalsTable, settings as settingsTable } from "../../db/schema";
import type { AgentRegistry } from "../agents/registry";
import { analytics } from "../analytics";
import type { AuditLog } from "../audit";
import { bus } from "../event-bus";
import type { StatusArbiter } from "../status/arbiter";
import { enrichCancelParsed, enrichOptionParsed, parseOrderInput, parseOrderResult } from "./parse";

// Shared with SettingsService, which writes the same `approval_timeout_sec` key.
const DEFAULT_TIMEOUT_SEC = DEFAULT_SETTINGS.approvalTimeoutSec;
/**
 * Upper bound on resolving an option order's contract ids before the card is
 * raised. The lookup is cache-first and normally instant; a cold miss is one MCP
 * round-trip. Past this the card goes up unresolved (`BUY 1 option …`) rather than
 * holding the agent's tool call — the gate must never hang on a display nicety.
 */
const CONTRACT_RESOLVE_MS = 4_000;

interface Waiter {
  resolve: (decision: PreToolUseDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * The approval gate. An intercepted order tool call enters via `request()`, which
 * either resolves immediately (full-auto agents) or registers a pending approval
 * and long-polls — the returned promise settles when the user decides, the
 * timeout fires (auto-deny), or the agent's session ends (`abandon`). Every
 * outcome is written to the audit log; the raw tool input is stored verbatim.
 */
export class ApprovalService {
  private waiters = new Map<string, Waiter>();
  /** Extra resolvers attached to a pending approval by joined duplicate requests. */
  private joiners = new Map<string, Array<(d: PreToolUseDecision) => void>>();
  /**
   * Look up a broker order by id (the cached agentic ledger). Injected after
   * construction because BrokerService depends on ApprovalService (`orderLinks`),
   * so the two can't be constructor-wired in a cycle. Used to enrich a cancel's
   * card with the target order's details (§6.9).
   */
  private resolveOrder: ((orderId: string) => OrderStatus | null) | null = null;
  /**
   * Resolve option contract ids to their identity, so an option order's card can
   * name the contract instead of a UUID. Injected like `resolveOrder` (same
   * dependency cycle); bounded by `CONTRACT_RESOLVE_MS`.
   */
  private resolveContracts: ((ids: string[]) => Promise<Map<string, OptionContract>>) | null = null;

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    private audit: AuditLog,
    private arbiter: StatusArbiter,
  ) {}

  /** Wire the ledger lookup used to enrich cancel cards. Called once at boot. */
  setOrderResolver(fn: (orderId: string) => OrderStatus | null): void {
    this.resolveOrder = fn;
  }

  /** Wire the option-contract lookup used to enrich option order cards. Called once at boot. */
  setContractResolver(fn: (ids: string[]) => Promise<Map<string, OptionContract>>): void {
    this.resolveContracts = fn;
  }

  /** Seconds the user is given before an order auto-denies. */
  get timeoutSec(): number {
    const row = this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, "approval_timeout_sec"))
      .get();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
  }

  /**
   * Entry point for the PreToolUse hook. Records the intent, then resolves with
   * the allow/deny decision the agent should receive.
   */
  async request(
    args: {
      agentId: string;
      toolName: string;
      rawInput: unknown;
    },
    opts?: { signal?: AbortSignal; joinDecidedMs?: number },
  ): Promise<PreToolUseDecision> {
    const agent = this.registry.get(args.agentId);
    const rawJson = JSON.stringify(args.rawInput ?? null);

    // Idempotent join. A harness may run more than one gate layer for ONE order call
    // and both funnel here — codex fires the PreToolUse hook AND the `approval_mode`
    // elicitation. Two shapes:
    //  1. PENDING-join (both callers): a request whose identical twin is still pending
    //     attaches to that card — one card, one audit trail, one answer.
    //  2. DECIDED-mirror (opt-in only): codex serializes its layers (hook decides
    //     first, then the elicitation fires a beat later), so the second arrival finds
    //     the first already DECIDED — not pending — and must mirror it, or the one
    //     order shows two cards. The codex elicitation answerer opts into this via
    //     `joinDecidedMs` (a short window). The PreToolUse hook path and claude pass
    //     nothing, so a re-fire there is treated as a GENUINE repeat order and gets a
    //     fresh card — never silently auto-approved (a real repeat needs a full model
    //     round-trip, far longer than the window, so it can't sneak through).
    const dup = this.latestByKey(args.agentId, args.toolName, rawJson);
    if (dup && dup.status === "pending" && this.waiters.has(dup.id)) {
      return new Promise<PreToolUseDecision>((resolve) => {
        const list = this.joiners.get(dup.id) ?? [];
        list.push(resolve);
        this.joiners.set(dup.id, list);
      });
    }
    const joinMs = opts?.joinDecidedMs ?? 0;
    if (
      dup &&
      joinMs > 0 &&
      dup.status !== "pending" &&
      dup.decidedAt &&
      Date.now() - dup.decidedAt < joinMs
    ) {
      return this.decisionFor(dup.id);
    }

    let parsed = parseOrderInput(args.toolName, args.rawInput);
    // A cancel tool call carries only the target order id, so its card would read
    // as a bare uuid. Resolve that id against the cached ledger (which includes
    // manually-placed RH orders) to show what's actually being cancelled.
    if (parsed.kind === "cancel" && parsed.cancelsOrderId && this.resolveOrder) {
      const o = this.resolveOrder(parsed.cancelsOrderId);
      parsed = enrichCancelParsed(
        parsed,
        o && {
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          orderType: o.type,
          limitPrice: o.limitPrice,
          dollarAmount: o.dollarAmount,
          assetType: o.assetType ?? "equity",
          instrument: o.assetType === "option" ? legsLabel(o.legs ?? []) : null,
          multiplier: o.multiplier ?? null,
        },
      );
    }
    // An option order — or an exercise — names its contracts only by UUID.
    // Resolve them (bounded) so the card and audit trail read `TLT $86C
    // 11/20/26`, not `option`. Applies to any option-parsed card carrying legs
    // (an ordinary order-cancel has none; it enriched from the ledger above).
    if (parsed.assetType === "option" && parsed.legs?.length && this.resolveContracts) {
      const ids = parsed.legs.map((l) => l.optionId).filter(Boolean);
      const contracts = await withTimeout(this.resolveContracts(ids), CONTRACT_RESOLVE_MS);
      if (contracts) parsed = enrichOptionParsed(parsed, contracts);
    }
    const id = nanoid();
    const now = Date.now();
    const timeoutSec = this.timeoutSec;

    this.db
      .insert(approvalsTable)
      .values({
        id,
        agentId: args.agentId,
        toolName: args.toolName,
        rawInput: rawJson,
        parsed: JSON.stringify(parsed),
        status: "pending",
        decidedBy: null,
        note: null,
        requestedAt: now,
        decidedAt: null,
      })
      .run();

    this.audit.append(
      "order_intent",
      { approvalId: id, toolName: args.toolName, parsed, summary: parsed.summary },
      args.agentId,
    );

    const mode = agent?.approvalMode ?? "approve";
    analytics.track("order_gate_prompted", {
      ...orderCategoricals(args.toolName, parsed),
      mode,
    });

    // Full-auto agents (or an unknown agent — fail safe by gating) decide instantly.
    if (agent?.approvalMode === "auto") {
      this.finalize(id, "approved", "auto", null);
      return this.decisionFor(id);
    }

    // Approve mode: surface a card and block until decided.
    this.syncPending(args.agentId);
    bus.emitEvent("approvals:changed", { agentId: args.agentId });
    const approval = this.toApproval(id)!;
    bus.emitEvent("approval:pending", approval);
    bus.emitEvent("notify", {
      kind: "approval",
      title: `${approval.agentName ?? "agent"} — Approval needed`,
      body: approval.parsed?.summary ?? approval.toolName,
      agentId: args.agentId,
    });

    return new Promise<PreToolUseDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finalize(
          id,
          "expired",
          "timeout",
          `No decision within ${timeoutSec}s — treated as declined. Do not retry; note it and continue.`,
        );
        this.wake(id);
      }, timeoutSec * 1000);
      this.waiters.set(id, { resolve, timer });
      // If the agent's session dies mid-poll, the order is moot — abandon it. The
      // signal may ALREADY be aborted (a listener added after abort never fires):
      // the contract resolution above can await up to CONTRACT_RESOLVE_MS, and the
      // hook can disconnect inside that window — without this check the card would
      // sit pending for the full approval timeout.
      if (opts?.signal?.aborted) this.abandon(id);
      else opts?.signal?.addEventListener("abort", () => this.abandon(id), { once: true });
    });
  }

  /** Most recent approval for this exact (agent, tool, raw input) key. */
  private latestByKey(agentId: string, toolName: string, rawInput: string) {
    return this.db
      .select()
      .from(approvalsTable)
      .where(
        and(
          eq(approvalsTable.agentId, agentId),
          eq(approvalsTable.toolName, toolName),
          eq(approvalsTable.rawInput, rawInput),
        ),
      )
      .orderBy(desc(approvalsTable.requestedAt))
      .get();
  }

  /** User pressed Approve/Reject in the UI. */
  decide(args: { id: string; approve: boolean; note?: string }): { ok: boolean } {
    const row = this.getRow(args.id);
    if (!row || row.status !== "pending") return { ok: false };
    this.finalize(
      args.id,
      args.approve ? "approved" : "rejected",
      "user",
      args.note?.trim() || null,
    );
    this.wake(args.id);
    return { ok: true };
  }

  /**
   * The agent's session ended while an order was pending — the tool call is gone,
   * so expire the row and let the (now-dead) long-poll fall through.
   */
  abandon(id: string): void {
    const row = this.getRow(id);
    if (!row || row.status !== "pending") return;
    this.finalize(id, "expired", "timeout", "Agent session ended before a decision.");
    this.wake(id);
  }

  /**
   * Record what the broker actually did with an approved order, reported by the
   * PostToolUse hook (the order tool's *result*). Distinct from the approval
   * decision: an approved order can still be rejected by Robinhood. Correlates to
   * the originating approval by (agentId, toolName, rawInput), taking the oldest
   * approved row that has no outcome yet — tool calls are serialized, so FIFO is
   * exact; identical back-to-back orders still each get one result.
   */
  recordOutcome(args: {
    agentId: string;
    toolName: string;
    rawInput: unknown;
    result: unknown;
  }): void {
    const outcome = parseOrderResult(args.result, args.toolName);
    analytics.track("order_submit_resolved", {
      result: outcome.ok === true ? "ok" : outcome.ok === false ? "rejected" : "unknown",
    });
    const rawInput = JSON.stringify(args.rawInput ?? null);

    // Primary: exact input match. Fallback: any approved-but-unrecorded order for
    // this agent+tool (guards against JSON key-order drift between the two hooks).
    const target =
      this.oldestUnrecorded(args.agentId, args.toolName, rawInput) ??
      this.oldestUnrecorded(args.agentId, args.toolName, null);

    if (target) {
      this.db
        .update(approvalsTable)
        .set({ outcome: JSON.stringify(outcome) })
        .where(eq(approvalsTable.id, target.id))
        .run();
    }
    this.audit.append(
      "order_observed",
      { approvalId: target?.id ?? null, toolName: args.toolName, ...outcome },
      args.agentId,
    );
    bus.emitEvent("approvals:changed", { agentId: args.agentId });
  }

  /** Oldest approved order with no outcome yet, optionally matching exact input. */
  private oldestUnrecorded(agentId: string, toolName: string, rawInput: string | null) {
    const conds = [
      eq(approvalsTable.agentId, agentId),
      eq(approvalsTable.toolName, toolName),
      eq(approvalsTable.status, "approved"),
      isNull(approvalsTable.outcome),
    ];
    if (rawInput !== null) conds.push(eq(approvalsTable.rawInput, rawInput));
    return this.db
      .select()
      .from(approvalsTable)
      .where(and(...conds))
      .orderBy(asc(approvalsTable.requestedAt))
      .get();
  }

  listPending(): Approval[] {
    return this.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.status, "pending"))
      .orderBy(desc(approvalsTable.requestedAt))
      .all()
      .map((r) => this.rowToApproval(r));
  }

  pendingCount(): number {
    return this.listPending().length;
  }

  /**
   * Which agent placed a given broker order, via the approval row's `outcome.orderId`
   * link (recorded by the PostToolUse hook in `recordOutcome`). Returns null for an
   * order OpenTrade didn't place (e.g. one entered manually in the Robinhood app), so
   * order notifications fire only for agent-placed orders (§12.4). Called only on
   * terminal ledger transitions — a handful of times a day — so the unindexed
   * `outcome` LIKE scan is fine.
   */
  agentForOrder(orderId: string): { agentId: string; agentName: string | null } | null {
    const rows = this.db
      .select()
      .from(approvalsTable)
      .where(like(approvalsTable.outcome, `%${orderId}%`))
      .all();
    for (const row of rows) {
      if (safeJson<OrderOutcome>(row.outcome)?.orderId === orderId) {
        return { agentId: row.agentId, agentName: this.registry.get(row.agentId)?.name ?? null };
      }
    }
    return null;
  }

  /** On boot, no hook is still long-polling — expire orphaned pending rows. */
  expireOrphansOnBoot(): void {
    const orphans = this.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.status, "pending"))
      .all();
    for (const row of orphans) {
      this.finalize(row.id, "expired", "timeout", "App restarted before a decision.");
    }
  }

  // ---- internals ----

  private finalize(id: string, status: ApprovalStatus, decidedBy: DecidedBy, note: string | null) {
    const row = this.getRow(id);
    if (!row) return;
    this.db
      .update(approvalsTable)
      .set({ status, decidedBy, note, decidedAt: Date.now() })
      .where(eq(approvalsTable.id, id))
      .run();
    this.audit.append(
      "approval_decision",
      { approvalId: id, status, decidedBy, note },
      row.agentId,
    );
    this.syncPending(row.agentId);
    bus.emitEvent("approvals:changed", { agentId: row.agentId });

    // `finalize` is the single funnel for every decision (user / auto / timeout /
    // abandon / boot-expiry), so one capture here covers them all. `pending` never
    // reaches this point.
    analytics.track("order_gate_decided", {
      decision: status as "approved" | "rejected" | "expired",
      decided_by: decidedBy,
      decision_ms: Math.max(0, Date.now() - row.requestedAt),
      ...orderCategoricals(row.toolName, safeJson<ParsedOrder>(row.parsed)),
    });
  }

  /** Resolve the long-poll waiting on this approval (and any joined duplicates). */
  private wake(id: string) {
    const decision = this.decisionFor(id);
    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve(decision);
    }
    for (const joined of this.joiners.get(id) ?? []) joined(decision);
    this.joiners.delete(id);
  }

  /** Recompute the agent's pending count and feed it to the status arbiter. */
  private syncPending(agentId: string) {
    const count = this.db
      .select()
      .from(approvalsTable)
      .where(and(eq(approvalsTable.agentId, agentId), eq(approvalsTable.status, "pending")))
      .all().length;
    this.arbiter.setPendingApprovals(agentId, count);
  }

  private decisionFor(id: string): PreToolUseDecision {
    const row = this.getRow(id);
    const allow = row?.status === "approved";
    if (allow) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      };
    }
    const reason =
      row?.note || "Order declined in OpenTrade. Do not retry; record it and continue.";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  private getRow(id: string) {
    return this.db.select().from(approvalsTable).where(eq(approvalsTable.id, id)).get();
  }

  private toApproval(id: string): Approval | null {
    const row = this.getRow(id);
    return row ? this.rowToApproval(row) : null;
  }

  private rowToApproval(row: typeof approvalsTable.$inferSelect): Approval {
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: this.registry.get(row.agentId)?.name ?? null,
      toolName: row.toolName,
      rawInput: row.rawInput,
      parsed: safeJson<ParsedOrder>(row.parsed),
      status: row.status as ApprovalStatus,
      decidedBy: (row.decidedBy as DecidedBy | null) ?? null,
      note: row.note,
      outcome: safeJson<OrderOutcome>(row.outcome),
      timeoutSec: this.timeoutSec,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
    };
  }
}

/** The categorical (never quantitative/identifying) shape of an order, for telemetry. */
function orderCategoricals(toolName: string, parsed: ParsedOrder | null) {
  return {
    kind: orderKindOf(parsed?.kind),
    asset_type: assetTypeOf(toolName),
    side: sideOf(parsed?.side),
    order_type: orderTypeOf(parsed?.orderType),
  };
}

function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Resolve to `null` if `p` neither settles nor errors within `ms`. Never throws. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
