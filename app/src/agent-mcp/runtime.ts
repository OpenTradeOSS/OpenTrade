// Shared runtime for the agent-facing stdio MCP servers (`opentrade`, `kalshi`): host
// endpoint discovery, the authenticated call into the host's LocalApi, and a minimal
// newline-delimited JSON-RPC 2.0 stdio loop.
//
// Intentionally dependency-free (node builtins only): these servers are spawned by the
// agent CLIs (interactive PTYs and headless wake runs alike) as ELECTRON_RUN_AS_NODE
// children, and a self-contained bundle avoids asar/externalize resolution fragility in
// a packaged app.
//
// Secrets are NOT baked into the MCP configs; they arrive via the inherited spawn env
// (claude passes its PTY env to MCP children) or, under codex's cleaned env, the host
// manifest: OPENTRADE_PORT / OPENTRADE_TOKEN / OPENTRADE_AGENT_ID.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_HOME_DIRNAME } from "@shared/app-identity";

export const AGENT_ID = process.env.OPENTRADE_AGENT_ID;
const DEFAULT_PROTOCOL = "2024-11-05";

/**
 * Resolve the host endpoint. Claude inherits OPENTRADE_PORT/TOKEN from the PTY
 * env; codex spawns MCP children with a CLEANED env, so those are absent — fall
 * back to the host manifest (`$OPENTRADE_HOME/host.json`, the same discovery
 * contract the launcher uses; port + token are stable). Read per call so a host
 * restart's fresh manifest is picked up.
 */
function backendEndpoint(): { port: string; token: string } | null {
  const port = process.env.OPENTRADE_PORT;
  const token = process.env.OPENTRADE_TOKEN;
  if (port && token) return { port, token };
  const home = process.env.OPENTRADE_HOME ?? join(homedir(), APP_HOME_DIRNAME);
  try {
    const m = JSON.parse(readFileSync(join(home, "host.json"), "utf8")) as {
      faucetPort?: number;
      token?: string;
    };
    if (m.faucetPort && m.token) return { port: String(m.faucetPort), token: m.token };
  } catch {
    // no manifest → host not running
  }
  return null;
}

/** Call the host LocalApi with the agent's auth headers. */
export function callHost(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const endpoint = backendEndpoint();
    if (!endpoint || !AGENT_ID) {
      return reject(
        new Error("OpenTrade backend unreachable (no env endpoint and no host manifest)"),
      );
    }
    const { port: PORT, token: TOKEN } = endpoint;
    const payload = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(PORT),
        path,
        method,
        headers: {
          "content-type": "application/json",
          "x-opentrade-token": TOKEN,
          "x-opentrade-agent": AGENT_ID,
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function describeError(json: unknown): string {
  if (json && typeof json === "object" && "error" in json)
    return String((json as { error: unknown }).error);
  return typeof json === "string" ? json : JSON.stringify(json);
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export function send(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

export interface StdioServer {
  serverInfo: { name: string; version: string };
  instructions: string;
  capabilities: Record<string, unknown>;
  tools: ToolDef[];
  /** `notifications/initialized` — the session is live. */
  onInitialized?: () => void;
}

/** Serve `server` over newline-delimited JSON-RPC on stdio until stdin closes. */
export function serveStdio(server: StdioServer): void {
  const byName = new Map(server.tools.map((t) => [t.name, t]));
  const reply = (id: JsonRpcMessage["id"], result: unknown) => send({ id, result });
  const replyError = (id: JsonRpcMessage["id"], code: number, message: string) =>
    send({ id, error: { code, message } });

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params } = msg;
    // Notifications (no id) need no response.
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize": {
        const clientProtocol = (params?.protocolVersion as string) || DEFAULT_PROTOCOL;
        reply(id, {
          protocolVersion: clientProtocol,
          capabilities: server.capabilities,
          serverInfo: server.serverInfo,
          instructions: server.instructions,
        });
        return;
      }
      case "notifications/initialized":
        server.onInitialized?.();
        return;
      case "notifications/cancelled":
        return; // no-op notification
      case "ping":
        if (!isNotification) reply(id, {});
        return;
      case "tools/list":
        reply(id, {
          tools: server.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      case "tools/call": {
        const name = String(params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return replyError(id, -32602, `unknown tool: ${name}`);
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        try {
          const text = await tool.run(args);
          reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          reply(id, {
            content: [
              { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          });
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
        return;
    }
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          void handle(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // ignore unparseable lines
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
