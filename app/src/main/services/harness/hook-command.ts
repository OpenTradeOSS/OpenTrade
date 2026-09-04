import { join } from "node:path";

export type HookKind = "approval" | "order-result" | "status";

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function quoteCmd(value: string): string {
  // Percent expansion still happens inside cmd.exe quotes. Doubling it preserves
  // literal percent signs in user profile / agent paths.
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * Build a shell command that runs a hook through the bundled Electron binary in
 * Node mode. This avoids requiring Bash, curl, sed, or a separate Node install on
 * the user's machine and therefore works in both POSIX shells and cmd.exe.
 */
export function hookCommand(
  runnerDir: string,
  kind: HookKind,
  agentId: string,
  opentradeHome: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const runner = join(runnerDir, "hook-runner.cjs");
  const args = [process.execPath, runner, kind, agentId, opentradeHome].map(
    platform === "win32" ? quoteCmd : quotePosix,
  );
  return platform === "win32"
    ? `set "ELECTRON_RUN_AS_NODE=1"&& ${args.join(" ")}`
    : `ELECTRON_RUN_AS_NODE=1 ${args.join(" ")}`;
}
