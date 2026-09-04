import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GATED_TOOL_MATCHER, PREALLOWED_TOOL_PATTERNS } from "@shared/robinhood-tools";
import { OPENTRADE_HOME } from "../../db/client";
import { resolveHooksDir } from "../agents/paths";
import { hookCommand } from "./hook-command";
import { claudeConfigHasRobinhood } from "./robinhood-mcp";
import type { Harness, ProbeResult, SessionMode } from "./types";

const execFileAsync = promisify(execFile);

/**
 * The agent-dir `.claude/settings.json` that wires Claude Code's order gate: the
 * PreToolUse hook on the money-moving tools (→ the cross-platform hook runner and approval card),
 * the PostToolUse order-result capture, and the Notification/Stop status hooks, plus
 * the allowlist for reads and cosmetic writes. The matcher and allowlist derive from
 * the classification table in `@shared/robinhood-tools` — the single place the gated
 * set is maintained. Generated IN CODE (not copied from the template): the
 * template's `.claude/settings.json` is git-untracked (`.claude/` is gitignored), so a
 * clean CI release build never bundles it and a template-copy scaffold leaves the agent
 * UNGATED. Emitting it here — and re-emitting before every spawn — makes the gate
 * build-independent and self-heals agents created by an older/ungated build.
 * `$CLAUDE_PROJECT_DIR` resolves to the agent folder, so the hooks stay agent-scoped
 * (never the user's global `~/.claude`).
 */
function claudeSettingsJson(hooksDir: string, agentId: string): string {
  return `${JSON.stringify(
    {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    enabledMcpjsonServers: ["robinhood", "opentrade"],
    permissions: {
      allow: [...PREALLOWED_TOOL_PATTERNS, "mcp__opentrade__*"],
      deny: [],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: GATED_TOOL_MATCHER,
          hooks: [
            {
              type: "command",
              command: hookCommand(hooksDir, "approval", agentId, OPENTRADE_HOME),
              timeout: 600,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: GATED_TOOL_MATCHER,
          hooks: [
            {
              type: "command",
              command: hookCommand(hooksDir, "order-result", agentId, OPENTRADE_HOME),
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: "command",
              command: hookCommand(hooksDir, "status", agentId, OPENTRADE_HOME),
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: hookCommand(hooksDir, "status", agentId, OPENTRADE_HOME),
            },
          ],
        },
      ],
    },
    },
    null,
    2,
  )}\n`;
}

/**
 * `--dangerously-load-development-channels` is a VARIADIC flag (`<servers...>`):
 * passed as two argv tokens (`--flag server:opentrade`) it greedily consumes every
 * following non-`-` token — including the positional kickoff prompt on first run.
 * Claude then parses the whole kickoff as a second channel spec, fails, prints the
 * channel-format usage, and exits immediately (the first-run "session ended — Resume
 * to continue" bug; resume/headless escaped it only because they have no trailing
 * positional). The `=`-bound single-value form binds exactly one channel and stops
 * the variadic there, so the kickoff stays a normal positional prompt.
 */
const CHANNEL_ARG = "--dangerously-load-development-channels=server:opentrade";

/**
 * Claude Code: the original harness. OpenTrade mints the session uuid
 * (`--session-id`) and resumes it everywhere; interactive PTYs register the
 * `opentrade` channel so scheduled wakes inject into the live session; headless
 * wakes are one-shot `--resume … -p` children with permissions skipped (order
 * tools stay gated by the PreToolUse hook, which fires even under that flag).
 */
export const claudeHarness: Harness = {
  id: "claude",
  binary: "claude",
  instructionsFile: "CLAUDE.md",
  instructionsPrefixFile: "CLAUDE.prefix.md",
  // Strip so background runs use the Claude subscription login rather than
  // silently billing an `ANTHROPIC_API_KEY` inherited from the user's shell.
  subscriptionAuthStrip: ["ANTHROPIC_API_KEY"],

  interactiveArgs(mode: SessionMode, sessionId: string, kickoff?: string | null): string[] {
    if (mode === "resume") return ["--resume", sessionId, CHANNEL_ARG];
    // The kickoff is the positional prompt, placed after all flags. Safe only
    // because CHANNEL_ARG uses the `=`-bound form (a bare variadic would swallow it).
    return ["--session-id", sessionId, CHANNEL_ARG, ...(kickoff ? [kickoff] : [])];
  },

  writeConfig(agentDir: string, agentId: string): void {
    // Generate the order-gate config in the agent's OWN .claude folder (project-scoped;
    // never the user's global ~/.claude). Runs at scaffold AND before every spawn, so it
    // heals agents that a clean CI build created without the (untracked) template
    // settings.json — the root cause of ungated orders. Also (re)ensures the executable
    // hook scripts the settings reference.
    const claudeDir = join(agentDir, ".claude");
    const hooksDir = join(claudeDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), claudeSettingsJson(hooksDir, agentId));
    const hooksSrc = resolveHooksDir();
    if (existsSync(hooksSrc)) {
      for (const file of readdirSync(hooksSrc)) {
        const dest = join(hooksDir, file);
        copyFileSync(join(hooksSrc, file), dest);
        try {
          chmodSync(dest, 0o755);
        } catch {
          // best effort
        }
      }
    }
  },

  interactiveEnv(): Record<string, string> {
    return {
      // Force Claude Code's fullscreen ("no-flicker") renderer for interactive PTYs:
      // it draws on the alternate screen buffer and handles its own scrollback instead
      // of spilling into the terminal's, which keeps memory flat and rendering clean in
      // our embedded xterm. Equivalent to the saved `tui` setting, but enforced here so
      // every session we launch gets it regardless of the user's config.
      // https://code.claude.com/docs/en/fullscreen
      CLAUDE_CODE_NO_FLICKER: "1",
    };
  },

  headlessArgs(mode: SessionMode, sessionId: string, wakePrompt: string): string[] {
    const session = mode === "resume" ? ["--resume", sessionId] : ["--session-id", sessionId];
    return [...session, "--dangerously-skip-permissions", "-p", wakePrompt];
  },

  async probe(env: Record<string, string>): Promise<ProbeResult> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], { env, timeout: 5000 });
      return { found: true, version: stdout.trim() };
    } catch {
      return { found: false, version: null };
    }
  },

  robinhoodMcpConfigured(): boolean {
    // Claude Code's user config. Only the top-level `mcpServers` map is user-scope
    // — the one every agent folder inherits. Servers added at local/project scope
    // live under that project's own entry and don't carry over, so they
    // deliberately don't count as configured here.
    try {
      return claudeConfigHasRobinhood(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    } catch {
      // No config file yet (fresh Claude Code install) — nothing registered.
      return false;
    }
  },
};
