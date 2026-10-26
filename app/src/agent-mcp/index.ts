// OpenTrade agent-facing MCP server (`opentrade`).
//
// A tiny stdio JSON-RPC 2.0 server that gives each agent a durable
// cron/monitor surface mirroring Claude Code's native CronCreate/Monitor — but
// backed by OpenTrade's always-on backend scheduler, so schedules survive the GUI
// closing and the host restarting. The tools are a thin HTTP shim over the host's
// LocalApi `/schedules/*` routes.
//
// Intentionally dependency-free (node builtins only): this file is loaded in every
// agent `claude` session (interactive PTYs and headless `-p` wake runs alike), and
// being self-contained avoids asar/externalize resolution fragility in a packaged app.
//
// Secrets are NOT baked into `.mcp.json`; they arrive via the inherited spawn env
// (claude passes its PTY env to the MCP child): OPENTRADE_PORT / OPENTRADE_TOKEN /
// OPENTRADE_AGENT_ID.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_ID = process.env.OPENTRADE_AGENT_ID;

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
  const home = process.env.OPENTRADE_HOME ?? join(homedir(), ".opentrade");
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

const SERVER_INFO = { name: "opentrade", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2024-11-05";

// Channel mode is always on (it's the default — the server always advertises the
// claude/channel capability and runs the /wake-stream poll loop). Claude Code only
// registers the channel for an interactive PTY, which is launched with the
// `--dangerously-load-development-channels server:opentrade` flag; a headless `-p`
// wake run doesn't pass that flag, so its capability + poll loop are simply inert.
const CHANNEL_INSTRUCTIONS =
  'Scheduled wakes from OpenTrade arrive as <channel source="opentrade" ...> events. ' +
  "They are one-way: read the body as your next task, act on it (read STRATEGY.md first), " +
  "and continue. No reply to the channel is expected.";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Call the host LocalApi faucet (`/schedules/*`) with the agent's auth headers. */
function callHost(
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

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required };
}

const TOOLS: ToolDef[] = [
  {
    name: "CronCreate",
    description:
      "Schedule a recurring (or one-shot) wake for this agent on a cron timer. " +
      "Durable: it is owned by the OpenTrade backend and keeps firing even when the " +
      "desktop app is closed (unlike Claude Code's session-scoped CronCreate). When " +
      "it fires, you are woken with `prompt` as the task — read STRATEGY.md and act.",
    inputSchema: obj(
      {
        cron: {
          type: "string",
          description:
            "5-field cron expression in the machine's local timezone, e.g. '30 9 * * 1-5'.",
        },
        prompt: { type: "string", description: "The task to run when the schedule fires." },
        recurring: {
          type: "boolean",
          description: "Fire on every match (true, default) or just once (false).",
        },
        durable: {
          type: "boolean",
          description: "Accepted for compatibility with the native tool; always durable here.",
        },
      },
      ["cron", "prompt"],
    ),
    run: async (a) => {
      const { status, json } = await callHost("POST", "/schedules/cron", {
        cron: a.cron,
        prompt: a.prompt,
        recurring: a.recurring ?? true,
      });
      if (status !== 200) throw new Error(describeError(json));
      return `Created cron schedule ${(json as { id?: string }).id}.`;
    },
  },
  {
    name: "CronList",
    description: "List this agent's durable cron schedules.",
    inputSchema: obj({}),
    run: async () => {
      const { status, json } = await callHost("GET", "/schedules");
      if (status !== 200) throw new Error(describeError(json));
      return JSON.stringify((json as { cron?: unknown[] }).cron ?? [], null, 2);
    },
  },
  {
    name: "CronDelete",
    description: "Delete one of this agent's durable cron schedules by id.",
    inputSchema: obj({ id: { type: "string", description: "The schedule id from CronList." } }, [
      "id",
    ]),
    run: async (a) => {
      const { status, json } = await callHost(
        "DELETE",
        `/schedules/cron/${encodeURIComponent(String(a.id))}`,
      );
      if (status !== 200) throw new Error(describeError(json));
      return (json as { ok?: boolean }).ok ? "Deleted." : "No such schedule.";
    },
  },
  {
    name: "Monitor",
    description:
      "Start a durable signal monitor: a shell command supervised by the OpenTrade " +
      "backend whose every stdout line wakes this agent (rate-limited). Runs even " +
      "when the desktop app is closed. Use for price/threshold watch scripts.",
    inputSchema: obj(
      {
        command: { type: "string", description: "Shell command to run and supervise." },
        description: {
          type: "string",
          description: "Human-readable note about what this watches.",
        },
        persistent: {
          type: "boolean",
          description: "Accepted for native-tool compatibility; ignored.",
        },
        timeout_ms: {
          type: "number",
          description: "Accepted for native-tool compatibility; ignored.",
        },
      },
      ["command"],
    ),
    run: async (a) => {
      const { status, json } = await callHost("POST", "/schedules/monitor", {
        command: a.command,
        description: a.description,
      });
      if (status !== 200) throw new Error(describeError(json));
      return `Started monitor ${(json as { id?: string }).id}.`;
    },
  },
  {
    name: "MonitorList",
    description: "List this agent's durable signal monitors.",
    inputSchema: obj({}),
    run: async () => {
      const { status, json } = await callHost("GET", "/schedules");
      if (status !== 200) throw new Error(describeError(json));
      return JSON.stringify((json as { monitors?: unknown[] }).monitors ?? [], null, 2);
    },
  },
  {
    name: "MonitorStop",
    description: "Stop one of this agent's durable monitors by id.",
    inputSchema: obj({ id: { type: "string", description: "The monitor id from MonitorList." } }, [
      "id",
    ]),
    run: async (a) => {
      const { status, json } = await callHost(
        "DELETE",
        `/schedules/monitor/${encodeURIComponent(String(a.id))}`,
      );
      if (status !== 200) throw new Error(describeError(json));
      return (json as { ok?: boolean }).ok ? "Stopped." : "No such monitor.";
    },
  },
];

function describeError(json: unknown): string {
  if (json && typeof json === "object" && "error" in json)
    return String((json as { error: unknown }).error);
  return typeof json === "string" ? json : JSON.stringify(json);
}

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function send(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function reply(id: JsonRpcMessage["id"], result: unknown): void {
  send({ id, result });
}

function replyError(id: JsonRpcMessage["id"], code: number, message: string): void {
  send({ id, error: { code, message } });
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;
  // Notifications (no id) need no response.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const clientProtocol = (params?.protocolVersion as string) || DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion: clientProtocol,
        // The presence of `experimental["claude/channel"]` is what makes Claude Code
        // register a channel listener for this server (research preview).
        capabilities: { tools: {}, experimental: { "claude/channel": {} } },
        serverInfo: SERVER_INFO,
        instructions: CHANNEL_INSTRUCTIONS,
      });
      return;
    }
    case "notifications/initialized":
      // The session is live — start the warm-wake poll loop. Claude only: under a
      // codex harness there is no channel to push into (wakes arrive via the agent's
      // app-server, and a served poll here would silently EAT the wake), so the
      // poller stays off. The env flag rides the codex config's MCP entry.
      if (process.env.OPENTRADE_HARNESS !== "codex") startWakePoller();
      return;
    case "notifications/cancelled":
      return; // no-op notification
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = TOOL_BY_NAME.get(name);
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

// ---- channel warm-wake delivery (channel mode only) ----

/** Inject a scheduled wake into the live session as a `<channel source="opentrade">`. */
function pushChannel(content: string): void {
  send({
    method: "notifications/claude/channel",
    params: { content, meta: { source: "opentrade" } },
  });
}

let pollerStarted = false;

/**
 * Long-poll the host `GET /wake-stream`: each resolved wake is pushed into the live
 * session as a channel event. The host holds the request open until a wake is queued
 * for this agent (or a ~60s timeout → empty 200), so this loop mostly parks. On a
 * host error it backs off briefly and retries — the loop never exits while the
 * session lives.
 */
function startWakePoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (;;) {
      try {
        const { status, json } = await callHost("GET", "/wake-stream");
        const prompt = (json as { prompt?: string } | null)?.prompt;
        if (status === 200 && typeof prompt === "string" && prompt) pushChannel(prompt);
        // 200-with-no-prompt = the long-poll timed out cleanly → re-poll immediately.
      } catch {
        await sleep(2000); // host briefly unreachable → back off, then retry
      }
    }
  })();
}

// Name the process so it reads as OpenTrade in `ps`/`top` rather than the bare
// Electron/node executable (packaging: see docs/PACKAGING.md "Process naming").
process.title = "OpenTrade Agent MCP";

// ---- stdio transport: newline-delimited JSON-RPC ----
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
