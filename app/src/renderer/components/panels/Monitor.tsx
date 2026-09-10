import type { Monitor, Schedule, Wake } from "@shared/schedule";
import { ChevronRight, Clock, type LucideIcon, Radio } from "lucide-react";
import { useState } from "react";
import { useMonitor } from "../../hooks/useSchedules";
import { ago, cronZone, dateTime, describeCron, until } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { AutonomyHint } from "../schedule/AutonomyInfo";
import { Badge } from "../ui/badge";

// ─────────────────────────────────────────────────────────────────────────────
// The "Monitor" tab — the selected agent's autonomy: upcoming crons/monitors +
// past wakes. Always agent-scoped (no "All"), fed by its own `schedule.forAgent`
// source so wake fires never mingle with the Activity trade feed.
// ─────────────────────────────────────────────────────────────────────────────

/** This agent's scheduled runs and the wakes they've fired. */
export function MonitorPanel() {
  const agentId = useUIStore((s) => s.selectedAgentId) ?? undefined;
  const { schedules, monitors, wakes } = useMonitor(agentId);
  const [historyOpen, setHistoryOpen] = useState(true);
  // Soonest-first so the next wake leads; never-scheduled (null) sinks to the bottom.
  const upcomingCrons = [...schedules].sort(
    (a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity),
  );
  const hasUpcoming = upcomingCrons.length > 0 || monitors.length > 0;

  if (!agentId) {
    return <p className="p-4 text-sm text-muted-foreground">Select an agent.</p>;
  }

  return (
    <section className="flex flex-col p-4">
      <SubLabel>Active</SubLabel>
      {hasUpcoming ? (
        <div className="flex flex-col">
          {upcomingCrons.map((s) => (
            <UpcomingCronRow key={s.id} schedule={s} />
          ))}
          {monitors.map((m) => (
            <UpcomingMonitorRow key={m.id} monitor={m} />
          ))}
        </div>
      ) : (
        // Nothing armed: nudge the user to ask, and explain the two kinds on click.
        <AutonomyHint />
      )}

      {/* History always shows (like the Activity tab), with an empty state when there
          are no recorded wakes yet. */}
      <button
        type="button"
        onClick={() => setHistoryOpen((o) => !o)}
        className="mb-2 mt-4 flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground first:mt-0"
      >
        History
        <ChevronRight className={cn("size-3.5 transition-transform", historyOpen && "rotate-90")} />
      </button>
      {historyOpen &&
        (wakes.length > 0 ? (
          <div className="flex flex-col">
            {wakes.map((w) => (
              <WakeRow key={w.id} wake={w} />
            ))}
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">No history yet.</p>
        ))}
    </section>
  );
}

/**
 * Section heading separating Active from History. Same size/weight as the Activity tab's
 * History/Pending headers so the two tabs read consistently.
 */
function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground first:mt-0">
      {children}
    </p>
  );
}

/**
 * The marker column: the source icon by default, swapped for a rotating expand
 * chevron on row hover (the Scheduled pane / Activity GroupRow idiom).
 */
function RowMarker({ icon: Icon, tone, open }: { icon: LucideIcon; tone: string; open: boolean }) {
  return (
    <span className="relative flex h-5 w-3.5 shrink-0 items-center justify-center">
      <Icon className={cn("absolute size-3.5 transition-opacity group-hover:opacity-0", tone)} />
      <ChevronRight
        className={cn(
          "absolute size-3.5 text-muted-foreground opacity-0 transition-all group-hover:opacity-100",
          open && "rotate-90",
        )}
      />
    </span>
  );
}

/** An armed cron: title (first prompt line), its cadence, and when it next fires. */
function UpcomingCronRow({ schedule }: { schedule: Schedule }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-start gap-2 py-2 text-left text-sm"
      >
        <RowMarker icon={Clock} tone="text-sky-400" open={open} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {firstLine(schedule.prompt)}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {until(schedule.nextFireAt)}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {describeCron(schedule.cronExpr)}
            {!schedule.recurring && " · one-shot"}
          </div>
        </div>
      </button>
      {open && (
        <div className="mb-3 ml-5 mt-1.5">
          <CronDetail schedule={schedule} />
        </div>
      )}
    </div>
  );
}

/** A live signal monitor: its label, a "live" marker, and when it last triggered. */
function UpcomingMonitorRow({ monitor }: { monitor: Monitor }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-start gap-2 py-2 text-left text-sm"
      >
        <RowMarker icon={Radio} tone="text-emerald-400" open={open} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {monitor.description?.trim() || monitor.command}
            </span>
            <span className="shrink-0 text-[11px] text-emerald-400">live</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {monitor.lastFiredAt ? `Last fired ${ago(monitor.lastFiredAt)}` : "Never fired"}
          </div>
        </div>
      </button>
      {open && (
        <div className="mb-3 ml-5 mt-1.5">
          <MonitorDetail monitor={monitor} />
        </div>
      )}
    </div>
  );
}

/** Expanded cron detail, mirroring the Scheduled pane: prompt + a schedule/run grid. */
function CronDetail({ schedule }: { schedule: Schedule }) {
  const zone = cronZone(schedule.timezone);
  return (
    <div className="space-y-3">
      <Field label="Prompt">
        <CodeBlock>{schedule.prompt}</CodeBlock>
      </Field>
      <DetailGrid
        rows={[
          [
            "Schedule",
            <code key="c" className="font-mono text-xs">
              {schedule.cronExpr}
            </code>,
            describeCron(schedule.cronExpr),
          ],
          ["Timezone", zone.value, zone.hint],
          ["Next run", dateTime(schedule.nextFireAt), null],
          ["Last run", dateTime(schedule.lastFiredAt), null],
          ["Created", dateTime(schedule.createdAt), null],
        ]}
      />
    </div>
  );
}

/** Expanded monitor detail: optional description, the command, and run timestamps. */
function MonitorDetail({ monitor }: { monitor: Monitor }) {
  return (
    <div className="space-y-3">
      {monitor.description && (
        <Field label="Description">
          <p className="text-sm text-foreground">{monitor.description}</p>
        </Field>
      )}
      <Field label="Command">
        <CodeBlock>{monitor.command}</CodeBlock>
      </Field>
      <DetailGrid
        rows={[
          ["Last triggered", dateTime(monitor.lastFiredAt), null],
          ["Created", dateTime(monitor.createdAt), null],
        ]}
      />
    </div>
  );
}

/** A read-only code block — capped height, wraps, vertical scroll. Shared by the
 *  timer Prompt and the monitor Command so the two stay identical. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <code className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
      {children}
    </code>
  );
}

/** A labelled detail block (uppercase caption above its content). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {label}
      </div>
      {children}
    </div>
  );
}

type DetailRow = [string, React.ReactNode, string | null];

/** A compact two-column key/value grid, each value with an optional muted hint. */
function DetailGrid({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value, hint]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-foreground">
            {value}
            {hint && <span className="ml-2 text-muted-foreground">· {hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A recorded wake: which trigger fired, its prompt, and how long ago. */
function WakeRow({ wake }: { wake: Wake }) {
  const isMonitor = wake.sourceKind === "monitor";
  return (
    <div className="flex items-start gap-2 border-t border-border py-2 text-sm first:border-t-0">
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
        {isMonitor ? (
          <Radio className="size-3.5 text-emerald-400" />
        ) : (
          <Clock className="size-3.5 text-sky-400" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-foreground">
            {wake.sourceKind === "monitor" ? "Monitor fired" : "Timer fired"}
          </span>
          {wake.background && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px] font-normal">
              Background
            </Badge>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">{ago(wake.firedAt)}</span>
      </div>
    </div>
  );
}

/** First non-empty line of a multi-line prompt, for compact one-line row titles. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "(no prompt)"
  );
}
