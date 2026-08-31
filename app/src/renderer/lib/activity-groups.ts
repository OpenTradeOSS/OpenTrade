import type { AuditEntry, ParsedOrder } from "@shared/approval";
import type { OrderStatus } from "@shared/broker";

/**
 * A run of audit entries about the same order, collapsed from the flat feed.
 * `entries` is chronological ascending (intent → decision → outcome) for the
 * expanded timeline; `latest` is the most recent entry (drives the collapsed
 * header + its status dot).
 */
export interface ActivityGroup {
  key: string;
  agentId: string | null;
  agentName: string | null;
  entries: AuditEntry[];
  latest: AuditEntry;
}

/** Pull the order correlation id out of an audit payload, if present. */
function approvalIdOf(entry: AuditEntry): string | null {
  const p = entry.payload as { approvalId?: unknown } | null | undefined;
  return p && typeof p.approvalId === "string" ? p.approvalId : null;
}

/**
 * Fold the newest-first audit feed into per-order groups. Entries sharing an
 * `approvalId` (the three stages of one order — proposed / decided / observed)
 * collapse into one group; entries without one (session events, an uncorrelated
 * outcome) become their own single-entry group so they still render standalone.
 *
 * Group order follows the **first time** each key is seen while scanning the
 * already-DESC feed, so a group floats to the top whenever any of its entries is
 * the most recent — newest activity stays on top.
 */
export function groupActivity(feed: AuditEntry[]): ActivityGroup[] {
  const byKey = new Map<string, ActivityGroup>();

  for (const entry of feed) {
    const approvalId = approvalIdOf(entry);
    const key = approvalId ?? `entry-${entry.id}`;
    const existing = byKey.get(key);
    if (existing) {
      // Feed is DESC, so this entry is older than what's already in the group:
      // unshift to keep `entries` chronological ascending. `latest` stays put.
      existing.entries.unshift(entry);
    } else {
      byKey.set(key, {
        key,
        agentId: entry.agentId,
        agentName: entry.agentName,
        entries: [entry],
        latest: entry,
      });
    }
  }

  foldCancelsIntoOrders(byKey);
  return [...byKey.values()];
}

/** The structured intent of a group's order, if it has an `order_intent`. */
function intentParsed(group: ActivityGroup): ParsedOrder | null {
  const intent = group.entries.find((e) => e.kind === "order_intent");
  const p = intent?.payload as { parsed?: ParsedOrder } | null | undefined;
  return p?.parsed ?? null;
}

/** The RH order id a place group was assigned (carried on its `order_observed`). */
function placedOrderId(group: ActivityGroup): string | null {
  const obs = group.entries.find((e) => e.kind === "order_observed");
  const id = (obs?.payload as { orderId?: unknown } | null | undefined)?.orderId;
  return typeof id === "string" && id ? id : null;
}

/** The order id a cancel targets: the structured field, or parsed from the summary. */
function cancelTargetId(parsed: ParsedOrder): string | null {
  if (parsed.cancelsOrderId) return parsed.cancelsOrderId;
  // Fallback for rows written before `cancelsOrderId` existed — the id is in the
  // summary ("Cancel order <uuid>").
  const m = parsed.summary.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/**
 * Fold each cancel's group into the order group it targets, so a cancellation
 * **updates the original order's card** instead of spawning a new one. A
 * `cancel_*_order` carries the RH order id it targets (on the parsed intent, or in
 * its summary); the original order group exposes that same id via its
 * `order_observed` outcome. We match the two and merge the cancel's timeline in.
 * Cancels whose target isn't in the current feed window stay standalone.
 */
function foldCancelsIntoOrders(byKey: Map<string, ActivityGroup>): void {
  const keyByOrderId = new Map<string, string>();
  for (const g of byKey.values()) {
    if (intentParsed(g)?.kind !== "place") continue;
    const oid = placedOrderId(g);
    if (oid) keyByOrderId.set(oid, g.key);
  }

  for (const g of [...byKey.values()]) {
    const parsed = intentParsed(g);
    if (parsed?.kind !== "cancel") continue;
    const target = parsed && cancelTargetId(parsed);
    const targetKey = target ? keyByOrderId.get(target) : undefined;
    if (!targetKey || targetKey === g.key) continue;
    const order = byKey.get(targetKey);
    if (!order) continue;

    // Splice the cancel's entries into the order's timeline (chronological asc),
    // float the card by its newest activity (Activity re-sorts rows by latest.at).
    order.entries = [...order.entries, ...g.entries].sort((a, b) => a.at - b.at || a.id - b.id);
    if (g.latest.at > order.latest.at) order.latest = g.latest;
    byKey.delete(g.key);
  }
}

/** "other" = non-order activity (session events) — the caller falls back to the latest tone. */
export type OrderState = "filled" | "failed" | "working" | "unknown" | "proposed" | "other";

/** Map a Robinhood lifecycle `state` onto our dot status. */
export function fromRhState(state: string | null): OrderState {
  const s = (state ?? "").toLowerCase();
  if (s === "filled") return "filled";
  if (/cancel|reject|fail|void/.test(s)) return "failed";
  // queued / confirmed / new / unconfirmed / partially_filled / pending / open …
  return "working";
}

/**
 * Grace after an order's intent during which an approved-but-unlinked order is
 * still "working" rather than failed — the outcome hook and the ledger poll can
 * lag the actual placement by a few seconds.
 */
const SETTLE_MS = 90_000;

/**
 * The order's *real* status, joining the local gate timeline with Robinhood's
 * authoritative ledger. The ledger is kept **complete** (full sweep at startup +
 * daily, recent window every poll), so once it's loaded a missing order is a
 * definitive non-execution — not an aged-out unknown.
 *
 *  • `status` is RH's live view for this order (matched by orderId), if any.
 *  • `orderId` is the link captured at placement; its presence means it reached RH.
 *  • `ledgerReady` is whether the complete ledger cache has loaded — only then may
 *    "no match" be read as definitive failure.
 *
 * Resolution order:
 *  • no order intent            → other (a session event, etc.)
 *  • RH knows the order         → map its state (filled / failed / working)
 *  • submit-rejected (ok:false) → failed (RH never created an order)
 *  • gate rejected/expired      → failed
 *  • has an orderId but no match → working (reached RH; the poll hasn't seen it yet)
 *  • broker took it, no id       → working
 *  • approved, no link, no match:
 *      – within SETTLE_MS of intent → working (placement may still be settling)
 *      – ledger loaded              → failed (complete ledger has no such order)
 *      – ledger not loaded yet      → unknown (don't assert without the ledger)
 *  • otherwise                  → proposed (awaiting a decision)
 */
export function orderState(
  group: ActivityGroup,
  status: OrderStatus | null,
  orderId: string | null,
  now: number,
  ledgerReady: boolean,
): OrderState {
  const kinds = new Set(group.entries.map((e) => e.kind));
  if (!kinds.has("order_intent")) return "other";

  if (status) return fromRhState(status.state);

  const observed = group.entries.find((e) => e.kind === "order_observed");
  const observedOk = (observed?.payload as { ok?: unknown } | undefined)?.ok;
  const decision = group.entries.find((e) => e.kind === "approval_decision");
  const decisionStatus = (decision?.payload as { status?: unknown } | undefined)?.status;

  // An option EXERCISE is not an order: it never appears in the order ledger, so
  // the complete-ledger "no match → failed" verdict below would wrongly go red.
  // The broker's accept/reject of the exercise request is its terminal signal.
  if (intentParsed(group)?.kind === "exercise") {
    if (observedOk === true) return "filled";
    if (observedOk === false || decisionStatus === "rejected" || decisionStatus === "expired")
      return "failed";
    return decisionStatus === "approved" ? "working" : "proposed";
  }

  if (observedOk === false || decisionStatus === "rejected" || decisionStatus === "expired")
    return "failed";
  if (orderId) return "working"; // reached RH, just not in the cached ledger (yet)
  if (observedOk === true) return "working"; // broker took it but we have no id to join
  if (decisionStatus === "approved") {
    const intent = group.entries.find((e) => e.kind === "order_intent");
    const intentAt = intent?.at ?? now;
    if (now - intentAt < SETTLE_MS) return "working"; // just placed; outcome/ledger may lag
    if (ledgerReady) return "failed"; // complete ledger has no such order → never executed
    return "unknown"; // ledger not loaded yet — can't assert
  }
  return "proposed";
}
