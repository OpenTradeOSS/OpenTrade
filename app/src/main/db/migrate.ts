/**
 * Production schema migrations for the app DB, keyed by `PRAGMA user_version`.
 *
 * OpenTrade is shipped: existing databases MUST survive updates — never drop,
 * rebuild, or require users to delete `app.db`. The scheme:
 *
 *  - `SCHEMA_DDL` (ddl.ts) is always the CURRENT schema. Running it on boot gives
 *    a fresh install the latest shape and adds any whole tables an old DB is
 *    missing (`CREATE TABLE IF NOT EXISTS`).
 *  - Changes WITHIN an existing table ship here as a numbered migration. A fresh
 *    DB is stamped straight to `SCHEMA_VERSION` (its DDL is already current); an
 *    existing DB replays every migration above its stored version, each in its
 *    own transaction, bumping `user_version` as it goes.
 *  - Version 0 (what every pre-versioning production DB reports) is treated as
 *    the v0.1.x baseline — migrations start from there.
 *  - Migration steps are written to be idempotent (`addColumnIfMissing`), so a
 *    table that arrived at the current shape some other way (e.g. created whole
 *    by a newer DDL before the version stamp landed) never makes a replay throw.
 *  - Migrations are additive only: adding a column requires a DEFAULT so old rows
 *    stay valid, and nothing is ever dropped or rewritten destructively. If a
 *    truly destructive change is ever unavoidable, it must copy-and-backfill into
 *    a new table inside its migration step — never lose user data.
 *
 * Adding a migration: bump SCHEMA_VERSION, add the step to MIGRATIONS, and make
 * the same change in SCHEMA_DDL + schema.ts so fresh and migrated DBs converge.
 */

/** The minimal DB surface the runner needs — satisfied by better-sqlite3 in the
 *  app (see client.ts) and by bun:sqlite in tests. */
export interface MigrationDb {
  exec(sql: string): void;
  /** Run a rows-returning statement (SELECT / PRAGMA). */
  rows(sql: string): unknown[];
}

/** Bump on every schema change, with a matching entry in MIGRATIONS. */
export const SCHEMA_VERSION = 6;

const MIGRATIONS: Record<number, (db: MigrationDb) => void> = {
  // v2 — headless turn limit: per-agent unattended-turn counter + on/off toggle.
  2: (db) => {
    addColumnIfMissing(db, "agents", "headless_turns_used", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "agents", "turn_limit_enabled", "INTEGER NOT NULL DEFAULT 1");
  },
  // v3 — multi-harness: which agent CLI runs this agent (claude | codex).
  3: (db) => {
    addColumnIfMissing(db, "agents", "harness", "TEXT NOT NULL DEFAULT 'claude'");
  },
  // v4 — link each wake back to its originating cron/monitor (joined with
  // source_kind) so the history pane can show a retired timer's details.
  // Nullable: pre-v4 wakes read NULL rather than a bogus id.
  4: (db) => {
    addColumnIfMissing(db, "wakes", "source_id", "TEXT");
  },
  // v5 — when the agent last spoke, feeding the menu bar item's "last active"
  // (§12.6). Nullable: existing agents read NULL until their next turn, and fall
  // back to their wake/audit history in the meantime.
  5: (db) => {
    addColumnIfMissing(db, "agents", "last_turn_at", "INTEGER");
  },
  // v6 — the IANA timezone each cron expression is evaluated in (§12.2). Nullable:
  // pre-v6 rows read NULL until the scheduler backfills them on its next boot.
  6: (db) => {
    addColumnIfMissing(db, "schedules", "timezone", "TEXT");
  },
};

export function userVersion(db: MigrationDb): number {
  const row = db.rows("PRAGMA user_version")[0] as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
  return db
    .rows(`PRAGMA table_info(${table})`)
    .some((r) => (r as { name: string }).name === column);
}

function addColumnIfMissing(db: MigrationDb, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Bring the DB to `SCHEMA_VERSION`. Call AFTER running SCHEMA_DDL. `fresh` means
 * the DB had no tables before this boot (the DDL just built the latest schema),
 * so it is stamped current with no replay. Throws on a DOWNGRADE (a DB stamped
 * newer than this build) — running old code against a newer schema risks silent
 * corruption, and refusing loudly beats guessing.
 */
export function migrate(db: MigrationDb, opts: { fresh: boolean }): void {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `app.db is schema v${current}, newer than this build (v${SCHEMA_VERSION}) — ` +
        "refusing to open it with older code. Update OpenTrade.",
    );
  }
  if (opts.fresh) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[v]?.(db);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
