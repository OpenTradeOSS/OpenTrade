import { ExternalLink } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

/** The OpenTrade community Discord — the opt-out alternative feedback channel. */
export const OPENTRADE_DISCORD_URL = "https://discord.gg/F63YFPRtq";

/**
 * Every event in the `shared/analytics.ts` allowlist, bucketed three ways. The dialog
 * calls this exhaustive, so it must stay exhaustive — each bucket below covers a
 * contiguous group of `TELEMETRY_EVENTS`, and a new event there needs a home here:
 *  1. app — `host_started`, `app_opened`, `app_updated`, `update_downloaded`, the
 *     `onboarding_*` funnel, `setting_changed`, `telemetry_enabled|disabled`,
 *     `notification_clicked`, `broker_connected|broker_connect_failed`, `feedback_sent`
 *     (usage only — the feedback message itself is not telemetry, §12.8).
 *  2. agents — `agent_created|archived|restarted`, `terminal_session_started|respawned`,
 *     `schedule_created|fired`, `headless_run_finished`, `agent_marked_broken`,
 *     `turn_limit_reached`, and the categorical `order_gate_prompted|decided` +
 *     `order_submit_resolved`.
 *  3. errors — `app_error`.
 */
const COLLECTED = [
  {
    label: "App usage",
    detail:
      "launches, updates, onboarding progress, settings you change, and whether the broker connected",
  },
  {
    label: "Agent activity",
    detail: "agents created or archived, schedules firing, background runs, and order approvals",
  },
  { label: "Errors", detail: "the error type and the code line it came from" },
];

/**
 * Shown when the user moves the telemetry toggle to **off** (never when turning it
 * on). Telemetry is deliberately the only product-feedback channel OpenTrade has —
 * local-first, no accounts, no backend holding user data — so the opt-out states what
 * it costs, the exhaustive `COLLECTED` breakdown, what is never collected (both
 * mirroring the allowlist in `shared/analytics.ts` — keep in sync if that changes),
 * and the Discord as the alternative. Deliberately terse: a wall of text at a toggle
 * goes unread. The setting only flips once `onConfirm` fires; cancelling leaves
 * telemetry on.
 */
export function TelemetryOptOutDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="gap-3 sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Turn off anonymous usage data?</AlertDialogTitle>
          <AlertDialogDescription>
            It's our only product feedback — OpenTrade has no accounts and no server holding your
            data. Here's an exhaustive list of usage we collect:
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="space-y-1.5">
          {COLLECTED.map(({ label, detail }) => (
            <li key={label} className="flex gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="select-none text-muted-foreground/60">
                &bull;
              </span>
              <span>
                <span className="font-medium text-foreground">{label}</span> — {detail}
              </span>
            </li>
          ))}
        </ul>

        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Never collected:</span> your conversations,
          agent names, tickers, quantities, prices, account data, or anything identifying you.
        </p>

        <p className="text-sm text-muted-foreground">
          If you decide to opt out, please{" "}
          <a
            href={OPENTRADE_DISCORD_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            join our Discord
            <ExternalLink className="size-3" />
          </a>{" "}
          so we can still hear from you!
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Keep it on</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Turn it off
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
