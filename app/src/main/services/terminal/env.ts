import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { OPENTRADE_HOME } from "../../db/client";

/**
 * Build the environment for an agent's PTY. We inherit the app's env, ensure the
 * usual macOS bin dirs are on PATH (so `claude`, `git`, etc. resolve), and inject
 * OPENTRADE_* identifiers. The hooks-server port/token (OPENTRADE_PORT /
 * OPENTRADE_TOKEN) are layered in by M3.
 *
 * `stripEnvKeys` (set for background/headless runs, from the harness's
 * `subscriptionAuthStrip` list — e.g. `ANTHROPIC_API_KEY` for claude,
 * `OPENAI_API_KEY` for codex) removes API keys from the inherited env so the CLI
 * bills the user's logged-in subscription instead of silently hitting an API key —
 * the whole app env is inherited, so a key in the user's shell would otherwise
 * leak into every unattended run (the "unattended runs bill the API" cost bug).
 */
export function buildAgentEnv(
  agentId: string,
  extra?: Record<string, string>,
  opts?: { stripEnvKeys?: readonly string[] },
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }

  for (const key of opts?.stripEnvKeys ?? []) delete base[key];

  const home = homedir();
  const extraPathDirs = [
    join(home, ".opentrade", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const currentPath = base.PATH ?? "";
  const merged = [...extraPathDirs, ...currentPath.split(delimiter)].filter(Boolean);
  base.PATH = [...new Set(merged)].join(delimiter);

  base.TERM = "xterm-256color";
  base.COLORTERM = "truecolor";
  base.OPENTRADE_AGENT_ID = agentId;
  base.OPENTRADE_HOME = OPENTRADE_HOME;

  return { ...base, ...extra };
}
