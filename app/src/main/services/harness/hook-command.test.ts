import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { hookCommand } from "./hook-command";

describe("hookCommand", () => {
  test("uses cmd.exe syntax and quotes Windows paths", () => {
    const command = hookCommand(
      "C:\\Users\\Jane Doe\\hooks",
      "approval",
      "agent-1",
      "C:\\Users\\Jane Doe\\OpenTrade Data",
      "win32",
    );
    expect(command).toStartWith('set "ELECTRON_RUN_AS_NODE=1"&& ');
    expect(command).toContain('"C:\\Users\\Jane Doe\\hooks\\hook-runner.cjs"');
    expect(command).toEndWith('"approval" "agent-1" "C:\\Users\\Jane Doe\\OpenTrade Data"');
  });

  test("uses POSIX environment assignment and shell quoting", () => {
    const command = hookCommand(
      "/Users/jane/hooks",
      "status",
      "agent-2",
      "/Users/jane/.opentrade",
      "darwin",
    );
    expect(command).toStartWith("ELECTRON_RUN_AS_NODE=1 ");
    expect(command).toContain(`'${join("/Users/jane/hooks", "hook-runner.cjs")}'`);
    expect(command).toEndWith("'status' 'agent-2' '/Users/jane/.opentrade'");
  });
});

describe("hook runner", () => {
  const runner = join(import.meta.dir, "../../../../../resources/hooks/hook-runner.cjs");

  test("fails approval closed when the local endpoint is unavailable", () => {
    const result = spawnSync(process.execPath, [runner, "approval", "agent-1", join(import.meta.dir, "missing")], {
      input: '{"hook_event_name":"PreToolUse"}',
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("keeps observational hooks silent when the local endpoint is unavailable", () => {
    const result = spawnSync(process.execPath, [runner, "status", "agent-1", join(import.meta.dir, "missing")], {
      input: "{}",
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
