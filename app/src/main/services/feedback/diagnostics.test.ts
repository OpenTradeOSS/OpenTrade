import { describe, expect, test } from "bun:test";
import type { Agent } from "@shared/agent";
import { FeedbackDiagnostics } from "@shared/feedback";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { buildDiagnostics, cliVersionOf, type DiagnosticsValues } from "./diagnostics";

const NOW = 1_800_000_000_000;

function agent(overrides: Partial<Agent>): Agent {
  return {
    harness: "claude",
    status: "idle",
    executionState: "offline",
    approvalMode: "approve",
    headlessTurnsUsed: 0,
    turnLimitEnabled: true,
    lastActiveAt: null,
    ...overrides,
  } as Agent;
}

const VALUES: DiagnosticsValues = {
  agents: [
    // working, active today, auto-mode
    agent({
      status: "working",
      executionState: "interactive",
      approvalMode: "auto",
      lastActiveAt: NOW - 1000,
    }),
    // broken, budget spent, last active a week ago
    agent({ executionState: "broken", headlessTurnsUsed: 99, lastActiveAt: NOW - 7 * 86_400_000 }),
    // codex, waiting on an approval
    agent({ harness: "codex", status: "awaiting-approval" }),
  ],
  crons: 4,
  monitors: 1,
  brokerStatus: "connected",
  brokerAuthorized: true,
  portfolioFetchedAt: NOW - 12_500,
  pendingApprovals: 2,
  settings: { ...DEFAULT_SETTINGS, telemetryEnabled: false },
  claudeVersion: "2.0.1 (Claude Code)",
  codexVersion: null,
};

describe("buildDiagnostics", () => {
  test("derives counts, ages and settings; the result satisfies the strict schema", () => {
    const d = buildDiagnostics(VALUES, NOW);
    expect(FeedbackDiagnostics.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({
      claude_version: "2.0.1 (Claude Code)",
      codex_version: null,
      agent_count: 3,
      agents_claude: 2,
      agents_codex: 1,
      agents_working: 1,
      agents_needs_input: 0,
      agents_awaiting_approval: 1,
      agents_broken: 1,
      agents_auto_mode: 1,
      agents_turn_limited: 1,
      agents_active_24h: 1,
      schedules_enabled: 4,
      monitors_enabled: 1,
      broker_status: "connected",
      broker_authorized: true,
      broker_portfolio_age_sec: 12,
      pending_approvals: 2,
      telemetry_enabled: false,
      max_headless_turns: DEFAULT_SETTINGS.maxHeadlessTurns,
    });
  });

  test("null portfolio age before the first fetch; turn-limited is 0 when the feature is off", () => {
    const d = buildDiagnostics(
      {
        ...VALUES,
        portfolioFetchedAt: null,
        settings: { ...DEFAULT_SETTINGS, headlessTurnLimitEnabled: false },
      },
      NOW,
    );
    expect(d.broker_portfolio_age_sec).toBeNull();
    expect(d.agents_turn_limited).toBe(0);
  });
});

describe("cliVersionOf", () => {
  test("keeps the first line of a version banner, drops anything outside the charset", () => {
    expect(cliVersionOf({ found: true, version: "2.0.1 (Claude Code)\nsecond line" })).toBe(
      "2.0.1 (Claude Code)",
    );
    expect(cliVersionOf({ found: true, version: "/Users/someone/bin/claude 2.0" })).toBeNull();
    expect(cliVersionOf({ found: false, version: null })).toBeNull();
  });
});
