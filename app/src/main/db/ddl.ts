/**
 * The CURRENT schema, as idempotent CREATE TABLE IF NOT EXISTS statements. Run on
 * every boot: a fresh DB gets the full latest schema in one shot; an existing DB
 * gets any tables added since it was created (IF NOT EXISTS covers whole-table
 * additions). Changes WITHIN an existing table (new columns, etc.) do NOT take
 * effect through this file — they must also ship as a migration in `migrate.ts`,
 * keyed by `PRAGMA user_version` (production DBs must survive updates). Keep the
 * two in sync: this DDL is what a fresh install gets, the migration is what an
 * existing install gets, and they must converge on the same shape.
 *
 * Dependency-free on purpose (a plain SQL string) so tests can build a real
 * schema without importing the better-sqlite3 client or touching OPENTRADE_HOME.
 */
export const SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT 'default',
      harness TEXT NOT NULL DEFAULT 'claude',
      approval_mode TEXT NOT NULL DEFAULT 'approve',
      last_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      headless_turns_used INTEGER NOT NULL DEFAULT 0,
      turn_limit_enabled INTEGER NOT NULL DEFAULT 1,
      last_turn_at INTEGER,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      parsed TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      note TEXT,
      outcome TEXT,
      requested_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_agent_at ON audit_log (agent_id, at);
    CREATE TABLE IF NOT EXISTS broker_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT,
      prompt TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_fire_at INTEGER,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_agent ON schedules (agent_id);
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitors_agent ON monitors (agent_id);
    CREATE TABLE IF NOT EXISTS wakes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      prompt TEXT NOT NULL,
      background INTEGER NOT NULL,
      fired_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wakes_agent_fired ON wakes (agent_id, fired_at);
    CREATE TABLE IF NOT EXISTS recent_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      agent_id TEXT,
      at INTEGER NOT NULL
    );
`;
