// OpenTrade agent-facing Kalshi MCP server (`kalshi`).
//
// Kalshi ships no MCP server of its own, so this one gives agents event-contract reads
// and writes. It is a thin stdio shim: every tool call is forwarded to the host's
// `POST /kalshi/call`, where the vault-held API key signs the request and order writes
// wait on the approval gate. This process never sees a Kalshi credential — nor does
// the agent's shell — so the only road to Kalshi runs through the gate.
//
// The tool table (names, schemas, read/write kind) is shared with the host:
// `@shared/kalshi-tools`. Dependency-free, like the `opentrade` server (./runtime.ts).

import { KALSHI_INSTRUCTIONS, KALSHI_TOOLS } from "@shared/kalshi-tools";
import { callHost, describeError, serveStdio, type ToolDef } from "./runtime";

/** Cap on text returned to the model; Kalshi list endpoints can be very large. */
const MAX_RESULT_CHARS = 60_000;

const tools: ToolDef[] = KALSHI_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  run: async (args) => {
    const { status, json } = await callHost("POST", "/kalshi/call", { tool: t.name, args });
    if (status !== 200) throw new Error(describeError(json));
    const r = json as { ok?: boolean; result?: unknown; error?: string } | null;
    if (!r?.ok) throw new Error(r?.error ?? "Kalshi call failed");
    const text = JSON.stringify(r.result ?? null, null, 2);
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated; narrow the query with filters or a smaller limit)`
      : text;
  },
}));

process.title = "OpenTrade Kalshi MCP";

serveStdio({
  serverInfo: { name: "kalshi", version: "0.1.0" },
  instructions: KALSHI_INSTRUCTIONS,
  capabilities: { tools: {} },
  tools,
});
