import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Registry row per agent folder. Runtime `status` is a mirror, rewritten on boot. */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  template: text("template").notNull().default("default"),
  /** Which agent CLI runs this agent ("claude" | "codex"); fixed at creation. */
  harness: text("harness").notNull().default("claude"),
  approvalMode: text("approval_mode").notNull().default("approve"),
  lastSessionId: text("last_session_id"),
  status: text("status").notNull().default("idle"),
  /** Headless wake runs since the user last viewed this agent (reset on view). */
  headlessTurnsUsed: integer("headless_turns_used").notNull().default(0),
  /** Whether the global headless turn limit applies to this agent. */
  turnLimitEnabled: integer("turn_limit_enabled", { mode: "boolean" }).notNull().default(true),
  /** Last time the AGENT spoke — its turn ended, or it asked for input (§6.7 status
   *  hook). Feeds `Agent.lastActiveAt` (§12.6). Persisted rather than held in memory so
   *  it survives a host restart, which every app update forces. Null = never. */
  lastTurnAt: integer("last_turn_at"),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

/** One row per intercepted order tool call. */
export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  toolName: text("tool_name").notNull(),
  rawInput: text("raw_input").notNull(),
  parsed: text("parsed"),
  status: text("status").notNull().default("pending"),
  decidedBy: text("decided_by"),
  note: text("note"),
  /** Broker outcome JSON (OrderOutcome), filled in by the PostToolUse hook. */
  outcome: text("outcome"),
  requestedAt: integer("requested_at").notNull(),
  decidedAt: integer("decided_at"),
});

/** Append-only feed powering the Activity tab. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_agent_at").on(t.agentId, t.at)],
);

/** Pull-through cache entries (portfolio, positions, orders, quote:SYMBOL). */
export const brokerCache = sqliteTable("broker_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

/** Simple kv. oauth_tokens stored as safeStorage-encrypted blob. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Durable cron schedules owned by the backend (survive app close / host restart,
 * unlike Claude Code's session-scoped CronCreate). `next_fire_at` is advisory —
 * the scheduler recomputes it from `cron_expr` (in `timezone`) on boot rather than
 * trusting it. `timezone` (v6) is the machine's IANA zone when the row was created;
 * NULL only on pre-v6 rows until the scheduler backfills them at boot.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone"),
    prompt: text("prompt").notNull(),
    recurring: integer("recurring", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextFireAt: integer("next_fire_at"),
    lastFiredAt: integer("last_fired_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("schedules_agent").on(t.agentId)],
);

/**
 * Durable signal monitors: a supervised backend child whose stdout lines are
 * triggers (mirrors Claude Code's Monitor, but runs regardless of the GUI).
 */
export const monitors = sqliteTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    command: text("command").notNull(),
    description: text("description"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastFiredAt: integer("last_fired_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("monitors_agent").on(t.agentId)],
);

/**
 * Append-only record of every autonomy wake (a cron firing or a monitor trigger).
 * Distinct from the audit log: this is the Run History pane's own source, so wake
 * fires never get entangled with the trade-lifecycle feed. `schedules`/`monitors`
 * only carry a single `last_fired_at`; this keeps the full per-fire history.
 */
export const wakes = sqliteTable(
  "wakes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sourceKind: text("source_kind").notNull(), // "cron" | "monitor"
    /** Id of the originating schedule/monitor row, joined with `source_kind`. Lets a
     *  wake resolve its (possibly retired) timer's details for the history pane.
     *  Nullable: rows written before this column existed read NULL. */
    sourceId: text("source_id"),
    prompt: text("prompt").notNull(),
    /** True if delivered headlessly (no live interactive session); false if warm via the channel. */
    background: integer("background", { mode: "boolean" }).notNull(),
    firedAt: integer("fired_at").notNull(),
  },
  (t) => [index("wakes_agent_fired").on(t.agentId, t.firedAt)],
);

/**
 * Durable **ring buffer** of the last N notify events — deliberately NOT a
 * notification log: rows beyond the cap are pruned on every insert and gone for
 * good. Sole consumer is the tray's Recent submenu (§12.6), which needs the list to
 * survive launcher *and* host restarts. Ordered/pruned by the autoincrement `id`
 * (monotonic, never reused), so same-millisecond `at` ties can't misorder.
 */
export const recentNotifications = sqliteTable("recent_notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  agentId: text("agent_id"),
  at: integer("at").notNull(),
});
