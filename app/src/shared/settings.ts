import { z } from "zod";
import { ApprovalMode } from "./agent";

/**
 * Global app settings (the `settings` kv table, distinct from per-agent config
 * and from the encrypted OAuth/token rows). This is the single source of truth
 * for every tunable: bounds live here, defaults live in `DEFAULT_SETTINGS`, and
 * both main services and the renderer read this shape.
 */
export const AppSettings = z.object({
  /** Seconds the user is given before a pending order auto-denies. */
  approvalTimeoutSec: z.number().int().min(10).max(3600),
  /** Broker poll cadence when the window is focused during market hours. */
  pollIntervalFocusedSec: z.number().int().min(1).max(120),
  /** Broker poll cadence when blurred or the market is closed. */
  pollIntervalBlurredSec: z.number().int().min(1).max(600),
  /** Approval mode applied to newly created agents. */
  defaultApprovalMode: ApprovalMode,
  /** Set once the first-run onboarding wizard has been completed or skipped. */
  onboardingComplete: z.boolean(),
  /** Anonymous product-telemetry opt-out. On by default; the capture-time gate in
   *  AnalyticsService reads this live via `settings:changed`. */
  telemetryEnabled: z.boolean(),
  /** Global on/off for the whole background turn-limit feature. On by default; when off,
   *  no agent is ever gated/counted and the agent-view turn-limit button is hidden.
   *  Distinct from the per-agent `Agent.turnLimitEnabled` switch. */
  headlessTurnLimitEnabled: z.boolean(),
  /** Max headless (scheduled background) turns an agent may run between resets. One
   *  global value for all agents; per-agent there is only an on/off toggle
   *  (`Agent.turnLimitEnabled`). The count refills only via the agent view's
   *  turn-limit button's Reset control. */
  maxHeadlessTurns: z.number().int().min(1).max(1000),
  /** Hard ceiling on a single scheduled background run, in minutes (includes time parked
   *  at the approval gate). On expiry the run is SIGTERM'd; it's a clean stop, not a
   *  failure. Always applies, independent of the turn limit. */
  maxHeadlessRunMinutes: z.number().int().min(5).max(60),
  /** Whether background (headless `-p`) runs may use `ANTHROPIC_API_KEY` from the env.
   *  **Off by default**: unattended runs launch with the key stripped, so `claude` uses
   *  the logged-in Claude subscription instead of silently billing the Anthropic API. On
   *  keeps the key (the whole app env is inherited, so a shell `ANTHROPIC_API_KEY` flows
   *  through). Interactive sessions are unaffected either way. */
  backgroundAllowApiKey: z.boolean(),

  // ---- desktop notifications (§12.4). All default on: the launcher gates display. ----
  /** Notify when a cron/monitor wakes an agent (launcher shows it only while unfocused). */
  notifyWakes: z.boolean(),
  /** Notify when an agent-placed order reaches a terminal state (filled/rejected/…). */
  notifyOrders: z.boolean(),
  /** Notify banner for a new pending approval (the dock badge/flash are unconditional). */
  notifyApprovals: z.boolean(),
  /** Notify when an agent hits its headless turn limit and is paused. */
  notifyRestricted: z.boolean(),
  /** Notify when an app update has been downloaded and is ready to install. */
  notifyUpdates: z.boolean(),
  /** Agent ids whose notifications are muted entirely (a coarse per-agent switch). */
  notifyMutedAgents: z.array(z.string()),

  // ---- menu bar (§12.6) ----
  /** Show the OpenTrade status item in the macOS menu bar / Windows system tray and keep the launcher alive
   *  there when the window is closed / ⌘Q'd, so agent status + notifications keep
   *  flowing while the app is "closed". On by default; off restores plain quit. */
  showInMenuBar: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  approvalTimeoutSec: 300,
  pollIntervalFocusedSec: 5,
  pollIntervalBlurredSec: 10,
  defaultApprovalMode: "approve",
  onboardingComplete: false,
  telemetryEnabled: true,
  headlessTurnLimitEnabled: true,
  maxHeadlessTurns: 20,
  maxHeadlessRunMinutes: 30,
  backgroundAllowApiKey: false,
  notifyWakes: true,
  notifyOrders: true,
  notifyApprovals: true,
  notifyRestricted: true,
  notifyUpdates: true,
  notifyMutedAgents: [],
  showInMenuBar: true,
};

/** A partial update of the editable settings. */
export const SettingsUpdate = AppSettings.partial();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
