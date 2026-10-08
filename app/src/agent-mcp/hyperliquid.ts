// OpenTrade agent-facing Hyperliquid MCP server (`hyperliquid`).
//
// A thin stdio shim, like the `kalshi` server: every tool call is forwarded to the
// host's `POST /hyperliquid/call`, where the vault-held API wallet key signs the action
// and every write waits on the approval gate. This process never sees the key — nor
// does the agent's shell — so the only road to the account runs through the gate.
//
// The tool table (names, schemas, read/write kind) is shared with the host:
// `@shared/hyperliquid-tools`. Dependency-free, like the `opentrade` server (./runtime.ts).

import { HYPERLIQUID_INSTRUCTIONS, HYPERLIQUID_TOOLS } from "@shared/hyperliquid-tools";
import { callHost, describeError, serveStdio, type ToolDef } from "./runtime";

/** Cap on text returned to the model; market lists can be large. */
const MAX_RESULT_CHARS = 60_000;

const tools: ToolDef[] = HYPERLIQUID_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  run: async (args) => {
    const { status, json } = await callHost("POST", "/hyperliquid/call", { tool: t.name, args });
    if (status !== 200) throw new Error(describeError(json));
    const r = json as { ok?: boolean; result?: unknown; error?: string } | null;
    if (!r?.ok) throw new Error(r?.error ?? "Hyperliquid call failed");
    const text = JSON.stringify(r.result ?? null, null, 2);
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated; narrow the query with symbols or a smaller limit)`
      : text;
  },
}));

process.title = "OpenTrade Hyperliquid MCP";

serveStdio({
  serverInfo: { name: "hyperliquid", version: "0.1.0" },
  instructions: HYPERLIQUID_INSTRUCTIONS,
  capabilities: { tools: {} },
  tools,
});
