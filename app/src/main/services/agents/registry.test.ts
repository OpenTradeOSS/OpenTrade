import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATED_TOOL_MATCHER, GATED_TOOLS } from "@shared/robinhood-tools";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";

// Isolate OPENTRADE_HOME to a throwaway dir before the registry module (which derives
// AGENTS_DIR from it) loads — hence the dynamic import in beforeAll.
const HOME = mkdtempSync(join(tmpdir(), "registry-home-"));
process.env.OPENTRADE_HOME = HOME;

let AgentRegistry: typeof import("./registry").AgentRegistry;
beforeAll(async () => {
  ({ AgentRegistry } = await import("./registry"));
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Build the real schema instead of a hand-maintained subset — SCHEMA_DDL is
 *  dependency-free precisely so tests can do this, and it can't drift from production. */
function memDb(): { db: Db; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  return { db: drizzle(sqlite, { schema }) as unknown as Db, sqlite };
}

function memRegistry() {
  return new AgentRegistry(memDb().db);
}

describe("AgentRegistry — executionState", () => {
  test("defaults to offline; tracks the wake actor's state; offline drops the entry", () => {
    const r = memRegistry();
    expect(r.executionStateOf("a")).toBe("offline"); // default

    r.setExecutionState("a", "interactive");
    expect(r.executionStateOf("a")).toBe("interactive");
    r.setExecutionState("a", "headless");
    expect(r.executionStateOf("a")).toBe("headless");
    r.setExecutionState("a", "broken");
    expect(r.executionStateOf("a")).toBe("broken");

    r.setExecutionState("a", "offline"); // back to the default → entry removed
    expect(r.executionStateOf("a")).toBe("offline");
  });
});

describe("AgentRegistry — turn budgets", () => {
  test("resetAllTurnBudgets zeros every count and re-enables the per-agent limit", () => {
    const r = memRegistry();
    const a = r.create({
      name: "alpha",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    const b = r.create({
      name: "beta",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    // alpha: spent + per-agent limit turned OFF; beta: some usage, limit on.
    r.incrementHeadlessTurns(a.id);
    r.incrementHeadlessTurns(a.id);
    r.update(a.id, { turnLimitEnabled: false });
    r.incrementHeadlessTurns(b.id);
    expect(r.get(a.id)!.turnLimitEnabled).toBe(false);
    expect(r.get(a.id)!.headlessTurnsUsed).toBe(2);
    expect(r.get(b.id)!.headlessTurnsUsed).toBe(1);

    r.resetAllTurnBudgets();

    // Every agent: count zeroed AND per-agent limit forced back on (overrides opt-out).
    for (const id of [a.id, b.id]) {
      expect(r.get(id)!.headlessTurnsUsed).toBe(0);
      expect(r.get(id)!.turnLimitEnabled).toBe(true);
    }
  });
});

describe("AgentRegistry — CLAUDE.md composition", () => {
  // Markers unique to each half of the composed file.
  const PREFIX_MARKER = "## Self-scheduling — staying awake on the user's behalf";

  function claudeMdFor(template: string): string {
    const r = memRegistry();
    const agent = r.create({
      name: `compose ${template}`,
      template,
      harness: "claude",
      approvalMode: "approve",
    });
    return readFileSync(join(r.agentDir(agent), "CLAUDE.md"), "utf8");
  }

  test("prepends the shared OpenTrade prefix to every template's specialty section", () => {
    for (const [template, specialtyMarker] of [
      ["default", "## Your specialty — general purpose"],
      ["dca", "## Your specialty — dollar-cost averaging (DCA)"],
      ["momentum", "## Your specialty — momentum / trend-following"],
    ] as const) {
      const md = claudeMdFor(template);
      expect(md).toContain(PREFIX_MARKER); // shared mechanics present…
      expect(md).toContain(specialtyMarker); // …followed by the template's own section
      // Prefix comes first, specialty after.
      expect(md.indexOf(PREFIX_MARKER)).toBeLessThan(md.indexOf(specialtyMarker));
      // The shared title appears exactly once (the specialty file no longer carries its own H1).
      expect(md.startsWith("# OpenTrade Agent\n")).toBe(true);
      expect(md.split("# OpenTrade Agent").length - 1).toBe(1);
    }
  });

  test("unknown templates fall back to default but still get the prefix", () => {
    const md = claudeMdFor("does-not-exist");
    expect(md).toContain(PREFIX_MARKER);
    expect(md).toContain("## Your specialty — general purpose");
  });
});

describe("AgentRegistry — codex scaffold divergence", () => {
  test("codex agents get AGENTS.md + generated .codex config, no claude files", async () => {
    const { registerHarness } = await import("../harness");
    const { createCodexHarness } = await import("../harness/codex");
    const { CodexAppServerManager } = await import("../harness/codex-app-server");
    // writeConfig/scaffold never touch the manager — a bare instance is fine.
    registerHarness(
      createCodexHarness(
        new CodexAppServerManager(
          () => ({}),
          async () => ({}),
        ),
      ),
    );

    const r = memRegistry();
    const agent = r.create({
      name: "codex one",
      template: "default",
      harness: "codex",
      approvalMode: "approve",
    });
    const dir = r.agentDir(agent);
    const { existsSync, readFileSync } = await import("node:fs");
    const { basename, join } = await import("node:path");
    const { codexHomeFor } = await import("../harness/codex-app-server");
    const codexHome = codexHomeFor(basename(dir));

    // Instructions: AGENTS.md composed from the codex prefix + the specialty.
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    // Harness-neutral template files (kickoff.md) MUST still be copied — the cpSync
    // filter skips only claude-specific artifacts. Regression guard for B3: an absolute
    // template path containing a `/.claude` segment (e.g. this repo under
    // `.claude/worktrees/`) previously filtered out EVERY file, leaving no kickoff.
    expect(existsSync(join(dir, "kickoff.md"))).toBe(true);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("# OpenTrade Agent");
    expect(agents).toContain("Codex");

    // Claude-shaped template files skipped; codex config generated instead.
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain("[mcp_servers.robinhood]");
    // The fail-closed anchor: every money-mover in the shared table ALWAYS prompts
    // ("approve" would mean pre-approved!), everything else pre-allowed like
    // claude's allowlist. Spot-check one tool per asset class + the exercise pair
    // against literal names so a gutted table can't silently pass its own test.
    for (const t of GATED_TOOLS) {
      expect(toml).toContain(`[mcp_servers.robinhood.tools.${t}]\napproval_mode = "prompt"`);
    }
    for (const t of [
      "place_equity_order",
      "place_option_order",
      "place_crypto_order",
      "exercise_option",
      "cancel_option_exercise",
    ]) {
      expect(GATED_TOOLS).toContain(t);
    }
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    // Project trust suppresses the TUI's first-run trust prompt — keyed by the
    // REALPATH (codex canonicalizes the cwd before matching).
    const { realpathSync } = await import("node:fs");
    expect(toml).toContain(`[projects.${JSON.stringify(realpathSync(dir))}]`);
    // The opentrade MCP entry carries NO secrets (port/token ride the server env).
    expect(toml).toContain("[mcp_servers.opentrade]");
    expect(toml).not.toContain("OPENTRADE_TOKEN");

    // Gate hooks: claude-compatible hooks.json + executable scripts, abs paths.
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    const pre = hooks.hooks.PreToolUse[0];
    expect(pre.matcher).toBe(GATED_TOOL_MATCHER);
    // The regex form must actually match the prefixed tool names Claude Code sees.
    expect(new RegExp(`^${pre.matcher}$`).test("mcp__robinhood__place_crypto_order")).toBe(true);
    expect(new RegExp(`^${pre.matcher}$`).test("mcp__robinhood__get_equity_quotes")).toBe(false);
    // The command is a shell string carrying the non-secret identifiers (codex
    // cleans the hook env; the scripts recover port/token from the manifest).
    expect(pre.hooks[0].command).toContain(join(codexHome, "hooks", "approval-gate.sh"));
    expect(pre.hooks[0].command).toContain("OPENTRADE_AGENT_ID=");
    expect(pre.hooks[0].command).toContain("OPENTRADE_HOME=");
    expect(pre.hooks[0].timeout).toBe(600);
    expect(existsSync(join(codexHome, "hooks", "approval-gate.sh"))).toBe(true);
    expect(existsSync(join(codexHome, "hooks", "order-result.sh"))).toBe(true);
    // Stop = the turn-ended stamp (codex's only status hook — it has no
    // Notification event). No matcher: fires on every turn end.
    const stop = hooks.hooks.Stop[0];
    expect(stop.matcher).toBeUndefined();
    expect(stop.hooks[0].command).toContain(join(codexHome, "hooks", "status-notify.sh"));
    expect(stop.hooks[0].command).toContain("OPENTRADE_AGENT_ID=");
    expect(existsSync(join(codexHome, "hooks", "status-notify.sh"))).toBe(true);

    // codexHomeFor resolves under the REAL ~/.opentrade/cx (keyed by a hash, not
    // OPENTRADE_HOME — the socket-path length constraint), so this test writes outside
    // the throwaway HOME. Clean it up so the suite leaves no trace on the dev machine.
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("claude agents scaffold exactly as before (regression)", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const r = memRegistry();
    const agent = r.create({
      name: "claude one",
      template: "default",
      harness: "claude",
      approvalMode: "approve",
    });
    const dir = r.agentDir(agent);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".codex"))).toBe(false);
    // The order GATE must actually be wired — not just that the file exists. (The old
    // test only checked existence, which passed in dev because the untracked template
    // settings.json is present locally; clean CI builds lack it and shipped ungated.)
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse[0];
    expect(pre.matcher).toBe(GATED_TOOL_MATCHER);
    expect(settings.hooks.PostToolUse[0].matcher).toBe(GATED_TOOL_MATCHER);
    // Reads and cosmetic writes ride the allowlist; money-movers must NOT.
    expect(settings.permissions.allow).toContain("mcp__robinhood__get_*");
    expect(settings.permissions.allow).toContain("mcp__robinhood__add_to_watchlist");
    expect(settings.permissions.allow).not.toContain("mcp__robinhood__place_crypto_order");
    expect(pre.hooks[0].command).toContain(".claude/hooks/approval-gate.sh");
    expect(existsSync(join(dir, ".claude", "hooks", "approval-gate.sh"))).toBe(true);
  });

  test("claude writeConfig GENERATES the gate config from a bare dir (build-independent + self-heal)", async () => {
    // The root cause of ungated orders: the template's .claude/settings.json is
    // git-untracked, so a clean CI build never bundles it and a template-copy scaffold
    // produced NO gate. writeConfig must generate it from code — proven here against a
    // dir that has NO template settings.json (mimics a CI-created / tampered agent).
    const { claudeHarness } = await import("../harness/claude");
    const { existsSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "claude-writeconfig-"));
    try {
      expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false); // bare
      claudeHarness.writeConfig?.(dir, "agent-x");
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("approval-gate.sh");
      expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(600);
      expect(existsSync(join(dir, ".claude", "hooks", "approval-gate.sh"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentRegistry — lastActiveAt (= last_turn_at)", () => {
  /** Insert an agent row directly — create() would scaffold a real folder. */
  function seedAgent(sqlite: Database, id: string) {
    sqlite.exec(
      `INSERT INTO agents (id, slug, name, template, approval_mode, status, created_at)
       VALUES ('${id}', '${id}', '${id}', 'default', 'approve', 'idle', 1)`,
    );
  }

  test("null until the agent's first turn; markAgentTurn is the only writer", () => {
    const { db, sqlite } = memDb();
    const r = new AgentRegistry(db);
    seedAgent(sqlite, "a");
    expect(r.get("a")?.lastActiveAt).toBe(null);

    // Wake/audit history alone does NOT move it — `lastActiveAt` is the stamp
    // column, not a derivation (the scheduler stamps via markAgentTurn at fire).
    sqlite.exec(
      `INSERT INTO wakes (id, agent_id, source_kind, prompt, background, fired_at)
       VALUES ('w1', 'a', 'cron', 'go', 1, 1000)`,
    );
    sqlite.exec(
      `INSERT INTO audit_log (agent_id, kind, payload, at) VALUES ('a', 'order_intent', '{}', 500)`,
    );
    expect(r.get("a")?.lastActiveAt).toBe(null);

    const before = Date.now();
    r.markAgentTurn("a");
    const at = r.get("a")?.lastActiveAt;
    expect(at).toBeGreaterThanOrEqual(before);
  });

  test("the agent-turn stamp is durable — it survives losing the registry instance", () => {
    // The host restarts on every app update, so an in-memory stamp would snap every
    // agent back to its last wake/audit time. Same DB, fresh registry = that restart.
    const { db, sqlite } = memDb();
    seedAgent(sqlite, "a");
    new AgentRegistry(db).markAgentTurn("a");

    const afterRestart = new AgentRegistry(db).get("a")?.lastActiveAt;
    expect(afterRestart).toBeGreaterThan(0);
    expect(sqlite.query("SELECT last_turn_at FROM agents WHERE id='a'").get()).toEqual({
      last_turn_at: afterRestart,
    });
  });

  test("is per-agent and rides list()", () => {
    const { db, sqlite } = memDb();
    const r = new AgentRegistry(db);
    seedAgent(sqlite, "a");
    seedAgent(sqlite, "b");
    r.markAgentTurn("a");
    const list = r.list();
    expect(list.find((x) => x.id === "a")?.lastActiveAt).toBeGreaterThan(0);
    expect(list.find((x) => x.id === "b")?.lastActiveAt).toBe(null);
  });
});
