import type { Agent } from "@shared/agent";
import {
  Activity as ActivityIcon,
  Bot,
  ChevronLeft,
  CreditCard,
  PieChart,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAgents } from "../../hooks/useAgents";
import { useApprovals } from "../../hooks/useApprovals";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connection";
import { useUIStore } from "../../stores/ui";
import { Activity } from "../panels/Activity";
import { MarketClock } from "../panels/MarketClock";
import { Portfolio } from "../panels/Portfolio";
import { TerminalPane } from "../terminal/TerminalPane";
import { StatusDot } from "./StatusDot";

/** Phone-width breakpoint for the web app (the desktop window never gets this narrow). */
const NARROW = "(max-width: 767px)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

type MobileTab = "activity" | "portfolio" | "agents";

/**
 * The OpenTrade Cloud web app on a phone (and as an installed PWA): the things you do
 * away from a desk. Activity leads, because that's where orders wait for approval;
 * Agents opens an agent's live terminal full-screen.
 */
export function MobileShell() {
  const agents = useAgents();
  const { pending } = useApprovals();
  const [tab, setTab] = useState<MobileTab>(pending.length ? "activity" : "agents");
  const [openAgent, setOpenAgent] = useState<Agent | null>(null);
  const select = useUIStore((s) => s.select);
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const backendConnected = useConnectionStore((s) => s.backendConnected);

  const current = openAgent ? (agents.find((a) => a.id === openAgent.id) ?? null) : null;
  if (current) {
    return (
      <div
        className="flex h-full w-full flex-col bg-background"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground"
            onClick={() => setOpenAgent(null)}
          >
            <ChevronLeft className="size-4" /> Agents
          </button>
          <StatusDot status={current.status} />
          <span className="truncate text-sm font-medium">{current.name}</span>
        </div>
        <div className="flex min-h-0 flex-1">
          <TerminalPane agent={current} />
        </div>
      </div>
    );
  }

  const tabs: { id: MobileTab; label: string; icon: typeof Bot; badge?: number }[] = [
    { id: "activity", label: "Activity", icon: ActivityIcon, badge: pending.length },
    { id: "portfolio", label: "Portfolio", icon: PieChart },
    { id: "agents", label: "Agents", icon: Bot },
  ];

  return (
    <div
      className="flex h-full w-full flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="font-semibold">OpenTrade</span>
        {!backendConnected && <span className="text-xs text-warning">Connecting…</span>}
        <a href="/account" className="flex items-center gap-1 text-sm text-muted-foreground">
          <CreditCard className="size-4" /> Account
        </a>
      </div>
      <MarketClock />

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          !backendConnected && "pointer-events-none opacity-50",
        )}
      >
        {tab === "activity" && <Activity />}
        {tab === "portfolio" && <Portfolio />}
        {tab === "agents" && (
          <div className="flex flex-col gap-2 p-3">
            {agents.length === 0 && (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No agents yet. Create one to get started.
              </p>
            )}
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  select(a.id);
                  setOpenAgent(a);
                }}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left"
              >
                <StatusDot status={a.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.harness === "codex" ? "Codex" : "Claude Code"} · {a.executionState}
                  </div>
                </div>
              </button>
            ))}
            <button
              type="button"
              onClick={openNewAgent}
              className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground"
            >
              <Plus className="size-4" /> New agent
            </button>
          </div>
        )}
      </div>

      <nav
        className="grid shrink-0 grid-cols-3 border-t border-border bg-card"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "relative flex flex-col items-center gap-0.5 py-2 text-xs",
              tab === t.id ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <t.icon className="size-5" />
            {t.label}
            {t.badge ? (
              <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
    </div>
  );
}
