import type { Agent } from "@shared/agent";
import type { Monitor, Schedule } from "@shared/schedule";
import { CalendarOff, ChevronRight, Clock, Radio } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { AutonomyInfoButton } from "../components/schedule/AutonomyInfo";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useAgents } from "../hooks/useAgents";
import { useSchedules } from "../hooks/useSchedules";
import { ago, cronZone, dateTime, describeCron, until } from "../lib/format";
import { cn } from "../lib/utils";
import { useConnectionStore } from "../stores/connection";
import { useUIStore } from "../stores/ui";

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

// Shared column grid for the header and every item row — automations-style layout.
const ROW_GRID =
  "grid grid-cols-[minmax(0,2.2fr)_5.5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3";

/** A cron or monitor, normalized into one row shape. */
type Item =
  | { kind: "cron"; key: string; data: Schedule }
  | { kind: "monitor"; key: string; data: Monitor };

interface AgentGroup {
  agent: Agent | null;
  agentId: string;
  items: Item[];
}

/**
 * Full-screen Scheduled view. An automations-style row table of every durable
 * cron schedule + monitor the backend scheduler is tracking (§12.2), grouped by the
 * owning agent. Rows expand downward on click to reveal full details. Read-only —
 * agents create/remove these themselves via the `opentrade` MCP server.
 */
export function ScheduledScreen() {
  const { schedules, monitors } = useSchedules();
  const agents = useAgents();
  const select = useUIStore((s) => s.select);
  const setView = useUIStore((s) => s.setView);
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo<AgentGroup[]>(() => {
    const byId = new Map<string, AgentGroup>();
    const ensure = (agentId: string): AgentGroup => {
      let g = byId.get(agentId);
      if (!g) {
        g = { agentId, agent: agents.find((a) => a.id === agentId) ?? null, items: [] };
        byId.set(agentId, g);
      }
      return g;
    };
    for (const s of schedules)
      ensure(s.agentId).items.push({ kind: "cron", key: `cron:${s.id}`, data: s });
    for (const m of monitors)
      ensure(m.agentId).items.push({ kind: "monitor", key: `mon:${m.id}`, data: m });
    // Within each agent: most recently run first (never-run last), then type
    // (Timers before Monitors), then alphabetically by name.
    for (const g of byId.values()) g.items.sort(compareItems);
    // Stable order: agents in their sidebar order first, then any orphans.
    return [...byId.values()].sort((a, b) => {
      const ai = agents.findIndex((x) => x.id === a.agentId);
      const bi = agents.findIndex((x) => x.id === b.agentId);
      return (
        (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
      );
    });
  }, [schedules, monitors, agents]);

  const total = schedules.length + monitors.length;

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openAgent = (id: string) => {
    select(id);
    setView("agents");
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-background">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-6" style={DRAG}>
        <h1 className="text-sm font-semibold tracking-tight">Scheduled</h1>
      </header>

      {total === 0 ? (
        <div
          className={cn(
            "flex flex-1 items-center justify-center overflow-y-auto p-8",
            !backendConnected && "pointer-events-none opacity-50",
          )}
          style={NO_DRAG}
        >
          <EmptyState />
        </div>
      ) : (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            // Backend down: schedules are stale, so grey the table out (sidebar nav stays live).
            !backendConnected && "pointer-events-none opacity-50",
          )}
          style={NO_DRAG}
        >
          {/* Column header */}
          <div
            className={cn(
              ROW_GRID,
              "sticky top-0 z-10 h-8 shrink-0 border-b border-border bg-background px-6",
              "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80",
            )}
          >
            <span className="pr-6">Name</span>
            <span>Type</span>
            <span>Schedule</span>
            <span>Next run</span>
            <span>Last run</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.map((g) => (
              <AgentGroupBlock
                key={g.agentId}
                group={g}
                expanded={expanded}
                onToggle={toggle}
                onOpenAgent={openAgent}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentGroupBlock({
  group,
  expanded,
  onToggle,
  onOpenAgent,
}: {
  group: AgentGroup;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const { agent, agentId, items } = group;
  return (
    <section>
      {/* Group header band */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-6 py-1.5">
        <button
          type="button"
          disabled={!agent}
          onClick={() => agent && onOpenAgent(agentId)}
          className={cn(
            "text-xs font-medium",
            agent ? "text-foreground hover:underline" : "cursor-default text-muted-foreground",
          )}
        >
          {agent?.name ?? "Unknown agent"}
        </button>
        <span className="text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
      </div>

      {items.map((item) => (
        <Row
          key={item.key}
          item={item}
          open={expanded.has(item.key)}
          onToggle={() => onToggle(item.key)}
        />
      ))}
    </section>
  );
}

function Row({ item, open, onToggle }: { item: Item; open: boolean; onToggle: () => void }) {
  const isCron = item.kind === "cron";
  const Icon = isCron ? Clock : Radio;

  const name = isCron ? cronSummary(item.data) : monitorSummary(item.data);
  const schedule = isCron ? describeCron(item.data.cronExpr) : "On signal";
  const nextRun = isCron ? until(item.data.nextFireAt) : "live";
  const lastRun = ago(item.data.lastFiredAt);

  return (
    <div className="border-b border-border/50">
      {/* biome-ignore lint/a11y/useSemanticElements: row needs to remain a grid container */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          ROW_GRID,
          "group h-11 min-w-0 cursor-pointer px-6 text-sm outline-none transition-colors",
          "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
        )}
      >
        <span className="flex min-w-0 items-center gap-3 pr-6">
          {/* Type icon by default; swaps to an expand arrow on row hover/focus. */}
          <span className="relative grid size-3.5 shrink-0 place-items-center">
            <Icon
              className={cn(
                "absolute size-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0",
                isCron ? "text-sky-400" : "text-emerald-400",
              )}
            />
            <ChevronRight
              className={cn(
                "absolute size-4 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100",
                open && "rotate-90",
              )}
            />
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 truncate font-medium">{name}</span>
            </TooltipTrigger>
            <TooltipContent>{name}</TooltipContent>
          </Tooltip>
        </span>

        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {isCron ? "Timer" : "Monitor"}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{schedule}</span>
          </TooltipTrigger>
          <TooltipContent>{isCron ? item.data.cronExpr : "Signal monitor"}</TooltipContent>
        </Tooltip>

        <span className="min-w-0 truncate text-xs text-muted-foreground">{nextRun}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{lastRun}</span>
      </div>

      {open && (
        <div className="bg-card/40 pb-4 pl-[3.125rem] pr-6 pt-1">
          {isCron ? <CronDetail schedule={item.data} /> : <MonitorDetail monitor={item.data} />}
        </div>
      )}
    </div>
  );
}

function CronDetail({ schedule }: { schedule: Schedule }) {
  const zone = cronZone(schedule.timezone);
  return (
    <div className="space-y-3">
      <Field label="Prompt">
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{schedule.prompt}</p>
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

function MonitorDetail({ monitor }: { monitor: Monitor }) {
  return (
    <div className="space-y-3">
      {monitor.description && (
        <Field label="Description">
          <p className="text-sm text-foreground">{monitor.description}</p>
        </Field>
      )}
      <Field label="Command">
        <code className="block overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {monitor.command}
        </code>
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

function DetailGrid({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
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

const itemName = (it: Item): string =>
  it.kind === "cron" ? cronSummary(it.data) : monitorSummary(it.data);

/** Default row order: most recently run first (never-run last), then Timers before
 *  Monitors, then alphabetically by name. */
function compareItems(a: Item, b: Item): number {
  const byLastRun = (b.data.lastFiredAt ?? 0) - (a.data.lastFiredAt ?? 0);
  if (byLastRun !== 0) return byLastRun;
  const typeRank = (it: Item) => (it.kind === "cron" ? 0 : 1);
  if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);
  return itemName(a).localeCompare(itemName(b), undefined, { sensitivity: "base" });
}

/** First non-empty line of a cron's wake prompt, used as the row's title. */
function cronSummary(s: Schedule): string {
  const firstLine = s.prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ?? "(no prompt)";
}

function monitorSummary(m: Monitor): string {
  return m.description?.trim() || m.command;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center">
      <CalendarOff className="size-8 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">Nothing scheduled yet</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        Agents set up their own timers and monitors to notify themselves. Just ask your agent to set
        one up.
      </p>
      <AutonomyInfoButton />
    </div>
  );
}
