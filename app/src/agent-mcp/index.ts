// OpenTrade agent-facing MCP server (`opentrade`).
//
// A tiny stdio JSON-RPC 2.0 server that gives each agent a durable
// cron/monitor surface mirroring Claude Code's native CronCreate/Monitor — but
// backed by OpenTrade's always-on backend scheduler, so schedules survive the GUI
// closing and the host restarting. The tools are a thin HTTP shim over the host's
// LocalApi `/schedules/*` routes.
//
// Dependency-free and secret-free — see ./runtime.ts (shared with the `kalshi` server).

import { callHost, describeError, send, serveStdio, type ToolDef } from "./runtime";

const SERVER_INFO = { name: "opentrade", version: "0.1.0" };

// Channel mode is always on (it's the default — the server always advertises the
// claude/channel capability and runs the /wake-stream poll loop). Claude Code only
// registers the channel for an interactive PTY, which is launched with the
// `--dangerously-load-development-channels server:opentrade` flag; a headless `-p`
// wake run doesn't pass that flag, so its capability + poll loop are simply inert.
const CHANNEL_INSTRUCTIONS =
  'Scheduled wakes from OpenTrade arrive as <channel source="opentrade" ...> events. ' +
  "They are one-way: read the body as your next task, act on it (read STRATEGY.md first), " +
  "and continue. No reply to the channel is expected.";

// The Key Vault's API keys reach the agent's shell as env vars; tell the agent which
// exist (names only — the values stay in the env). Set by the host at spawn.
const KEY_NAMES = (process.env.OPENTRADE_KEYS ?? "").split(",").filter(Boolean);
const KEYS_INSTRUCTIONS = KEY_NAMES.length
  ? ` API keys from the user's Key Vault are available in your shell as environment variables: ${KEY_NAMES.join(", ")}. Use them in scripts and requests (e.g. "$${KEY_NAMES[0]}"); never print, log, or write their values anywhere.`
  : "";

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

serveStdio({
  serverInfo: SERVER_INFO,
  instructions: CHANNEL_INSTRUCTIONS + KEYS_INSTRUCTIONS,
  // The presence of `experimental["claude/channel"]` is what makes Claude Code
  // register a channel listener for this server (research preview).
  capabilities: { tools: {}, experimental: { "claude/channel": {} } },
  tools: TOOLS,
  // The session is live — start the warm-wake poll loop. Claude only: under a
  // codex harness there is no channel to push into (wakes arrive via the agent's
  // app-server, and a served poll here would silently EAT the wake), so the
  // poller stays off. The env flag rides the codex config's MCP entry.
  onInitialized: () => {
    if (process.env.OPENTRADE_HARNESS !== "codex") startWakePoller();
  },
});
