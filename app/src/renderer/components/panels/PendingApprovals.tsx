import type { Approval } from "@shared/approval";
import { contractLabel, legActionLabel } from "@shared/options";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useApprovals } from "../../hooks/useApprovals";
import { trpc } from "../../lib/trpc";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Textarea } from "../ui/textarea";

/**
 * The approval gate's pending queue, shown at the top of the Activity tab. Renders
 * nothing when no order is awaiting a decision, so it stays out of the way until the
 * gate fires.
 */
export function PendingApprovals() {
  const { pending } = useApprovals();
  if (pending.length === 0) return null;

  return (
    <section className="mb-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Pending
      </h2>
      <div className="flex flex-col gap-3">
        {pending.map((a) => (
          <PendingCard key={a.id} approval={a} />
        ))}
      </div>
    </section>
  );
}

function PendingCard({ approval }: { approval: Approval }) {
  const decide = trpc.approvals.decide.useMutation();
  const [note, setNote] = useState("");
  const remaining = useCountdown(approval.requestedAt + approval.timeoutSec * 1000);
  const busy = decide.isPending;

  const submit = (approve: boolean) =>
    decide.mutate({ id: approval.id, approve, note: note.trim() || undefined });

  return (
    <Card className="bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{approval.parsed?.summary ?? approval.toolName}</div>
          {/* A spread's summary names only the underlying + leg count; list the legs. */}
          {(approval.parsed?.legs?.length ?? 0) > 1 && (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {approval.parsed?.legs?.map((leg) => (
                <li key={leg.optionId}>
                  {legActionLabel(leg.side, leg.positionEffect)}{" "}
                  {leg.ratioQuantity && leg.ratioQuantity > 1 ? `${leg.ratioQuantity}× ` : ""}
                  {contractLabel(leg.contract)}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {approval.agentName ?? "agent"} · {approval.toolName}
          </div>
        </div>
        <Countdown remaining={remaining} />
      </div>

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note to the agent…"
        rows={1}
        className="mt-2 resize-none rounded px-2 py-1 text-xs"
      />

      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          variant="success"
          disabled={busy}
          onClick={() => submit(true)}
          className="flex-1"
        >
          <Check className="size-4" /> Approve
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => submit(false)}
          className="flex-1"
        >
          <X className="size-4" /> Reject
        </Button>
      </div>
    </Card>
  );
}

function Countdown({ remaining }: { remaining: number }) {
  const mm = Math.floor(remaining / 60);
  const ss = Math.floor(remaining % 60);
  const low = remaining <= 30;
  return (
    <Badge
      variant={low ? "softDestructive" : "muted"}
      className="shrink-0 rounded px-1.5 text-[11px] tabular-nums"
    >
      {mm}:{String(ss).padStart(2, "0")}
    </Badge>
  );
}

/** Seconds remaining until `deadline`, ticking once a second, floored at 0. */
function useCountdown(deadline: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, (deadline - now) / 1000);
}
