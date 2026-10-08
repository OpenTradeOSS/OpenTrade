import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_INTEGRATIONS, envVarFor } from "@shared/vault";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import { SCHEMA_DDL } from "../../db/ddl";
import * as schema from "../../db/schema";
import { integrationEnv, setIntegrationSource } from "../integrations";
import { buildAgentEnv } from "../terminal/env";
import { VaultService } from "../vault";
import { claudeSettingsJson } from "./claude";
import { integrationServersToml, vaultShellEnvToml } from "./codex";
import { claudeMcpServers, writeClaudeMcpJson } from "./integrations-config";

const ALL = { robinhood: true, kalshi: true, hyperliquid: true, pmxt: true };
const NONE = { robinhood: false, kalshi: false, hyperliquid: false, pmxt: false };

function memVault(): VaultService {
  const sqlite = new Database(":memory:");
  sqlite.exec(SCHEMA_DDL);
  return new VaultService(drizzle(sqlite, { schema }) as unknown as Db);
}

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

afterEach(() => setIntegrationSource(null));

describe("claude config per integration", () => {
  test("defaults (no vault) are the pre-vault Robinhood-only setup", () => {
    const s = JSON.parse(claudeSettingsJson(DEFAULT_AGENT_INTEGRATIONS));
    expect(s.enabledMcpjsonServers).toEqual(["robinhood", "opentrade"]);
    expect(s.permissions.deny).toEqual([]);
  });

  test("everything off still leaves the scheduling server", () => {
    expect(Object.keys(claudeMcpServers(NONE))).toEqual(["opentrade"]);
    const s = JSON.parse(claudeSettingsJson(NONE));
    expect(s.permissions.allow).toEqual(["mcp__opentrade__*"]);
  });

  test("all on: kalshi allowed (gated host-side), PMXT writes denied, key referenced not embedded", () => {
    const servers = claudeMcpServers(ALL) as Record<string, { headers?: Record<string, string> }>;
    expect(Object.keys(servers)).toEqual([
      "robinhood",
      "kalshi",
      "hyperliquid",
      "pmxt",
      "opentrade",
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${VAR}` Claude Code expands
    expect(servers.pmxt.headers?.Authorization).toBe("Bearer ${PMXT_API_KEY}");
    const s = JSON.parse(claudeSettingsJson(ALL));
    expect(s.permissions.allow).toContain("mcp__kalshi__*");
    expect(s.permissions.allow).toContain("mcp__hyperliquid__*");
    expect(s.permissions.deny).toContain("mcp__pmxt__createOrder");
    expect(s.permissions.deny).toContain("mcp__pmxt__submitOrder");
  });

  test(".mcp.json keeps user-added servers and drops disabled managed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpjson-"));
    try {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { mine: { command: "x" }, robinhood: { type: "http", url: "u" } },
        }),
      );
      writeClaudeMcpJson(dir, { robinhood: false, kalshi: true, hyperliquid: false, pmxt: false });
      const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      expect(Object.keys(cfg.mcpServers).sort()).toEqual(["kalshi", "mine", "opentrade"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codex config per integration", () => {
  test("robinhood keeps its per-tool prompt anchor; others are absent when off", () => {
    const toml = integrationServersToml(
      { robinhood: true, kalshi: false, hyperliquid: false, pmxt: false },
      "a1",
    );
    expect(toml).toContain("[mcp_servers.robinhood]");
    expect(toml).toContain(
      '[mcp_servers.robinhood.tools.place_equity_order]\napproval_mode = "prompt"',
    );
    expect(toml).not.toContain("kalshi");
    expect(toml).not.toContain("pmxt");
  });

  test("kalshi + pmxt: long tool timeout, bearer env var, disabled PMXT writes, no secret", () => {
    const toml = integrationServersToml(
      { robinhood: false, kalshi: true, hyperliquid: false, pmxt: true },
      "a1",
    );
    expect(toml).not.toContain("[mcp_servers.robinhood]");
    expect(toml).toContain("[mcp_servers.kalshi]");
    expect(toml).toContain("tool_timeout_sec = 3700");
    expect(toml).toContain('OPENTRADE_AGENT_ID = "a1"');
    expect(toml).toContain('bearer_token_env_var = "PMXT_API_KEY"');
    expect(toml).toContain('"createOrder"');
    expect(toml).not.toMatch(/pmxt_[0-9a-f]{16,}/);
  });
});

describe("VaultService", () => {
  test("empty vault = Robinhood only", () => {
    const v = memVault();
    expect(v.agentIntegrations()).toEqual(DEFAULT_AGENT_INTEGRATIONS);
    expect(v.agentEnv()).toEqual({});
  });

  test("status never exposes secrets", () => {
    const v = memVault();
    v.saveKey({ name: "PMXT", value: "pmxt_supersecretvalue12345" });
    v.saveKalshi({ keyId: "key-id-abcdef123456", privateKeyPem: PEM, env: "demo" });
    const json = JSON.stringify(v.status());
    expect(json).not.toContain("supersecret");
    expect(json).not.toContain("PRIVATE KEY");
    expect(v.status()).toMatchObject({
      kalshi: { configured: true, enabled: true, env: "demo", keyIdHint: "…123456" },
      keys: [{ name: "PMXT", envVar: "PMXT_API_KEY", hint: "…12345", testable: true }],
    });
  });

  test("a bad PEM is rejected at save time", () => {
    expect(() =>
      memVault().saveKalshi({ keyId: "k", privateKeyPem: "nope", env: "prod" }),
    ).toThrow();
  });

  test("any number of keys become agent env vars; PMXT also wires its MCP", () => {
    const v = memVault();
    v.saveKey({ name: "PMXT", value: "pmxt_key_value_1" });
    v.saveKey({ name: "News API", value: "news-1" });
    v.saveKey({ name: "GITHUB_TOKEN", value: "gh-1" });
    expect(v.agentIntegrations().pmxt).toBe(true);
    expect(v.agentEnv()).toEqual({
      PMXT_API_KEY: "pmxt_key_value_1",
      NEWS_API_KEY: "news-1",
      GITHUB_TOKEN: "gh-1",
      OPENTRADE_KEYS: "PMXT_API_KEY,NEWS_API_KEY,GITHUB_TOKEN",
    });
    // Same name again rotates rather than duplicating.
    v.saveKey({ name: "pmxt", value: "pmxt_key_value_2" });
    expect(v.status().keys.filter((k) => k.envVar === "PMXT_API_KEY")).toHaveLength(1);
    expect(v.keyValue("PMXT_API_KEY")).toBe("pmxt_key_value_2");
    v.removeKey("PMXT_API_KEY");
    expect(v.agentIntegrations().pmxt).toBe(false);
  });

  test("keys can't take over OpenTrade's own or the CLIs' billing env vars", () => {
    const v = memVault();
    expect(() => v.saveKey({ name: "ANTHROPIC_API_KEY", value: "x" })).toThrow(/reserved/);
    expect(() => v.saveKey({ name: "OPENTRADE_TOKEN", value: "x" })).toThrow(/reserved/);
    expect(() => v.saveKey({ name: "!!!", value: "x" })).toThrow();
  });

  test("the first build's single PMXT slot migrates into the key list", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(SCHEMA_DDL);
    sqlite.run("INSERT INTO settings (key, value) VALUES ('vault_pmxt', ?)", [
      JSON.stringify({ apiKey: "pmxt_legacy_key", enabled: true }),
    ]);
    const v = new VaultService(drizzle(sqlite, { schema }) as unknown as Db);
    expect(v.keyValue("PMXT_API_KEY")).toBe("pmxt_legacy_key");
    expect(
      sqlite.query("SELECT count(*) AS n FROM settings WHERE key = 'vault_pmxt'").get(),
    ).toEqual({ n: 0 });
  });

  test("venue switches drive agent integrations", () => {
    const v = memVault();
    v.saveKalshi({ keyId: "k", privateKeyPem: PEM, env: "prod" });
    v.setEnabled("robinhood", false);
    expect(v.agentIntegrations()).toEqual({
      robinhood: false,
      kalshi: true,
      hyperliquid: false,
      pmxt: false,
    });
    // Switching env keeps the stored key when no new PEM is pasted.
    v.saveKalshi({ keyId: "k", env: "demo" });
    expect(v.kalshiCredentials()?.env).toBe("demo");
    v.setEnabled("kalshi", false);
    expect(v.kalshiCredentials()).toBeNull();
    v.removeKalshi();
    expect(v.status().kalshi.configured).toBe(false);
  });

  test("registered as the integration source, it feeds buildAgentEnv", () => {
    const v = memVault();
    v.saveKey({ name: "PMXT", value: "pmxt_key_value_2" });
    setIntegrationSource(v);
    expect(integrationEnv()).toMatchObject({ PMXT_API_KEY: "pmxt_key_value_2" });
    expect(buildAgentEnv("a1").PMXT_API_KEY).toBe("pmxt_key_value_2");
    expect(buildAgentEnv("a1").OPENTRADE_KEYS).toBe("PMXT_API_KEY");
  });
});

describe("envVarFor", () => {
  test.each([
    ["PMXT", "PMXT_API_KEY"],
    ["news api", "NEWS_API_KEY"],
    ["NEWS_API_KEY", "NEWS_API_KEY"],
    ["github token", "GITHUB_TOKEN"],
    ["  ", ""],
    ["2captcha", "KEY_2CAPTCHA_API_KEY"],
  ])("%p → %p", (name, env) => expect(envVarFor(name)).toBe(env));
});

describe("codex shell env for vault keys", () => {
  test("keys are set explicitly (codex strips *KEY* vars from shells by default)", () => {
    const toml = vaultShellEnvToml({ NEWS_API_KEY: 'a"b', OPENTRADE_KEYS: "NEWS_API_KEY" });
    expect(toml).toContain("[shell_environment_policy.set]");
    expect(toml).toContain('NEWS_API_KEY = "a\\"b"');
    expect(vaultShellEnvToml({})).toBe("");
  });
});
