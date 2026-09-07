import { z } from "zod";
import { ApprovalMode } from "./agent";
import { BrokerConnectionStatus } from "./broker";

/**
 * The in-app feedback form's contract (§12.8). Feedback is a user-initiated message,
 * kept separate from telemetry: free text plus an optional email, its own strict
 * schema (the telemetry allowlist forbids free text), not gated by the telemetry
 * opt-out, sent under the install's anonymous id.
 */

export const FEEDBACK_MESSAGE_MAX = 2000;

export const FeedbackView = z.enum(["agents", "scheduled", "settings"]);
export type FeedbackView = z.infer<typeof FeedbackView>;

export const FeedbackInput = z.strictObject({
  /** Stable per-draft id, sent as the PostHog event uuid so a retry after a timed-out
   *  flush can't land the same message twice. */
  submissionId: z.uuid(),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
  /** Absent (not "") when blank. */
  email: z.email().max(254).optional(),
  includeDiagnostics: z.boolean(),
  view: FeedbackView,
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

/** A CLI `--version` line (e.g. `2.0.1 (Claude Code)`); null when not installed. */
const cliVersion = z
  .string()
  .regex(/^[\w.\-+ ()]{1,64}$/)
  .nullable();
const runtimeVersion = z.string().regex(/^[\w.\-+]{1,32}$/);
const count = z.number().int().nonnegative();

/**
 * The "Include anonymous app data" block: counts, enums, versions, and the app's own
 * tunables. Never agent names/ids, tickers, orders, positions, account data, or paths.
 * Flat on purpose — one key is one column in the PostHog feedback table.
 */
export const FeedbackDiagnostics = z.strictObject({
  // build + runtime
  app_version: z.string().max(64),
  platform: z.string().max(32),
  arch: z.string().max(32),
  os_release: z.string().regex(/^[\w.\-+]{1,64}$/),
  electron_version: runtimeVersion.nullable(),
  node_version: runtimeVersion,
  claude_version: cliVersion,
  codex_version: cliVersion,
  host_uptime_sec: count,

  // agents — counts only
  agent_count: count,
  agents_claude: count,
  agents_codex: count,
  agents_working: count,
  agents_needs_input: count,
  agents_awaiting_approval: count,
  /** Marked unresumable by the wake layer (§12.2). */
  agents_broken: count,
  agents_auto_mode: count,
  /** Turn limit on and the headless budget spent. */
  agents_turn_limited: count,
  agents_active_24h: count,
  schedules_enabled: count,
  monitors_enabled: count,

  // broker — status only
  broker_status: BrokerConnectionStatus,
  broker_authorized: z.boolean(),
  /** Age of the cached portfolio snapshot; null before the first fetch. */
  broker_portfolio_age_sec: count.nullable(),
  pending_approvals: count,

  // settings that can explain behaviour
  telemetry_enabled: z.boolean(),
  default_approval_mode: ApprovalMode,
  approval_timeout_sec: count,
  poll_interval_focused_sec: count,
  poll_interval_blurred_sec: count,
  headless_turn_limit_enabled: z.boolean(),
  max_headless_turns: count,
  max_headless_run_minutes: count,
  background_allow_api_key: z.boolean(),
});
export type FeedbackDiagnostics = z.infer<typeof FeedbackDiagnostics>;
