import type { VaultTestResult } from "@shared/vault";

/** PMXT's hosted MCP — the exact endpoint agents use (see harness/integrations-config.ts). */
const PMXT_MCP = "https://api.pmxt.dev/mcp";

/**
 * Key Vault "Test" for PMXT: one `fetchMarkets` call over PMXT's hosted MCP with the
 * key — the same path agents take, so a pass means agents will work. (Deliberately not
 * the REST catalog `/v0/markets`: on 2026-09-30 it hung while the MCP path served
 * normally.) A bad key is a 401 `{"error":"missing api key"}`.
 */
export async function testPmxtKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VaultTestResult> {
  try {
    const res = await fetchImpl(PMXT_MCP, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fetchMarkets", arguments: { exchange: "kalshi", limit: 1 } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "PMXT rejected the key." };
    }
    if (!res.ok) return { ok: false, message: `PMXT returned HTTP ${res.status}.` };
    // The reply may be plain JSON or a single SSE `data:` frame.
    const json = parseRpc(text);
    if (json?.error || json?.result?.isError) {
      return { ok: false, message: `PMXT error: ${rpcErrorText(json)}` };
    }
    const title = firstTitle(json?.result?.content?.[0]?.text);
    return { ok: true, message: title ? `Connected. Sample market: "${title}".` : "Connected." };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach PMXT: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface RpcReply {
  error?: { message?: string };
  result?: { isError?: boolean; content?: { text?: string }[] };
}

function parseRpc(text: string): RpcReply | null {
  const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
  try {
    return JSON.parse(data) as RpcReply;
  } catch {
    return null;
  }
}

function rpcErrorText(r: RpcReply): string {
  return (r.error?.message ?? r.result?.content?.[0]?.text ?? "unknown").slice(0, 200);
}

function firstTitle(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const rows = JSON.parse(text) as { title?: string }[];
    return Array.isArray(rows) ? (rows[0]?.title ?? null) : null;
  } catch {
    return null;
  }
}
