import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's default transcript retention when `cleanupPeriodDays` is unset. */
export const CLAUDE_DEFAULT_RETENTION_DAYS = 30;

/** Directory Claude Code reads user settings from — `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : join(homedir(), ".claude");
}

export interface ClaudeRetention {
  /** Effective retention in days (the configured value, or the Claude Code default). */
  days: number;
  /** True if `cleanupPeriodDays` was explicitly set (vs falling back to the default). */
  configured: boolean;
  /** The settings file the value would be read from / should be edited in. */
  settingsPath: string;
}

/**
 * The conversation-transcript retention Claude Code applies to `~/.claude/projects/*`
 * on this machine — its `cleanupPeriodDays` setting (default 30). OpenTrade agents
 * resume via those transcripts, so once one ages past this window of inactivity the
 * agent resumes with **no memory** of prior conversations. Surfaced in Settings so the
 * user can extend it. Reads user settings only (the level a user would edit); a
 * missing/unreadable/invalid file falls back to the Claude Code default.
 */
export function readClaudeRetention(dir: string = claudeConfigDir()): ClaudeRetention {
  const settingsPath = join(dir, "settings.json");
  try {
    const val = JSON.parse(readFileSync(settingsPath, "utf8"))?.cleanupPeriodDays;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return { days: Math.floor(val), configured: true, settingsPath };
    }
  } catch {
    // no file / unreadable / bad JSON → the Claude Code default applies
  }
  return { days: CLAUDE_DEFAULT_RETENTION_DAYS, configured: false, settingsPath };
}

/** Claude Code's global state file: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
function claudeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? join(override, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Mark an agent's folder as trusted in Claude Code's state, so its session doesn't open
 * on the "do you trust this folder?" prompt. Used only for OpenTrade Cloud, where the
 * folder was created by OpenTrade at the user's request and an unattended agent (or a
 * phone) shouldn't have to answer it; on the desktop the user answers it once.
 */
export function trustClaudeProject(dir: string, path: string = claudeStatePath()): void {
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // missing or unreadable: start fresh
  }
  const projects = (state.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[dir]?.hasTrustDialogAccepted === true) return;
  projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
  state.projects = projects;
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}
