import {
  Bell,
  Bot,
  Check,
  Copy,
  Info,
  LineChart,
  Loader2,
  type LucideIcon,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { SegmentedControl } from "../components/settings/SegmentedControl";
import { SettingNumber } from "../components/settings/SettingNumber";
import { SettingsRow } from "../components/settings/SettingsRow";
import { SettingsSection } from "../components/settings/SettingsSection";
import { SettingToggle } from "../components/settings/SettingToggle";
import { TelemetryOptOutDialog } from "../components/settings/TelemetryOptOutDialog";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useAgents } from "../hooks/useAgents";
import { useBrokerStatus } from "../hooks/useBroker";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { useUpdater } from "../lib/updater";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type CategoryId = "general" | "agents" | "approvals" | "market-data" | "notifications" | "about";

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "market-data", label: "Market data", icon: LineChart },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "about", label: "About", icon: Info },
];

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

/**
 * Full-screen settings. Replaces the agent panes (the sidebar stays). A category
 * rail on the left drives a content pane; every control auto-saves through the
 * settings mutation (no Save button).
 */
export function SettingsScreen() {
  const [category, setCategory] = useState<CategoryId>("general");
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <div className="flex flex-1 min-w-0 bg-background">
      {/* Category rail */}
      <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="h-10 shrink-0" style={DRAG} />
        <div className="px-3 pb-2 pt-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Settings
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2" style={NO_DRAG}>
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  category === c.id
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {c.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <div className="flex flex-1 flex-col min-w-0">
        <div
          className="flex h-10 shrink-0 items-center border-b border-border px-6 text-sm font-medium"
          style={DRAG}
        >
          {active.label}
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            {category === "general" && <GeneralPanel />}
            {category === "agents" && <AgentsPanel />}
            {category === "approvals" && <ApprovalsPanel />}
            {category === "market-data" && <MarketDataPanel />}
            {category === "notifications" && <NotificationsPanel />}
            {category === "about" && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const setView = useUIStore((s) => s.setView);
  const s = settings.data;
  if (!s) return null;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Status area"
        description="Keep an eye on your agents from the macOS menu bar or Windows system tray."
      >
        <SettingsRow label="Show OpenTrade in the status area">
          <SettingToggle
            checked={s.showInMenuBar}
            onChange={(showInMenuBar) => update.mutate({ showInMenuBar })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Setup">
        <SettingsRow
          label="Re-run setup"
          hint="Reopen the onboarding wizard — agent CLI check, Robinhood, first agent."
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              update.mutate({ onboardingComplete: false });
              setView("agents");
            }}
          >
            Re-run setup
          </Button>
        </SettingsRow>
        {/* Regular Quit keeps the background host (and any scheduled agents) running —
            this is the way to actually stop everything. Launcher-owned, so it rides the
            shell bridge (window.__opentradeShell), not tRPC; absent in a plain browser. */}
        {window.__opentradeShell && (
          <SettingsRow
            label="Quit OpenTrade completely"
            hint="Stops the OpenTrade host process. Agents will not run in the background until you reopen the app."
          >
            <Button
              type="button"
              variant="outline"
              onClick={() => void window.__opentradeShell?.quitCompletely()}
            >
              Quit completely
            </Button>
          </SettingsRow>
        )}
      </SettingsSection>

      {/* Not a titled section: this is an informational heads-up about the underlying
          agent runtime, not an OpenTrade-controlled setting. Sits at the bottom. */}
      <RetentionNotice />
    </div>
  );
}

const RETENTION_SNIPPET = '{ "cleanupPeriodDays": 365 }';

/**
 * Informational heads-up (not an OpenTrade-controlled setting): the current agent
 * runtime (Claude Code) caps how long an idle agent keeps its conversation memory via
 * `cleanupPeriodDays`. Shown only when that window is at/below the default 30 days;
 * offers a copyable snippet to extend it. N days + settings path read live via
 * `system.claudeRetention`.
 */
function RetentionNotice() {
  const retention = trpc.system.claudeRetention.useQuery();
  const [copied, setCopied] = useState(false);
  const r = retention.data;

  // Only nudge when retention is at/below the default 30 days — a longer window is fine.
  if (!r || r.days > 30) return null;

  const copy = () => {
    navigator.clipboard.writeText(RETENTION_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 space-y-2 text-sm text-foreground">
          <p>
            Claude Code is configured to delete conversation history after{" "}
            <span className="font-medium">{r.days} days</span> of inactivity. To keep it longer,
            change Claude Code's settings at{" "}
            <code className="rounded bg-background/60 px-1 py-0.5 text-xs">{r.settingsPath}</code>:
          </p>
          <div className="flex items-center justify-between gap-2 rounded border border-border bg-background/60 px-2.5 py-1.5 font-mono text-xs">
            <code className="truncate">{RETENTION_SNIPPET}</code>
            <button
              type="button"
              onClick={copy}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Copy snippet"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-success" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" /> Copy
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <div className="space-y-8">
      <SettingsSection title="Agents" description="Defaults applied when you create a new agent.">
        <SettingsRow
          label="Default approval mode"
          hint="Full-auto agents place orders without asking (still logged)."
        >
          <SegmentedControl
            options={[
              { value: "approve", label: "Require approval" },
              { value: "auto", label: "Full-auto" },
            ]}
            value={s.defaultApprovalMode}
            onChange={(defaultApprovalMode) => update.mutate({ defaultApprovalMode })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Background agents"
        description="Behavior of scheduled runs that happen while you're away."
      >
        <SettingsRow
          label="Background turn limit"
          hint="Pause agents after a set number of turns. Turns can be reset in the agent view."
        >
          <SettingToggle
            checked={s.headlessTurnLimitEnabled}
            onChange={(headlessTurnLimitEnabled) => update.mutate({ headlessTurnLimitEnabled })}
          />
        </SettingsRow>
        {s.headlessTurnLimitEnabled && (
          <SettingsRow
            label="Maximum turns"
            hint="Number of turns an agent can run before pausing."
          >
            <SettingNumber
              value={s.maxHeadlessTurns}
              min={1}
              max={1000}
              suffix="turns"
              onCommit={(maxHeadlessTurns) => update.mutate({ maxHeadlessTurns })}
            />
          </SettingsRow>
        )}
        <SettingsRow label="Maximum run time" hint="Maximum duration of a single agent run.">
          <SettingNumber
            value={s.maxHeadlessRunMinutes}
            min={5}
            max={60}
            suffix="minutes"
            onCommit={(maxHeadlessRunMinutes) => update.mutate({ maxHeadlessRunMinutes })}
          />
        </SettingsRow>
        <SettingsRow
          label="Allow API key usage"
          hint="Allow background runs to use your Anthropic/OpenAI API key instead of your Claude/Codex subscription."
        >
          <SettingToggle
            checked={s.backgroundAllowApiKey}
            onChange={(backgroundAllowApiKey) => update.mutate({ backgroundAllowApiKey })}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

function ApprovalsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <SettingsSection title="Approvals" description="The order-approval queue gate.">
      <SettingsRow
        label="Approval timeout"
        hint="A pending order auto-declines after this long with no decision."
      >
        <SettingNumber
          value={s.approvalTimeoutSec}
          min={10}
          max={3600}
          suffix="seconds"
          onCommit={(approvalTimeoutSec) => update.mutate({ approvalTimeoutSec })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function MarketDataPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Polling"
        description="How often OpenTrade refreshes Robinhood data for the panel."
      >
        <SettingsRow label="Focused interval" hint="Window focused, during market hours.">
          <SettingNumber
            value={s.pollIntervalFocusedSec}
            min={1}
            max={120}
            suffix="seconds"
            onCommit={(pollIntervalFocusedSec) => update.mutate({ pollIntervalFocusedSec })}
          />
        </SettingsRow>
        <SettingsRow label="Background interval" hint="Window blurred, or the market is closed.">
          <SettingNumber
            value={s.pollIntervalBlurredSec}
            min={1}
            max={600}
            suffix="seconds"
            onCommit={(pollIntervalBlurredSec) => update.mutate({ pollIntervalBlurredSec })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Robinhood connection"
        description="OpenTrade keeps its own read-only session for the portfolio panel."
      >
        <BrokerConnectionRow />
      </SettingsSection>
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/50",
};

function BrokerConnectionRow() {
  const status = useBrokerStatus();
  const utils = trpc.useUtils();
  const connect = trpc.onboarding.connectBroker.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const disconnect = trpc.broker.disconnect.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const st = status?.status ?? "disconnected";
  const account = status?.account;
  const connecting = connect.isPending || st === "connecting";

  const hint =
    st === "connected" && account
      ? `${account.agentic ? "agentic" : account.type} · ${account.accountNumber}`
      : connecting
        ? "Waiting for you to approve in the browser. Closed the tab? Cancel and connect again."
        : "Not connected";

  return (
    <SettingsRow label="Status" hint={hint}>
      <div className="flex items-center gap-2.5">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[st])} />
        {st === "connected" ? (
          <>
            <span className="text-sm text-muted-foreground">Connected</span>
            {/* Forget the session: the next Connect is a fresh consent (also how to
                switch Robinhood accounts). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </>
        ) : connecting ? (
          <>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Waiting for Robinhood…
            </span>
            {/* The consent flow can't tell that the browser tab was closed; this is the
                way out (the daemon otherwise waits out its timeout). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" onClick={() => connect.mutate()}>
            {st === "error" ? "Retry" : "Connect"}
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}

function NotificationsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const agents = useAgents();
  const s = settings.data;
  if (!s) return null;

  const setMuted = (agentId: string, muted: boolean) => {
    const set = new Set(s.notifyMutedAgents);
    if (muted) set.add(agentId);
    else set.delete(agentId);
    update.mutate({ notifyMutedAgents: [...set] });
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="Notifications" description="Desktop notifications from OpenTrade.">
        <SettingsRow
          label="Agent wake-ups"
          hint="A timer or monitor fired and the agent started working. Shown only while OpenTrade is in the background."
        >
          <SettingToggle
            checked={s.notifyWakes}
            onChange={(notifyWakes) => update.mutate({ notifyWakes })}
          />
        </SettingsRow>
        <SettingsRow
          label="Order executions"
          hint="An agent-placed order filled, was rejected, or was cancelled."
        >
          <SettingToggle
            checked={s.notifyOrders}
            onChange={(notifyOrders) => update.mutate({ notifyOrders })}
          />
        </SettingsRow>
        <SettingsRow
          label="Approval requests"
          hint="An agent is waiting on your approval to place an order. The dock badge always shows regardless."
        >
          <SettingToggle
            checked={s.notifyApprovals}
            onChange={(notifyApprovals) => update.mutate({ notifyApprovals })}
          />
        </SettingsRow>
        <SettingsRow
          label="Agent paused"
          hint="An agent hit its unattended turn limit and stopped running in the background until you check on it."
        >
          <SettingToggle
            checked={s.notifyRestricted}
            onChange={(notifyRestricted) => update.mutate({ notifyRestricted })}
          />
        </SettingsRow>
        <SettingsRow
          label="App updates"
          hint="A new version has been downloaded and is ready to install."
        >
          <SettingToggle
            checked={s.notifyUpdates}
            onChange={(notifyUpdates) => update.mutate({ notifyUpdates })}
          />
        </SettingsRow>
      </SettingsSection>

      {agents.length > 0 && (
        <SettingsSection
          title="Per agent"
          description="Mute every notification from a specific agent."
        >
          {agents.map((a) => (
            <SettingsRow key={a.id} label={a.name}>
              <SettingToggle
                checked={!s.notifyMutedAgents.includes(a.id)}
                onChange={(enabled) => setMuted(a.id, !enabled)}
              />
            </SettingsRow>
          ))}
        </SettingsSection>
      )}
    </div>
  );
}

function AboutPanel() {
  const info = trpc.system.appInfo.useQuery();
  const harnesses = trpc.onboarding.harnesses.useQuery();

  return (
    <SettingsSection
      title="About"
      description="OpenTrade — an open-source control panel for trading agents."
    >
      <SettingsRow label="Version">
        <span className="text-sm tabular-nums text-muted-foreground">
          {info.data?.version ?? "—"}
        </span>
      </SettingsRow>
      <SoftwareUpdateRow />
      <SettingsRow label="Platform">
        <span className="text-sm text-muted-foreground">{info.data?.platform ?? "—"}</span>
      </SettingsRow>
      <SettingsRow label="Claude Code CLI" hint="Runs agents created with the Claude Code harness.">
        <span className="text-sm text-muted-foreground">
          {harnesses.isLoading
            ? "checking…"
            : harnesses.data?.claude.found
              ? harnesses.data.claude.version
              : "Not found"}
        </span>
      </SettingsRow>
      <SettingsRow label="Codex CLI" hint="Runs agents created with the Codex harness.">
        <span className="text-sm text-muted-foreground">
          {harnesses.isLoading
            ? "checking…"
            : harnesses.data?.codex.found
              ? harnesses.data.codex.version
              : "Not found"}
        </span>
      </SettingsRow>
      <SettingsRow label="Data directory">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="max-w-[18rem] truncate text-xs text-muted-foreground">
              {info.data?.home ?? "—"}
            </span>
          </TooltipTrigger>
          {info.data?.home && <TooltipContent>{info.data.home}</TooltipContent>}
        </Tooltip>
      </SettingsRow>
      <TelemetryRow />
    </SettingsSection>
  );
}

/**
 * The anonymous-telemetry opt-out — an About row (it's a statement about the project,
 * not an app preference). Turning it **on** applies immediately; turning it **off**
 * first raises `TelemetryOptOutDialog` and only writes the setting if the user
 * confirms, so an accidental click can't silently drop our only feedback channel.
 */
function TelemetryRow() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [confirmingOptOut, setConfirmingOptOut] = useState(false);
  const s = settings.data;

  return (
    <SettingsRow
      label="Share anonymous usage data"
      hint="Anonymous feature-usage and error events. Never your conversations, tickers, quantities, prices, or account details."
    >
      {s && (
        <SettingToggle
          checked={s.telemetryEnabled}
          onChange={(telemetryEnabled) => {
            if (telemetryEnabled) update.mutate({ telemetryEnabled: true });
            else setConfirmingOptOut(true);
          }}
        />
      )}
      <TelemetryOptOutDialog
        open={confirmingOptOut}
        onCancel={() => setConfirmingOptOut(false)}
        onConfirm={() => {
          setConfirmingOptOut(false);
          update.mutate({ telemetryEnabled: false });
        }}
      />
    </SettingsRow>
  );
}

/**
 * Manual "Check for updates" with live status from the main-process updater
 * (window.__opentradeUpdater, see lib/updater.ts). Updates are user-in-charge: the
 * app checks on boot + every 4h but never auto-downloads or installs on quit. This
 * row makes the result visible — and surfaces otherwise-silent check failures (e.g.
 * a release missing its latest-mac.yml feed) — and, when an update is available,
 * offers an "Update & restart" that downloads (if needed) and relaunches immediately.
 */
function SoftwareUpdateRow() {
  const { state, check, install } = useUpdater();
  const status = state?.status ?? "idle";

  let hint: string | undefined;
  if (status === "checking") hint = "Checking for updates…";
  else if (status === "available") hint = `Version ${state?.version ?? ""} is available`;
  else if (status === "downloading")
    hint = `Downloading v${state?.version ?? ""}${
      state?.progressPercent != null ? ` — ${state.progressPercent}%` : "…"
    }`;
  else if (status === "downloaded") hint = "Restarting to install…";
  else if (status === "up-to-date") hint = "You're on the latest version";
  else if (status === "error") hint = state?.error ?? "Update check failed";
  else if (status === "unsupported") hint = "Updates apply to the installed app only";

  return (
    <SettingsRow label="Software update" hint={hint}>
      <div className="flex items-center gap-2.5">
        {status === "up-to-date" && <Check className="size-4 text-success" />}
        {status === "error" && <TriangleAlert className="size-4 text-warning" />}
        {status === "available" || status === "downloading" || status === "downloaded" ? (
          <Button type="button" disabled={status !== "available"} onClick={install}>
            {status !== "available" && <Loader2 className="size-4 animate-spin" />}
            Update &amp; restart
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={status === "checking" || status === "unsupported"}
            onClick={check}
          >
            {status === "checking" && <Loader2 className="size-4 animate-spin" />}
            {status === "error" ? "Retry" : "Check for updates"}
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}
