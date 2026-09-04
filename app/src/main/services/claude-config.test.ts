import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_DEFAULT_RETENTION_DAYS,
  claudeConfigDir,
  readClaudeRetention,
} from "./claude-config";

function withSettings(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  if (contents !== undefined) writeFileSync(join(dir, "settings.json"), contents);
  return dir;
}

describe("readClaudeRetention", () => {
  test("explicit cleanupPeriodDays is read + marked configured", () => {
    const dir = withSettings('{"cleanupPeriodDays": 365}');
    const r = readClaudeRetention(dir);
    expect(r.days).toBe(365);
    expect(r.configured).toBe(true);
    expect(r.settingsPath).toBe(join(dir, "settings.json"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file → Claude Code default, not configured", () => {
    const dir = withSettings();
    const r = readClaudeRetention(dir);
    expect(r.days).toBe(CLAUDE_DEFAULT_RETENTION_DAYS);
    expect(r.configured).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("key absent → default", () => {
    const dir = withSettings('{"theme":"dark"}');
    expect(readClaudeRetention(dir).configured).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("malformed JSON → default (never throws)", () => {
    const dir = withSettings("{not valid json");
    expect(readClaudeRetention(dir).days).toBe(CLAUDE_DEFAULT_RETENTION_DAYS);
    rmSync(dir, { recursive: true, force: true });
  });

  test("invalid values (0, negative, string) → default", () => {
    for (const v of [
      '{"cleanupPeriodDays":0}',
      '{"cleanupPeriodDays":-5}',
      '{"cleanupPeriodDays":"365"}',
    ]) {
      const dir = withSettings(v);
      expect(readClaudeRetention(dir).configured).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fractional days floored", () => {
    const dir = withSettings('{"cleanupPeriodDays": 30.9}');
    expect(readClaudeRetention(dir).days).toBe(30);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("claudeConfigDir", () => {
  test("honors CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/cc" })).toBe("/custom/cc");
  });

  test("falls back to ~/.claude", () => {
    expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
  });
});
