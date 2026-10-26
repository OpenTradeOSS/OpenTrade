import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  Agent,
  AgentStatus,
  CreateAgentInput,
  ExecutionState,
  HarnessId,
} from "@shared/agent";
import { templateOf } from "@shared/analytics";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type Db, OPENTRADE_HOME } from "../../db/client";
import { agents as agentsTable } from "../../db/schema";
import { analytics } from "../analytics";
import { bus } from "../event-bus";
import { harnessFor } from "../harness";
import { resolveAgentMcp, resolveTemplatesDir } from "./paths";

const AGENTS_DIR = join(OPENTRADE_HOME, "agents");

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * A template's specialty section — the template's own `CLAUDE.md` (strategy
 * persona, journaling layout, operating principles). This is the *editable* part
 * the New Agent dialog shows; the shared prefix is NOT included. Unknown templates
 * fall back to `default`.
 */
function readTemplateSpecialty(templatesDir: string, template: string): string {
  const templateDir = join(templatesDir, template);
  const src = existsSync(templateDir) ? templateDir : join(templatesDir, "default");
  const claudePath = join(src, "CLAUDE.md");
  return existsSync(claudePath) ? readFileSync(claudePath, "utf8").trim() : "";
}

/**
 * Compose an agent's instructions file = the harness's shared OpenTrade prefix +
 * the given specialty section. The prefix (`templates/agents/CLAUDE.prefix.md` /
 * `AGENTS.prefix.codex.md`) carries the system mechanics every strategy shares
 * (faucet, Robinhood MCP, approval gate, durable scheduler, wake delivery) and is
 * always prepended at scaffold time — it is never shown in or edited through the
 * New Agent dialog. Missing prefix is a hard error. Specialty sections are
 * harness-neutral by design, so one template serves every harness.
 */
function composeInstructions(templatesDir: string, prefixFile: string, specialty: string): string {
  const prefixPath = join(templatesDir, prefixFile);
  if (!existsSync(prefixPath)) {
    throw new Error(`shared instructions prefix not found: ${prefixPath}`);
  }
  const prefix = readFileSync(prefixPath, "utf8").trim();
  const s = specialty.trim();
  return s ? `${prefix}\n\n${s}\n` : `${prefix}\n`;
}

/**
 * Owns the agents table and the on-disk agent folders under ~/.opentrade/agents.
 * Each agent folder is scaffolded from a template (CLAUDE.md, kickoff.md,
 * .claude/settings.json, .mcp.json); everything else in it is the agent's own
 * work product. Runtime `status` is mirrored into the DB and broadcast on change.
 */
export class AgentRegistry {
  /**
   * Runtime execution state per agent (PTY liveness — a host-side fact, not
   * persisted). Defaults to `offline`; merged into every Agent the registry hands
   * out so the renderer's agent subscription drives the terminal-pane overlays.
   */
  private executionStates = new Map<string, ExecutionState>();

  constructor(private db: Db) {
    if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
  }

  list(): Agent[] {
    return this.db
      .select()
      .from(agentsTable)
      .all()
      .map((r) => rowToAgent(r, this.executionStateOf(r.id), r.lastTurnAt))
      .filter((a) => a.archivedAt === null);
  }

  get(id: string): Agent | undefined {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    if (!row) return undefined;
    return rowToAgent(row, this.executionStateOf(id), row.lastTurnAt);
  }

  /**
   * Record that the agent just did something: its turn ended (both harnesses' Stop
   * hook, §6.7), or a background wake fired for it (the coordinator — a turn that
   * dies mid-flight still leaves its start stamp). `last_turn_at` is the SINGLE
   * source of `lastActiveAt`; deliberately NOT called for a user message — "last
   * active" tracks the agent, not the person. Null until the agent's first turn
   * after the column shipped (v5): the tray just omits the time part.
   *
   * Persisted, not in-memory: a host restart would otherwise wipe it and snap every
   * agent back to its last wake/audit time — and an app update forces a host restart
   * by design (`ensureHost` retires a version-mismatched host, §14).
   *
   * Broadcasts on its own: the status hook that calls this only produces an
   * `agents:changed` when the arbiter's *winner* changes, and a turn ending with no
   * status change (the common interactive case) would otherwise leave the tray showing
   * a stale time until something unrelated moved.
   */
  markAgentTurn(id: string): void {
    this.db.update(agentsTable).set({ lastTurnAt: Date.now() }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
  }

  executionStateOf(id: string): ExecutionState {
    return this.executionStates.get(id) ?? "offline";
  }

  /** Set the runtime execution state; broadcasts the agent list on a real change.
   *  Written exclusively by the WakeCoordinator (the agent's wake actor) and the
   *  boot-time spawn-marker reconcile — it IS the actor's state, 1:1. */
  setExecutionState(id: string, state: ExecutionState): void {
    if (this.executionStateOf(id) === state) return;
    if (state === "offline") this.executionStates.delete(id);
    else this.executionStates.set(id, state);
    this.broadcast();
  }

  agentDir(agent: Agent | { slug: string }): string {
    return join(AGENTS_DIR, agent.slug);
  }

  create(input: CreateAgentInput): Agent {
    const id = nanoid();
    const existing = new Set(
      this.db
        .select()
        .from(agentsTable)
        .all()
        .map((r) => r.slug),
    );
    let slug = slugify(input.name) || "agent";
    if (existing.has(slug)) {
      let i = 2;
      while (existing.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }

    this.scaffoldFolder(slug, input.template, input.harness, id, input.claudeMd);

    const now = Date.now();
    this.db
      .insert(agentsTable)
      .values({
        id,
        slug,
        name: input.name,
        template: input.template,
        harness: input.harness,
        approvalMode: input.approvalMode,
        lastSessionId: null,
        status: "idle",
        createdAt: now,
        archivedAt: null,
      })
      .run();
    this.broadcast();
    analytics.track("agent_created", {
      template: templateOf(input.template),
      harness: input.harness,
      approval_mode: input.approvalMode,
    });
    return this.get(id)!;
  }

  private scaffoldFolder(
    slug: string,
    template: string,
    harnessId: HarnessId,
    agentId: string,
    claudeMd?: string,
  ) {
    const dir = join(AGENTS_DIR, slug);
    const harness = harnessFor(harnessId);
    const templatesDir = resolveTemplatesDir();
    const templateDir = join(templatesDir, template);
    const src = existsSync(templateDir) ? templateDir : join(templatesDir, "default");
    if (!existsSync(src)) {
      throw new Error(`agent template not found: ${src}`);
    }
    mkdirSync(dir, { recursive: true });
    // Templates are claude-shaped; a non-claude harness generates its own config
    // (harness.writeConfig below), so the claude-specific files are skipped.
    const claudeOnly = harnessId !== "claude";
    cpSync(src, dir, {
      recursive: true,
      // Match against the path RELATIVE to the template root, not the absolute source:
      // an absolute path can itself contain a `/.claude` segment (this repo lives under
      // `.claude/worktrees/`), which would wrongly filter out EVERY template file and
      // leave a codex agent with no kickoff.md (B3). `src` itself always passes (rel = "").
      filter: (source) => {
        if (!claudeOnly) return true;
        const rel = relative(src, source);
        if (rel === "") return true;
        // Skip claude-only artifacts AND the template's top-level CLAUDE.md — its text
        // is consumed as the specialty source (readTemplateSpecialty) and re-emitted as
        // the harness's own instructions file (AGENTS.md for codex), so copying it
        // verbatim would leave a stray CLAUDE.md the agent doesn't own.
        return !(
          rel.split(sep).includes(".claude") ||
          rel.endsWith(".mcp.json") ||
          rel === "CLAUDE.md"
        );
      },
    });
    mkdirSync(join(dir, ".opentrade"), { recursive: true });
    mkdirSync(join(dir, "journal"), { recursive: true });

    // The agent's instructions file = the harness's shared prefix + a specialty
    // section. The specialty is the (possibly edited) text from the New Agent
    // dialog, falling back to the template's own CLAUDE.md. The prefix is always
    // prepended here — it is never shown in or edited through the dialog.
    const specialty = claudeMd?.trim() ? claudeMd : readTemplateSpecialty(templatesDir, template);
    writeFileSync(
      join(dir, harness.instructionsFile),
      composeInstructions(templatesDir, harness.instructionsPrefixFile, specialty),
    );

    if (harness.generatesFullConfig) {
      // Harness generates its COMPLETE config (codex: config.toml + hooks + auth link);
      // the claude-style .mcp.json / hook steps below don't apply.
      harness.writeConfig?.(dir, agentId);
      return;
    }

    // Claude-style scaffold: the template's Robinhood `.mcp.json` (+ the opentrade MCP),
    // then the harness's generated config — for claude that's `.claude/settings.json`
    // (the order-gate hook wiring, generated in code so it survives clean CI builds) and
    // the hook scripts.
    this.injectOpentradeMcp(dir);
    harness.writeConfig?.(dir, agentId);
  }

  /**
   * A template's editable specialty section (its own `CLAUDE.md`, WITHOUT the
   * shared prefix). Seeds the New Agent dialog's text field; the dialog passes the
   * (possibly edited) result back as `CreateAgentInput.claudeMd`, and `create`
   * re-prepends the prefix. Returns the specialty only — never the prefix.
   */
  templateClaudeMd(template: string): string {
    return readTemplateSpecialty(resolveTemplatesDir(), template);
  }

  /**
   * Add the `opentrade` stdio MCP server to the agent's `.mcp.json` (alongside the
   * template's Robinhood entry). Carries only the command + resolved binary path —
   * NO token/port (R5); those are injected via the inherited spawn env at launch.
   * Run as Node via the Electron binary (ELECTRON_RUN_AS_NODE) so packaged apps need
   * no separate node on PATH.
   */
  private injectOpentradeMcp(dir: string): void {
    const mcpPath = join(dir, ".mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpPath)) {
      try {
        config = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        config = {};
      }
    }
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      opentrade: {
        command: process.execPath,
        args: [resolveAgentMcp()],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Mutate editable fields (name, approval mode, turn-limit toggle). Returns the updated agent. */
  update(
    id: string,
    patch: { name?: string; approvalMode?: Agent["approvalMode"]; turnLimitEnabled?: boolean },
  ): Agent | undefined {
    const set: Partial<typeof agentsTable.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.approvalMode !== undefined) set.approvalMode = patch.approvalMode;
    if (patch.turnLimitEnabled !== undefined) set.turnLimitEnabled = patch.turnLimitEnabled;
    if (Object.keys(set).length > 0) {
      this.db.update(agentsTable).set(set).where(eq(agentsTable.id, id)).run();
      this.broadcast();
    }
    return this.get(id);
  }

  /**
   * Count one headless wake run against the agent's turn budget. Returns the new
   * count (0 for an unknown agent). Broadcast so the GUI's turns-left button is live.
   */
  incrementHeadlessTurns(id: string): number {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    if (!row) return 0;
    const next = row.headlessTurnsUsed + 1;
    this.db
      .update(agentsTable)
      .set({ headlessTurnsUsed: next })
      .where(eq(agentsTable.id, id))
      .run();
    this.broadcast();
    return next;
  }

  /**
   * Zero the agent's headless turn budget. The ONLY refill path: the turn-limit button's
   * Reset control on the agent view (`agents.resetTurnLimit`) — the budget does
   * not reset on viewing, restart, or any other implicit signal.
   */
  resetHeadlessTurns(id: string): void {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    if (!row || row.headlessTurnsUsed === 0) return;
    this.db.update(agentsTable).set({ headlessTurnsUsed: 0 }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
  }

  /**
   * Clean-slate every agent's turn-limit state: zero all counts AND turn the per-agent
   * limit back on for everyone. Called when the global turn-limit feature is re-enabled
   * (Settings `headlessTurnLimitEnabled` off → on) so re-enabling is a fresh start rather
   * than instantly pausing agents on stale counts — this deliberately overrides any
   * per-agent opt-out (a per-agent "off" does not survive a global toggle cycle).
   */
  resetAllTurnBudgets(): void {
    this.db.update(agentsTable).set({ headlessTurnsUsed: 0, turnLimitEnabled: true }).run();
    this.broadcast();
  }

  archive(id: string): void {
    this.db.update(agentsTable).set({ archivedAt: Date.now() }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
    bus.emitEvent("agent:archived", { agentId: id });
    analytics.track("agent_archived");
  }

  setStatus(id: string, status: AgentStatus): void {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    if (!row || row.status === status) return;
    this.db.update(agentsTable).set({ status }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
  }

  setLastSessionId(id: string, sessionId: string): void {
    this.db
      .update(agentsTable)
      .set({ lastSessionId: sessionId })
      .where(eq(agentsTable.id, id))
      .run();
  }

  // ---- on-disk session-state helpers ----

  hasStarted(id: string): boolean {
    const agent = this.get(id);
    if (!agent) return false;
    return existsSync(join(this.agentDir(agent), ".opentrade", "started"));
  }

  markStarted(id: string): void {
    const agent = this.get(id);
    if (!agent) return;
    const marker = join(this.agentDir(agent), ".opentrade", "started");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, String(Date.now()));
  }

  readKickoff(agent: Agent): string | null {
    const path = join(this.agentDir(agent), "kickoff.md");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  }

  /** On boot, no daemon sessions are confirmed yet — reset stale statuses to idle. */
  resetStatusesOnBoot(): void {
    for (const a of this.list()) {
      if (a.status !== "idle") this.setStatus(a.id, "idle");
    }
  }

  private broadcast() {
    bus.emitEvent("agents:changed", this.list());
  }
}

function rowToAgent(
  row: typeof agentsTable.$inferSelect,
  executionState: ExecutionState,
  lastActiveAt: number | null,
): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    template: row.template,
    harness: row.harness as Agent["harness"],
    approvalMode: row.approvalMode as Agent["approvalMode"],
    lastSessionId: row.lastSessionId,
    status: row.status as Agent["status"],
    executionState,
    lastActiveAt,
    headlessTurnsUsed: row.headlessTurnsUsed,
    turnLimitEnabled: row.turnLimitEnabled,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}
