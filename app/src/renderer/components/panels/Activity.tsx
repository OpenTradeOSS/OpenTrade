import type { AuditEntry, ParsedOrder } from "@shared/approval";
import type { OrderStatus } from "@shared/broker";
import { legsLabel, STANDARD_MULTIPLIER } from "@shared/options";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useActivity } from "../../hooks/useActivity";
import { useAgenticOrders, useLedgerReady, useRefreshOrders } from "../../hooks/useBroker";
import {
  type ActivityGroup,
  fromRhState,
  groupActivity,
  type OrderState,
  orderState,
} from "../../lib/activity-groups";
import { ago, num, signedUsd, usd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PendingApprovals } from "./PendingApprovals";

export function Activity() {
  const selectedId = useUIStore((s) => s.selectedAgentId);
  const [scope, setScope] = useState<"agent" | "all">("agent");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const agentId = scope === "agent" ? (selectedId ?? undefined) : undefined;
  const feed = useActivity(agentId);
  const groups = groupActivity(feed);

  // Join key → RH's authoritative status. Each `order_observed` audit entry carries
  // both the approvalId (the group key) and the broker orderId, so we read the
  // approvalId → orderId link straight off the feed: approvalId → orderId → live
  // OrderStatus.
  const orders = useAgenticOrders();
  const ledgerReady = useLedgerReady();
  const orderIdByApproval = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of feed) {
      if (e.kind !== "order_observed") continue;
      const p = e.payload as { approvalId?: string | null; orderId?: string | null } | null;
      if (p?.approvalId && p.orderId) map.set(p.approvalId, p.orderId);
    }
    return map;
  }, [feed]);

  // One clock for the whole render so every row's settle-grace agrees.
  const now = Date.now();

  // Time-sorted union of OpenTrade groups and (in "All") every other order on the
  // account. An order is "external" — not initiated here — when no approval claims
  // its id; those render as greyed, unexpandable rows.
  const claimed = useMemo(() => new Set(orderIdByApproval.values()), [orderIdByApproval]);
  const rows: Row[] = groups.map((g) => ({ kind: "group", at: g.latest.at, group: g }));
  if (scope === "all") {
    for (const o of orders.values()) {
      if (!claimed.has(o.id)) rows.push({ kind: "external", at: orderAt(o), status: o });
    }
  }
  rows.sort((a, b) => b.at - a.at);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col p-4">
      {/* The approval gate's pending queue (renders nothing when empty). */}
      <PendingApprovals />

      {/* History header: title on the left, scope toggle + refresh on the right. */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionLabel>History</SectionLabel>
        <div className="flex items-center gap-1">
          <ToggleGroup
            type="single"
            value={scope}
            onValueChange={(v) => v && setScope(v as "agent" | "all")}
            className="gap-1"
          >
            <ToggleGroupItem
              value="agent"
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground data-[state=on]:bg-muted data-[state=on]:font-medium data-[state=on]:text-foreground"
            >
              This agent
            </ToggleGroupItem>
            <ToggleGroupItem
              value="all"
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground data-[state=on]:bg-muted data-[state=on]:font-medium data-[state=on]:text-foreground"
            >
              All
            </ToggleGroupItem>
          </ToggleGroup>
          <RefreshButton />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No trades yet.</p>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => {
            if (row.kind === "external") {
              return <ExternalRow key={`ext-${row.status.id}`} status={row.status} />;
            }
            const g = row.group;
            const orderId = orderIdByApproval.get(g.key) ?? null;
            return (
              <GroupRow
                key={g.key}
                group={g}
                status={orderId ? (orders.get(orderId) ?? null) : null}
                orderId={orderId}
                now={now}
                ledgerReady={ledgerReady}
                showAgent={scope === "all"}
                expanded={expanded.has(g.key)}
                onToggle={() => toggle(g.key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Small uppercase section heading. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

/** A row in the unified Activity list: an OpenTrade order group or an external order. */
type Row =
  | { kind: "group"; at: number; group: ActivityGroup }
  | { kind: "external"; at: number; status: OrderStatus };

/** Best-effort timestamp (ms) for an external order, for the merged sort. */
function orderAt(s: OrderStatus): number {
  const t = s.lastTransactionAt ?? s.createdAt;
  const ms = t ? Date.parse(t) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Right-aligned toolbar button that forces a full order-history refresh. */
function RefreshButton() {
  const refresh = useRefreshOrders();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", refresh.isPending && "animate-spin")} />
        </button>
      </TooltipTrigger>
      <TooltipContent>Refresh full order history</TooltipContent>
    </Tooltip>
  );
}

function GroupRow({
  group,
  status,
  orderId,
  now,
  ledgerReady,
  showAgent,
  expanded,
  onToggle,
}: {
  group: ActivityGroup;
  status: OrderStatus | null;
  orderId: string | null;
  now: number;
  ledgerReady: boolean;
  showAgent: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { latest } = group;
  const state = orderState(group, status, orderId, now, ledgerReady);
  const tone = toneForState(state, group);
  const view = headerView(group, status);
  const canExpand = group.entries.length > 1;

  const header = (
    <div className="flex items-start gap-2 py-2 text-sm">
      {canExpand ? (
        // Status dot by default; the expand arrow reveals on hover (rotated when open).
        <span className="relative flex h-5 w-3.5 shrink-0 items-center justify-center">
          <span
            className={cn("size-1.5 rounded-full transition-opacity group-hover:opacity-0", tone)}
          />
          <ChevronRight
            className={cn(
              "absolute size-3.5 text-muted-foreground opacity-0 transition-all group-hover:opacity-100",
              expanded && "rotate-90",
            )}
          />
        </span>
      ) : (
        <span className="flex h-5 shrink-0 items-center">
          <span className={cn("size-1.5 rounded-full", tone)} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-foreground">{view.primary}</span>
          {view.total && <span className="shrink-0 text-foreground">{view.total}</span>}
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="shrink-0">
            {ago(latest.at)}
            {showAgent && group.agentName ? ` · ${group.agentName}` : ""}
          </span>
          {view.breakdown && <span className="min-w-0 truncate text-right">{view.breakdown}</span>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="border-t border-border first:border-t-0">
      {canExpand ? (
        <button type="button" onClick={onToggle} className="group w-full text-left">
          {header}
        </button>
      ) : (
        header
      )}
      {canExpand && expanded && (
        <div className="mb-2 ml-5 flex flex-col">
          {stagesFor(group, state).map((s, i, all) => (
            <StageRow key={s.key} stage={s} isFirst={i === 0} isLast={i === all.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One row of the expanded timeline: a label, a dot tone, and an optional time. */
interface Stage {
  key: string;
  label: string;
  tone: string;
  at: number | null;
}

/**
 * The timeline stages for an expanded group. These are the real audit entries,
 * plus — for a `failed` order whose timeline has no terminal failure entry of its
 * own (e.g. a verification-blocked order: proposed → approved, then nothing) — a
 * synthesized "Order rejected by broker" closer so the list visibly ends in failure. The
 * synthetic stage is render-only; it is never persisted.
 */
function stagesFor(group: ActivityGroup, state: OrderState): Stage[] {
  const stages: Stage[] = group.entries.map((e) => {
    const { label, tone } = describe(e);
    return { key: `e${e.id}`, label, tone, at: e.at };
  });
  // Skip the synthetic closer when a cancel is folded in: the order didn't get
  // rejected, it was cancelled, and the cancel stages already end the timeline.
  if (state === "failed" && !hasFailureStage(group) && !containsCancel(group)) {
    stages.push({
      key: "not-filled",
      label: "Order rejected by broker",
      tone: "bg-destructive",
      at: null,
    });
  }
  return stages;
}

/** Does this group include a folded-in cancel (its own terminal explanation)? */
function containsCancel(group: ActivityGroup): boolean {
  return group.entries.some((e) =>
    isCancelTool((e.payload as { toolName?: unknown } | null)?.toolName),
  );
}

/** Does the timeline already carry a terminal failure entry (RH reject / gate reject-expire)? */
function hasFailureStage(group: ActivityGroup): boolean {
  return group.entries.some((e) => {
    if (e.kind === "order_observed") return (e.payload as { ok?: unknown } | null)?.ok === false;
    if (e.kind === "approval_decision") {
      const s = (e.payload as { status?: unknown } | null)?.status;
      return s === "rejected" || s === "expired";
    }
    return false;
  });
}

/**
 * A single lifecycle stage shown inside an expanded group. The marker column is a
 * dot with line segments above and below it; consecutive rows' segments meet to
 * form one continuous spine threading through every dot (suppressed above the
 * first dot and below the last).
 */
function StageRow({ stage, isFirst, isLast }: { stage: Stage; isFirst: boolean; isLast: boolean }) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="flex w-1.5 shrink-0 flex-col items-center">
        {/* top segment, stopping short of the dot (the 5px dot margin is the gap) */}
        <span
          className={cn("h-[2px] w-[2.5px] shrink-0", isFirst ? "bg-transparent" : "bg-border")}
        />
        <span className={cn("my-[5px] size-1.5 shrink-0 rounded-full", stage.tone)} />
        {/* bottom segment: dot → row bottom, meeting the next row's top segment */}
        <span className={cn("w-[2px] flex-1", isLast ? "bg-transparent" : "bg-border")} />
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="text-foreground">{stage.label}</div>
        {stage.at != null && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{ago(stage.at)}</div>
        )}
      </div>
    </div>
  );
}

/** Dot color for an order state, or null for proposed/other (caller picks a fallback). */
function baseTone(state: OrderState): string | null {
  switch (state) {
    case "filled":
      return "bg-success"; // it executed
    case "failed":
      return "bg-destructive";
    case "working":
      return "bg-warning"; // in flight / partially filled
    case "unknown":
      return "bg-muted-foreground/60"; // approved, never linked to a broker order
    default:
      return null; // proposed / other
  }
}

function toneForState(state: OrderState, group: ActivityGroup): string {
  return baseTone(state) ?? describe(group.latest).tone;
}

/** The collapsed header type shared by OpenTrade groups and external orders. */
interface HeaderView {
  primary: string;
  total: string | null;
  breakdown: string | null;
}

/**
 * The executed cost line from RH's live `OrderStatus`: real cumulative shares @
 * VWAP, never a placement estimate — so a not-yet-filled order shows no numbers.
 * Buy spends cash (−), sell returns cash (+). An option order counts contracts at
 * a per-share price, so the cost carries the multiplier (`1 contract at $0.79` →
 * `-$79.00`); a spread's net debit/credit takes the sign from its direction.
 * Shared by group + external rows.
 */
function executedNumbers(
  status: OrderStatus | null,
  side: string | null,
): { total: string | null; breakdown: string | null } {
  const qty = status?.cumulativeQuantity ?? null;
  const price = status?.avgPrice ?? null;
  if (qty != null && qty > 0 && price != null) {
    const isOption = status?.assetType === "option";
    const isCrypto = status?.assetType === "crypto";
    const mult = isOption ? (status?.multiplier ?? STANDARD_MULTIPLIER) : 1;
    const cost = qty * price * mult;
    const pays = side === "buy" || side === "debit";
    const total = signedUsd(pays ? -cost : cost);
    // Units: contracts for options, the asset code for crypto (never "shares" for
    // coins — RH's own rule), shares otherwise. Coin quantities need more precision.
    const unit = isOption
      ? qty === 1
        ? "contract"
        : "contracts"
      : isCrypto
        ? (status?.symbol ?? "")
        : qty === 1
          ? "share"
          : "shares";
    const breakdown = `${num(qty, isCrypto ? 8 : 3)} ${unit} at ${usd(price)}`.trim();
    return { total, breakdown };
  }
  return { total: null, breakdown: null };
}

/**
 * The collapsed group header, Robinhood-style: an action line + total cost on top,
 * the time + a shares-at-price breakdown beneath. The action comes from the
 * structured `parsed` intent; the **executed** numbers come from RH's live
 * `OrderStatus` (cumulative_quantity @ average_price) — never an estimate, so a
 * not-yet-filled or failed order shows only the action line. Non-order entries
 * (session events, cancels) fall back to the latest line.
 */
function headerView(group: ActivityGroup, status: OrderStatus | null): HeaderView {
  const intent = group.entries.find((e) => e.kind === "order_intent");
  const parsed = intent
    ? ((intent.payload as { parsed?: ParsedOrder } | null)?.parsed ?? null)
    : null;

  if (parsed && parsed.kind === "place") {
    const isLimit = parsed.orderType === "limit" && parsed.limitPrice != null;
    // An option names its contract (`TLT $86C 11/20/26`) where an equity shows its symbol.
    const name = parsed.instrument ?? parsed.symbol ?? "?";
    const action = `${(parsed.side ?? "order").toUpperCase()} ${name} @ ${
      isLimit ? usd(parsed.limitPrice) : "Market"
    }`;
    return { primary: action, ...executedNumbers(status, parsed.side ?? null) };
  }

  return { primary: describe(group.latest).label, total: null, breakdown: null };
}

/** Header for an external order, built straight from RH's `OrderStatus`. */
function externalView(status: OrderStatus): HeaderView {
  const isLimit = status.type === "limit" && status.limitPrice != null;
  const name =
    status.assetType === "option" ? legsLabel(status.legs ?? []) : (status.symbol ?? "?");
  const action = `${(status.side ?? "order").toUpperCase()} ${name} @ ${
    isLimit ? usd(status.limitPrice) : "Market"
  }`;
  return { primary: action, ...executedNumbers(status, status.side) };
}

/**
 * A trade on the agentic account that OpenTrade didn't initiate (placed manually
 * in the RH app, etc.). Greyed and unexpandable — there's no local gate timeline
 * behind it — but the state-tinted dot keeps filled vs failed legible.
 */
function ExternalRow({ status }: { status: OrderStatus }) {
  const view = externalView(status);
  const tone = baseTone(fromRhState(status.state)) ?? "bg-muted-foreground/60";
  const at = orderAt(status);
  return (
    <div className="border-t border-border opacity-60 first:border-t-0">
      <div className="flex items-start gap-2 py-2 text-sm">
        {/* Match the expandable group rows' 3.5-wide dot column so content aligns. */}
        <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
          <span className={cn("size-1.5 rounded-full", tone)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{view.primary}</span>
            {view.total && <span className="shrink-0 text-muted-foreground">{view.total}</span>}
          </div>
          <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
            {/* Date first, then "External" where an OpenTrade row shows the agent name. */}
            <span className="shrink-0">
              {at ? `${ago(at)} · ` : ""}
              <span className="text-warning">External</span>
            </span>
            {view.breakdown && (
              <span className="min-w-0 truncate text-right">{view.breakdown}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Map an audit entry to a human line + a status-dot tone. */
function describe(e: AuditEntry): { label: string; tone: string } {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case "order_intent":
      return {
        label: `Proposed ${str(p.summary) ?? str(p.toolName) ?? "an order"}`,
        tone: "bg-muted-foreground",
      };
    case "approval_decision": {
      const status = str(p.status) ?? "decided";
      const by = str(p.decidedBy);
      const note = str(p.note);
      const who = by && by !== "user" ? by : "user";
      const tone =
        status === "approved"
          ? "bg-success"
          : status === "rejected"
            ? "bg-destructive"
            : "bg-muted-foreground/60";
      const base =
        status === "approved"
          ? who === "auto"
            ? "Order approved automatically (auto mode)"
            : `Order approved by ${who}`
          : status === "rejected"
            ? `Order rejected by ${who}`
            : `Expired order${by && by !== "user" ? ` (${by})` : ""}`;
      return { label: `${base}${note ? ` — “${note}”` : ""}`, tone };
    }
    case "order_observed": {
      // PostToolUse outcome: what the broker actually did with an approved order.
      const ok = p.ok as boolean | null | undefined;
      const state = str(p.state);
      const message = str(p.message);
      // A cancel's outcome is about the cancel *request*, not the order — phrase it
      // that way. `accepted` is the broker's answer; older rows mis-stored ok:false
      // (the cancel guide text tripped the place-order error heuristic), so recover
      // it from the raw message when needed.
      if (isCancelTool(p.toolName)) {
        const accepted = cancelAccepted(ok, message);
        if (accepted === true)
          return { label: "Cancel request accepted by broker", tone: "bg-success" };
        if (accepted === false)
          return { label: "Cancel request rejected by broker", tone: "bg-destructive" };
        return { label: "Cancel request sent to broker", tone: "bg-muted-foreground/60" };
      }
      if (ok === false) {
        return {
          label: `Order rejected by broker${message ? ` — ${message}` : state ? ` (${state})` : ""}`,
          tone: "bg-destructive",
        };
      }
      if (ok === true) {
        return {
          label: `Order accepted by broker${state ? ` — ${state}` : ""}`,
          tone: "bg-success",
        };
      }
      return {
        label: `Order result${message ? ` — ${message}` : ""}`,
        tone: "bg-muted-foreground/60",
      };
    }
    case "order_filled": {
      // Reconciled fill: actual executed shares @ average price from the broker.
      const q = typeof p.filledQuantity === "number" ? p.filledQuantity : null;
      const price = typeof p.fillPrice === "number" ? p.fillPrice : null;
      if (q != null && price != null) {
        return {
          label: `Filled ${num(q, 3)} ${q === 1 ? "share" : "shares"} at ${usd(price)}`,
          tone: "bg-success",
        };
      }
      return { label: "Order filled", tone: "bg-success" };
    }
    case "session_started":
      return { label: "Session started", tone: "bg-muted-foreground/60" };
    case "session_ended":
      return { label: "Session ended", tone: "bg-muted-foreground/60" };
    case "broker_connected":
      return { label: "Robinhood connected", tone: "bg-success" };
    default:
      return { label: e.kind, tone: "bg-muted-foreground/60" };
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Is this audit payload about a cancel tool? (toolName is stamped on order entries.) */
function isCancelTool(toolName: unknown): boolean {
  return typeof toolName === "string" && /cancel_/.test(toolName);
}

/**
 * Whether the broker accepted a cancel request. Prefer the raw `accepted` flag in
 * the message JSON (`{"data":{"accepted":…}}`) — older outcomes mis-stored ok:false
 * even on success — and fall back to the `ok` classification when it's absent.
 */
function cancelAccepted(ok: boolean | null | undefined, message: string | null): boolean | null {
  if (message) {
    try {
      const obj = JSON.parse(message) as { data?: { accepted?: unknown }; accepted?: unknown };
      const a = obj?.data?.accepted ?? obj?.accepted;
      if (a === true || a === false) return a;
    } catch {
      // not JSON — fall through to the ok classification
    }
  }
  return ok ?? null;
}
