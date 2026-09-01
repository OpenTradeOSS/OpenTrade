import { z } from "zod";
import { OptionLeg } from "./options";

/**
 * Best-effort structured view of an order tool's input, parsed from the exact
 * Robinhood `tool_input`. The raw input is always kept verbatim on the approval
 * row; this is only for the human-facing card and is allowed to be incomplete.
 */
export const ParsedOrder = z.object({
  /** `exercise` = `exercise_option` (its cancel parses as `cancel`); additive for old rows. */
  kind: z.enum(["place", "cancel", "exercise", "unknown"]),
  symbol: z.string().nullable(),
  side: z.string().nullable(),
  quantity: z.number().nullable(),
  orderType: z.string().nullable(),
  limitPrice: z.number().nullable(),
  estCost: z.number().nullable(),
  /**
   * For a `cancel`, the RH order id it targets — the link back to the original
   * order's group, so a cancellation updates that order's card instead of opening
   * a new one. Null/absent for a place.
   */
  cancelsOrderId: z.string().nullable().optional(),
  /** Human-readable one-liner, e.g. "BUY 10 AAPL @ market — est. $2,150". */
  summary: z.string(),
  // ---- asset-specific (absent on equity rows and on rows written before these were modelled) ----
  assetType: z.enum(["equity", "option", "crypto"]).optional(),
  /**
   * What is being traded, for display where an equity would show its symbol: the
   * contract (`TLT $86C 11/20/26`) or, for a spread, the underlying + leg count.
   * For an option `symbol` is the underlying.
   */
  instrument: z.string().nullable().optional(),
  legs: z.array(OptionLeg).optional(),
  /** Shares per contract; `estCost` already includes it. */
  multiplier: z.number().nullable().optional(),
  /** Net "debit" | "credit" (multi-leg). */
  direction: z.string().nullable().optional(),
  stopPrice: z.number().nullable().optional(),
});
export type ParsedOrder = z.infer<typeof ParsedOrder>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const DecidedBy = z.enum(["user", "auto", "timeout"]);
export type DecidedBy = z.infer<typeof DecidedBy>;

/**
 * The submit-time result of an approved order, captured from the order tool's
 * *result* via the PostToolUse hook. Its job is to record the **orderId** — the
 * link to RH's authoritative ledger, which is the source of truth for execution
 * status — plus the submit-reject case RH never records as an order (e.g. a
 * market order in extended hours → `ok:false` + `message`, no order created).
 * `ok` is null when we can't classify the response.
 *
 * Non-strict by design: historical rows may still carry `state`/`filledQuantity`/
 * `fillPrice` from the old reconciliation model — Zod drops those extra keys, so
 * old `outcome` JSON blobs still parse without a DB migration.
 */
export const OrderOutcome = z.object({
  ok: z.boolean().nullable(),
  orderId: z.string().nullable(),
  message: z.string().nullable(),
  at: z.number(),
});
export type OrderOutcome = z.infer<typeof OrderOutcome>;

export const Approval = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  toolName: z.string(),
  /** Exact tool_input JSON from the hook, untouched (audit stays exact). */
  rawInput: z.string(),
  parsed: ParsedOrder.nullable(),
  status: ApprovalStatus,
  decidedBy: DecidedBy.nullable(),
  note: z.string().nullable(),
  /** Broker outcome for an approved order, once the PostToolUse hook reports it. */
  outcome: OrderOutcome.nullable(),
  /** Seconds the user has to decide (drives the card countdown). */
  timeoutSec: z.number(),
  requestedAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const AuditKind = z.enum([
  "order_intent",
  "approval_decision",
  "order_observed",
  "order_filled",
  "session_started",
  "session_ended",
  "broker_connected",
]);
export type AuditKind = z.infer<typeof AuditKind>;

export const AuditEntry = z.object({
  id: z.number(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  kind: AuditKind,
  payload: z.unknown(),
  at: z.number(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const DecideInput = z.object({
  id: z.string(),
  approve: z.boolean(),
  note: z.string().max(500).optional(),
});
export type DecideInput = z.infer<typeof DecideInput>;

/**
 * The PreToolUse hook decision the local server returns to `approval-gate.sh`,
 * which echoes it verbatim to Claude Code. `allow` lets the order tool run;
 * `deny` blocks it and surfaces `permissionDecisionReason` to the agent.
 */
export interface PreToolUseDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}
