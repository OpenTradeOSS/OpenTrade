import { release } from "node:os";
import type { Agent } from "@shared/agent";
import type { BrokerConnectionStatus } from "@shared/broker";
import type { FeedbackDiagnostics } from "@shared/feedback";
import type { AppSettings } from "@shared/settings";

export interface DiagnosticsValues {
  agents: Agent[];
  /** Enabled cron schedules / monitors across every agent. */
  crons: number;
  monitors: number;
  brokerStatus: BrokerConnectionStatus;
  brokerAuthorized: boolean;
  /** `fetchedAt` of the cached portfolio snapshot, or null before the first fetch. */
  portfolioFetchedAt: number | null;
  pendingApprovals: number;
  settings: AppSettings;
  claudeVersion: string | null;
  codexVersion: string | null;
}

const DAY_MS = 86_400_000;

/** First line of a harness `--version` probe if it fits the schema's charset, else null
 *  (a multi-line banner or a path collapses to null rather than failing the block). */
export function cliVersionOf(probe: { found: boolean; version: string | null }): string | null {
  const first = probe.version?.split("\n")[0].trim() ?? "";
  return probe.found && /^[\w.\-+ ()]{1,64}$/.test(first) ? first : null;
}

/** The "Include anonymous app data" block (§12.8) — counts, enums, versions, tunables. */
export function buildDiagnostics(v: DiagnosticsValues, now = Date.now()): FeedbackDiagnostics {
  const s = v.settings;
  const countIf = (pred: (a: Agent) => boolean) => v.agents.filter(pred).length;
  return {
    app_version: process.env.OPENTRADE_VERSION ?? "dev",
    platform: process.platform,
    arch: process.arch,
    os_release: release(),
    electron_version: process.versions.electron ?? null,
    node_version: process.versions.node,
    claude_version: v.claudeVersion,
    codex_version: v.codexVersion,
    host_uptime_sec: Math.floor(process.uptime()),

    agent_count: v.agents.length,
    agents_claude: countIf((a) => a.harness === "claude"),
    agents_codex: countIf((a) => a.harness === "codex"),
    agents_working: countIf((a) => a.status === "working"),
    agents_needs_input: countIf((a) => a.status === "needs-input"),
    agents_awaiting_approval: countIf((a) => a.status === "awaiting-approval"),
    agents_broken: countIf((a) => a.executionState === "broken"),
    agents_auto_mode: countIf((a) => a.approvalMode === "auto"),
    agents_turn_limited: countIf(
      (a) =>
        s.headlessTurnLimitEnabled &&
        a.turnLimitEnabled &&
        a.headlessTurnsUsed >= s.maxHeadlessTurns,
    ),
    agents_active_24h: countIf((a) => a.lastActiveAt !== null && now - a.lastActiveAt < DAY_MS),
    schedules_enabled: v.crons,
    monitors_enabled: v.monitors,

    broker_status: v.brokerStatus,
    broker_authorized: v.brokerAuthorized,
    broker_portfolio_age_sec:
      v.portfolioFetchedAt === null
        ? null
        : Math.max(0, Math.floor((now - v.portfolioFetchedAt) / 1000)),
    pending_approvals: v.pendingApprovals,

    telemetry_enabled: s.telemetryEnabled,
    default_approval_mode: s.defaultApprovalMode,
    approval_timeout_sec: s.approvalTimeoutSec,
    poll_interval_focused_sec: s.pollIntervalFocusedSec,
    poll_interval_blurred_sec: s.pollIntervalBlurredSec,
    headless_turn_limit_enabled: s.headlessTurnLimitEnabled,
    max_headless_turns: s.maxHeadlessTurns,
    max_headless_run_minutes: s.maxHeadlessRunMinutes,
    background_allow_api_key: s.backgroundAllowApiKey,
  };
}
