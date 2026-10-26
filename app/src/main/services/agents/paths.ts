import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Path resolvers for bundled agent-scaffold assets across dev and packaged
 * layouts. Split from the registry so harness implementations (which generate
 * per-agent config referencing these assets) can share them without a cycle.
 */

/** Locate the bundled agent templates in dev and packaged layouts. */
export function resolveTemplatesDir(): string {
  const candidates = [
    join(process.cwd(), "..", "templates", "agents"),
    join(process.cwd(), "templates", "agents"),
    // out/main -> repo root in dev
    join(__dirname, "..", "..", "..", "templates", "agents"),
    join(process.resourcesPath ?? "", "templates", "agents"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // Fall back to the first candidate; callers surface a clear error.
  return candidates[0];
}

/** Locate the bundled hook scripts (resources/hooks) across dev/packaged layouts. */
export function resolveHooksDir(): string {
  const candidates = [
    join(process.cwd(), "..", "resources", "hooks"),
    join(process.cwd(), "resources", "hooks"),
    join(__dirname, "..", "..", "..", "resources", "hooks"),
    join(process.resourcesPath ?? "", "resources", "hooks"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * Absolute path to the bundled `opentrade` agent-MCP server (`out/main/agent-mcp.js`),
 * which the agent's harness spawns per agent. In a packaged app it's spawned as a
 * child process (not by Electron), so it must be the asar-UNPACKED copy (see
 * electron-builder.yml).
 */
export function resolveAgentMcp(): string {
  const local = join(__dirname, "agent-mcp.js"); // host bundle lives in out/main
  return local.includes("app.asar") ? local.replace("app.asar", "app.asar.unpacked") : local;
}
