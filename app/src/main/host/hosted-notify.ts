import type { Approval } from "@shared/approval";
import { bus } from "../services/event-bus";
import { hostLog } from "./log";

/**
 * Hosted mode: forward events the user must act on to the gateway, which turns them
 * into phone / web push. The desktop gets these as OS notifications; a cloud sandbox has
 * nobody watching, so without this an order would wait out its approval timeout unseen.
 *
 * Only what a notification needs leaves the sandbox (agent, summary, timeout), never the
 * raw tool input.
 */
export function startHostedNotify(gatewayUrl: string, sandboxKey: string): () => void {
  const post = (event: Record<string, unknown>) => {
    fetch(`${gatewayUrl}/api/sandbox/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sandboxKey}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => hostLog.warn("hosted notify failed", String(err)));
  };

  const offPending = bus.onEvent("approval:pending", (a: Approval) =>
    post({
      type: "approval.pending",
      approvalId: a.id,
      agentId: a.agentId,
      agentName: a.agentName,
      summary: a.parsed?.summary ?? a.toolName,
      estCost: a.parsed?.estCost ?? null,
      timeoutSec: a.timeoutSec,
      requestedAt: a.requestedAt,
    }),
  );
  return () => offPending();
}
