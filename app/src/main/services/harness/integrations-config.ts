import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PREALLOWED_TOOL_PATTERNS } from "@shared/robinhood-tools";
import { type AgentIntegrations, PMXT_KEY_ENV } from "@shared/vault";
import { resolveAgentMcp, resolveHyperliquidMcp, resolveKalshiMcp } from "../agents/paths";
import { ROBINHOOD_MCP_URL } from "./robinhood-mcp";

/**
 * What each optional integration contributes to an agent's CLI config, in one place so
 * the claude (`.mcp.json` + `.claude/settings.json`) and codex (`config.toml`) writers
 * can't drift. Both writers run before EVERY spawn, so flipping a switch in the Key
 * Vault takes effect on the agent's next launch.
 */

/** PMXT's hosted Streamable-HTTP MCP (unified prediction-market data). */
export const PMXT_MCP_URL = "https://api.pmxt.dev/mcp";

/**
 * PMXT tools that place/cancel orders or act on a wallet session. PMXT is wired in as
 * a read-only DATA provider (OpenTrade trades Kalshi through its own gated server, and
 * Polymarket is deliberately not a venue), so these are denied outright rather than
 * gated. Verified against the live `tools/list` on 2026-09-30.
 */
export const PMXT_DENIED_TOOLS = [
  "createOrder",
  "buildOrder",
  "submitOrder",
  "cancelOrder",
  "getAuthNonce",
  "loginWithSignature",
  "logout",
] as const;

/** Server names OpenTrade owns in an agent's `.mcp.json` (anything else is left alone). */
const MANAGED_SERVERS = ["robinhood", "kalshi", "hyperliquid", "pmxt", "opentrade"] as const;

/** Claude `.mcp.json` entries for the enabled integrations (+ the always-on `opentrade`). */
export function claudeMcpServers(on: AgentIntegrations): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  if (on.robinhood) servers.robinhood = { type: "http", url: ROBINHOOD_MCP_URL };
  if (on.kalshi) {
    servers.kalshi = {
      command: process.execPath,
      args: [resolveKalshiMcp()],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (on.hyperliquid) {
    servers.hyperliquid = {
      command: process.execPath,
      args: [resolveHyperliquidMcp()],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (on.pmxt) {
    // The key is NOT written here: Claude Code expands `${VAR}` in headers from the
    // env the agent is launched with (`buildAgentEnv` adds it from the vault), so the
    // secret never lands in the agent's folder.
    servers.pmxt = {
      type: "http",
      url: PMXT_MCP_URL,
      headers: { Authorization: `Bearer \${${PMXT_KEY_ENV}}` },
    };
  }
  // The `opentrade` stdio server (scheduling) — command + bundled path only; its
  // port/token arrive via the inherited spawn env. Run as Node via the Electron binary
  // (ELECTRON_RUN_AS_NODE) so packaged apps need no separate node on PATH.
  servers.opentrade = {
    command: process.execPath,
    args: [resolveAgentMcp()],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  return servers;
}

/**
 * (Re)write the agent's `.mcp.json`: OpenTrade-managed servers reflect the vault;
 * any server the user or agent added by hand is preserved.
 */
export function writeClaudeMcpJson(agentDir: string, on: AgentIntegrations): void {
  const mcpPath = join(agentDir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      config = {};
    }
  }
  const kept = Object.fromEntries(
    Object.entries(config.mcpServers ?? {}).filter(
      ([name]) => !(MANAGED_SERVERS as readonly string[]).includes(name),
    ),
  );
  config.mcpServers = { ...kept, ...claudeMcpServers(on) };
  writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** `.claude/settings.json` → `enabledMcpjsonServers` (pre-trusts our project servers). */
export function claudeEnabledServers(on: AgentIntegrations): string[] {
  return Object.keys(claudeMcpServers(on));
}

/**
 * `permissions.allow`. Robinhood's reads/cosmetic writes as before. Kalshi and
 * Hyperliquid are allowed whole: their money-movers are gated server-side in the host, so a
 * Claude permission prompt on top would only double-ask. PMXT reads are allowed; its
 * writes are denied (below).
 */
export function claudeAllow(on: AgentIntegrations): string[] {
  return [
    ...(on.robinhood ? PREALLOWED_TOOL_PATTERNS : []),
    "mcp__opentrade__*",
    ...(on.kalshi ? ["mcp__kalshi__*"] : []),
    ...(on.hyperliquid ? ["mcp__hyperliquid__*"] : []),
    ...(on.pmxt
      ? [
          "mcp__pmxt__fetch*",
          "mcp__pmxt__compareMarketPrices",
          "mcp__pmxt__getExecutionPrice*",
          "mcp__pmxt__loadMarkets",
          "mcp__pmxt__isSessionActive",
        ]
      : []),
  ];
}

export function claudeDeny(on: AgentIntegrations): string[] {
  return on.pmxt ? PMXT_DENIED_TOOLS.map((t) => `mcp__pmxt__${t}`) : [];
}
