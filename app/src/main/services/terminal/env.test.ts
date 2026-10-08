import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentEnv } from "./env";

describe("buildAgentEnv — subscription auth", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });

  test("strips the harness's API keys when subscription auth is on (background runs)", () => {
    const env = buildAgentEnv("a1", undefined, { stripEnvKeys: ["ANTHROPIC_API_KEY"] });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("keeps ANTHROPIC_API_KEY when no strip list is given", () => {
    const env = buildAgentEnv("a1", undefined, { stripEnvKeys: [] });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  test("keeps the key by default (no opts) — the interactive path is untouched", () => {
    const env = buildAgentEnv("a1");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    // Sanity: OPENTRADE identifiers are still injected.
    expect(env.OPENTRADE_AGENT_ID).toBe("a1");
  });
});

describe("buildAgentEnv — started from inside an agent session", () => {
  const OUTER = {
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "outer",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(OUTER)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(OUTER)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  test("drops the outer session's identity but keeps the user's CLI configuration", () => {
    const env = buildAgentEnv("a1");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });
});
