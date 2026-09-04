import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Agent } from "@shared/agent";
import { GATED_TOOL_MATCHER, GATED_TOOLS } from "@shared/robinhood-tools";
import { OPENTRADE_HOME } from "../../db/client";
import { hostLog } from "../../host/log";
import { resolveAgentMcp, resolveHooksDir } from "../agents/paths";
import { bus } from "../event-bus";
import { type CodexAppServerManager, codexHomeFor } from "./codex-app-server";
import { hookCommand } from "./hook-command";
import { codexConfigHasRobinhood, ROBINHOOD_MCP_URL } from "./robinhood-mcp";
import type { Harness, ProbeResult, SessionMode } from "./types";

const execFileAsync = promisify(execFile);

/** Env keys stripped from a codex background run when subscription auth is enforced
 *  (single source — referenced by both the harness field and the server-env builder
 *  in host wiring). */
export const CODEX_SUBSCRIPTION_AUTH_STRIP = ["OPENAI_API_KEY"] as const;

/** Overridable for dev machines where `codex` on PATH is a wrapper that injects
 *  `-c` overrides (which silently break the TUI's LocalDaemon auto-attach). */
const CODEX_BIN = process.env.OPENTRADE_CODEX_BIN ?? "codex";

/** Thread-adoption poll cadence: the TUI creates its thread within a few seconds
 *  of boot; ~30s covers slow cold starts before we declare the session split. */
const ADOPT_POLL_MS = 1_000;
const ADOPT_TRIES = 30;

/**
 * Surface the "session split" failure — the TUI is running on a DIFFERENT engine
 * than our app-server, so its conversation is real to the user but unreachable by
 * wakes. This is the exact failure the whole architecture exists to prevent, so it
 * gets more than a log line: a loud error AND a user-facing `restricted`
 * notification (the agent's autonomy is effectively disabled until relaunched with
 * a clean `codex`). Common cause: `codex` on PATH is a wrapper injecting `-c` flags.
 */
function surfaceSessionSplit(agent: Agent, detail: string): void {
  hostLog.error(
    `codex session split: ${detail} — wakes cannot reach this agent's live TUI ` +
      "(is `codex` a wrapper injecting -c? set OPENTRADE_CODEX_BIN to the real binary)",
    agent.id,
  );
  bus.emitEvent("notify", {
    kind: "restricted",
    title: `${agent.name} — Session not reachable`,
    body: "Its terminal isn't on OpenTrade's engine, so scheduled wakes won't run. Restart the agent.",
    agentId: agent.id,
  });
}

/**
 * Codex (OpenAI) as an agent harness. The engine is a per-agent supervised
 * `codex app-server` (see CodexAppServerManager); the PTY runs the stock TUI,
 * which auto-attaches to that server via the control socket under the agent's
 * `CODEX_HOME` (a short per-agent dir — see `codexHomeFor`). Conversation identity:
 * a first/fresh interactive launch is a BARE `codex` — the TUI creates its own
 * thread on our server and `adoptInteractiveSession` discovers + persists its id
 * (then delivers the kickoff as its first turn, rendered live). Resumes launch as
 * `codex resume <threadId>`. Headless-first threads are backend-created
 * (CodexHeadlessStrategy) — their first turn writes the rollout, so a later TUI
 * resume works. Argv stays CLEAN in all modes — any `-c`/`--profile` override
 * silently drops the TUI into its embedded engine, splitting the session.
 *
 * The order gate is layered fail-closed (spike-verified):
 *  - anchor: `approval_mode = "prompt"` on every money-moving tool (the
 *    `@shared/robinhood-tools` table) in the generated config.toml — codex core
 *    raises an elicitation the backend answers through
 *    ApprovalService; no answer / client error / disconnect = Decline.
 *    (`"approve"` means PRE-approved in codex — never use it for order tools.)
 *  - redundancy: the same approval PreToolUse hook as claude (codex
 *    accepts the identical deny JSON); hooks require trust, pre-established via
 *    a `hooks.state` batchWrite at server start.
 * `writeConfig` re-runs before every spawn, healing any tampering.
 */
export function createCodexHarness(manager: CodexAppServerManager): Harness {
  return {
    id: "codex",
    binary: CODEX_BIN,
    instructionsFile: "AGENTS.md",
    instructionsPrefixFile: "AGENTS.prefix.codex.md",
    // Background runs bill the user's ChatGPT subscription login, not a stray key.
    subscriptionAuthStrip: CODEX_SUBSCRIPTION_AUTH_STRIP,
    // writeConfig below emits the entire `.codex` config, so the scaffold skips the
    // claude-style `.mcp.json`/hook steps for codex.
    generatesFullConfig: true,

    interactiveArgs(mode: SessionMode, sessionId: string): string[] {
      // `start` is a BARE launch: the TUI creates its own thread on our server
      // (the normal codex startup path) and the backend adopts its id afterwards
      // (`adoptInteractiveSession`). We deliberately do NOT pre-create + resume:
      // codex only writes a thread's rollout file when its first turn runs, and
      // the TUI's resume bootstrap requires that file — resuming a turnless
      // thread crashes with "no rollout found". NO other flags in either mode —
      // argv config overrides break LocalDaemon auto-attach (Embedded fallback
      // would split the user's session from the wake engine).
      return mode === "resume" ? ["resume", sessionId] : [];
    },

    interactiveEnv(ctx: { agentDir: string }): Record<string, string> {
      // The TUI must resolve the same CODEX_HOME as the server: config, sessions,
      // and — critically — the control socket its auto-attach probe looks for.
      // A short out-of-agent-dir home (see codexHomeFor) keeps the socket path
      // under the unix SUN_LEN limit.
      return { CODEX_HOME: codexHomeFor(basename(ctx.agentDir)) };
    },

    async prepareInteractive(agent: Agent, agentDir: string): Promise<void> {
      // The server MUST be listening before the TUI boots: its LocalDaemon
      // auto-attach probes the control socket exactly once at startup, and a
      // miss silently drops it into the embedded engine (session split —
      // E2E-caught). Applies to resumes too, not just first runs.
      await manager.ensureServer(agent.id, codexHomeFor(basename(agentDir)));
    },

    adoptInteractiveSession(
      agent: Agent,
      agentDir: string,
      kickoff: string | null,
      persist: (sessionId: string) => void,
    ): void {
      // A bare-`codex` start just launched: the TUI is creating its own thread on
      // the agent's server. Discover it (a NEW id in thread/loaded/list, i.e. not
      // the pre-spawn lastSessionId), persist it as the resumable conversation,
      // and deliver the kickoff as its first turn — rendered live in the TUI.
      const codexHome = codexHomeFor(basename(agentDir));
      // Codex thread ids are UUIDv7 (millisecond-timestamp-prefixed, monotonic by
      // creation), so the thread the TUI just created is the LEXICOGRAPHICALLY GREATEST
      // loaded id. Adopting `max(id)` — rather than "any id != previous" — is robust to
      // the ~30-min server-side thread lingering + repeated Restarts: a stale thread A
      // and a just-created C both appear in `loaded`, but C > A always, so we never
      // adopt a dead conversation while the user chats in the live one (B4). The
      // `> previous` guard means we wait for a genuinely NEW thread before adopting.
      const previous = agent.lastSessionId ?? "";
      void (async () => {
        for (let i = 0; i < ADOPT_TRIES; i++) {
          await new Promise((r) => setTimeout(r, ADOPT_POLL_MS));
          let loaded: string[];
          try {
            loaded = await manager.loadedThreads(agent.id, codexHome);
          } catch (err) {
            hostLog.warn("codex thread adoption poll failed", agent.id, String(err));
            continue;
          }
          const fresh = loaded
            .filter((id) => id > previous)
            .sort()
            .at(-1);
          if (!fresh) continue;
          persist(fresh);
          if (kickoff) {
            manager
              .runTurn(agent.id, codexHome, fresh, kickoff)
              .catch((err) => hostLog.warn("codex kickoff turn failed", agent.id, String(err)));
          }
          return;
        }
        // Likely an Embedded-fallback TUI (e.g. a wrapper `codex` injecting -c
        // overrides): the user is chatting with a thread our wakes can't reach.
        surfaceSessionSplit(agent, "the TUI thread never appeared on the app-server");
      })();
    },

    verifyResumedSession(agent: Agent, agentDir: string, sessionId: string): void {
      // A `codex resume <id>` launch auto-attaches to our server; if it instead fell
      // back to the embedded engine, our thread won't be loaded there. Poll for it (the
      // same ~30s window as adoption) and surface a split if it never appears (E4). The
      // start path is covered by adoptInteractiveSession's own timeout.
      const codexHome = codexHomeFor(basename(agentDir));
      void (async () => {
        for (let i = 0; i < ADOPT_TRIES; i++) {
          await new Promise((r) => setTimeout(r, ADOPT_POLL_MS));
          try {
            if (await manager.isThreadLoaded(agent.id, codexHome, sessionId)) return; // attached ✓
          } catch (err) {
            hostLog.warn("codex resume verify poll failed", agent.id, String(err));
          }
        }
        surfaceSessionSplit(agent, `resumed thread ${sessionId} never loaded on the app-server`);
      })();
    },

    // No headlessArgs: codex wakes run as app-server turns (CodexHeadlessStrategy),
    // never as a CLI child — the interface method is optional and left undefined.

    writeConfig(agentDir: string, agentId: string): void {
      const codexHome = codexHomeFor(basename(agentDir));
      const hooksDir = join(codexHome, "hooks");
      mkdirSync(hooksDir, { recursive: true });

      // Auth: share the user's codex login. A symlink keeps refreshed tokens in
      // sync both ways (codex rewrites auth.json in place on refresh).
      const userAuth = join(homedir(), ".codex", "auth.json");
      const agentAuth = join(codexHome, "auth.json");
      if (existsSync(userAuth)) {
        try {
          if (!lstatSync2(agentAuth)) symlinkSync(userAuth, agentAuth);
        } catch (err) {
          // Windows symlinks may require Developer Mode or elevation. A refreshed
          // copy on every launch still gives the agent the user's current login.
          try {
            copyFileSync(userAuth, agentAuth);
          } catch (copyErr) {
            hostLog.warn(
              "codex auth link/copy failed (agent may need `codex login`)",
              String(err),
              String(copyErr),
            );
          }
        }
        if (process.platform === "win32") {
          try {
            if (!lstatSync(agentAuth).isSymbolicLink()) copyFileSync(userAuth, agentAuth);
          } catch {
            // handled above on first creation; best effort on refresh
          }
        }
      }

      // Gate runner (shared with the claude scaffold — it forwards the
      // payload to the local gate endpoints).
      const hooksSrc = resolveHooksDir();
      if (existsSync(hooksSrc)) {
        for (const file of readdirSync(hooksSrc)) {
          const dest = join(hooksDir, file);
          copyFileSync(join(hooksSrc, file), dest);
          try {
            chmodSync(dest, 0o755);
          } catch {
            // best effort
          }
        }
      }

      // hooks.json — the claude-compatible format codex reads from CODEX_HOME
      // (which is OUTSIDE the agent dir; the agent only sees its effects).
      // PreToolUse = the redundant gate layer; PostToolUse = order-outcome capture;
      // Stop = the turn-ended stamp (→ `last_turn_at`, §6.7 — codex has no
      // Notification event, so Stop is its only status hook). Hooks execute on
      // BOTH transports: the supervised app-server runs turns (and hooks) for
      // background wakes and the TUI's threads alike.
      // Hook commands are shell strings; codex runs hooks with a CLEANED env, so
      // the non-secret identifiers ride the command itself and the runner
      // recover port/token from the host manifest ($OPENTRADE_HOME/host.json).
      const hooks = {
        hooks: {
          PreToolUse: [
            {
              matcher: GATED_TOOL_MATCHER,
              hooks: [
                {
                  type: "command",
                  command: hookCommand(hooksDir, "approval", agentId, OPENTRADE_HOME),
                  timeout: 600,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: GATED_TOOL_MATCHER,
              hooks: [
                {
                  type: "command",
                  command: hookCommand(hooksDir, "order-result", agentId, OPENTRADE_HOME),
                  timeout: 30,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: hookCommand(hooksDir, "status", agentId, OPENTRADE_HOME),
                  timeout: 10,
                },
              ],
            },
          ],
        },
      };
      writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);

      // The manager trusts our generated hooks by batch-writing `hooks.state`
      // entries into this config.toml; a blind rewrite would WIPE that trust and
      // resurface codex's hook-review UI on every launch. The hook files are
      // byte-identical across rewrites (same hash), so carrying the entries
      // forward keeps them valid.
      const configPath = join(codexHome, "config.toml");
      let hooksState = "";
      if (existsSync(configPath)) {
        const prior = readFileSync(configPath, "utf8");
        const m = prior.match(/(?:^\[hooks\.state\.[^\n]*\]\ntrusted_hash = "[^"]+"\n?)+/m);
        if (m) hooksState = `\n${m[0].trim()}\n`;
      }

      // config.toml — rewritten whole on every spawn (self-healing). Notes:
      //  - per-tool "prompt" = ALWAYS ask (the fail-closed anchor); the server-level
      //    default "approve" = pre-approved, mirroring claude's read-tool allowlist +
      //    skip-permissions headless parity for non-order tools.
      //  - the opentrade MCP entry carries NO secrets: port/token arrive via the
      //    server's inherited env (buildAgentEnv at server spawn).
      //  - project trust suppresses the first-run "do you trust this directory?"
      //    TUI prompt (spike-verified).
      // Codex canonicalizes the workspace path before matching project trust
      // (macOS: /var → /private/var), so the trust key must be the realpath or
      // the TUI stalls on the "do you trust this directory?" prompt (E2E-caught).
      let trustedDir = agentDir;
      try {
        trustedDir = realpathSync(agentDir);
      } catch {
        // keep the raw path
      }
      const config = `# Generated by OpenTrade — DO NOT EDIT. Rewritten on every agent launch.

approval_policy = "on-request"
sandbox_mode = "workspace-write"

# network_access is DELIBERATELY false (F2): the app-server control socket lives at
# $CODEX_HOME/app-server-control and codex's seatbelt gates unix-socket connects via the
# network-outbound rule (path-independent). With network on, the model's sandboxed shell
# tool can connect to that socket as a FULL app-server client and self-approve its own
# order elicitations (or config/batchWrite the gate off) — defeating the human order gate.
# Turning it off blocks that (spike-verified: connect → EPERM) at the cost of the agent's
# SHELL web access only. Hooks + MCP run UNSANDBOXED (server-spawned), so the gate hook's
# localhost curl and Robinhood/opentrade MCP are unaffected. See ARCHITECTURE §6.9.
[sandbox_workspace_write]
network_access = false

[projects.${tomlKey(trustedDir)}]
trust_level = "trusted"

[mcp_servers.robinhood]
url = "${ROBINHOOD_MCP_URL}"
default_tools_approval_mode = "approve"

${GATED_TOOLS.map((t) => `[mcp_servers.robinhood.tools.${t}]\napproval_mode = "prompt"`).join(
  "\n\n",
)}

[mcp_servers.opentrade]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(resolveAgentMcp())}]
default_tools_approval_mode = "approve"

[mcp_servers.opentrade.env]
ELECTRON_RUN_AS_NODE = "1"
OPENTRADE_HARNESS = "codex"
OPENTRADE_HOME = ${JSON.stringify(OPENTRADE_HOME)}
OPENTRADE_AGENT_ID = ${JSON.stringify(agentId)}
${hooksState}`;
      writeFileSync(configPath, config);
    },

    async probe(env: Record<string, string>): Promise<ProbeResult> {
      try {
        const { stdout } = await execFileAsync(CODEX_BIN, ["--version"], { env, timeout: 5000 });
        return { found: true, version: stdout.trim() };
      } catch {
        return { found: false, version: null };
      }
    },

    robinhoodMcpConfigured(): boolean {
      // The USER's `~/.codex/config.toml` — deliberately not a per-agent CODEX_HOME
      // (none exists during onboarding, and the question is about the user's own CLI).
      try {
        return codexConfigHasRobinhood(
          readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"),
        );
      } catch {
        // No config file yet (fresh codex install) — nothing registered.
        return false;
      }
    },
  };
}

/** lstat that answers "does anything exist at this path" (incl. a dangling link). */
function lstatSync2(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** TOML table-key form of an absolute path: quoted string key. */
function tomlKey(path: string): string {
  return JSON.stringify(path);
}
