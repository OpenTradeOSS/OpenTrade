import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { backupBeforeMigration } from "./backup";
import { SCHEMA_DDL } from "./ddl";
import { type MigrationDb, migrate, SCHEMA_VERSION, userVersion } from "./migrate";
import * as schema from "./schema";

export const OPENTRADE_HOME = process.env.OPENTRADE_HOME ?? join(homedir(), ".opentrade");

function ensureHome() {
  // 0700: the home holds plaintext broker tokens (no safeStorage under
  // ELECTRON_RUN_AS_NODE), so confidentiality rests on file permissions.
  if (!existsSync(OPENTRADE_HOME)) mkdirSync(OPENTRADE_HOME, { recursive: true, mode: 0o700 });
  const agentsDir = join(OPENTRADE_HOME, "agents");
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
  try {
    chmodSync(OPENTRADE_HOME, 0o700);
  } catch {
    // best-effort (e.g. not owner)
  }
}

/**
 * Open the app DB and bring its schema current. Production DBs must survive
 * updates: `SCHEMA_DDL` gives a fresh install the latest schema (and adds any
 * whole tables an old DB is missing), then `migrate()` replays the numbered
 * in-table migrations (`PRAGMA user_version`) on an existing DB. A DB stamped
 * newer than this build makes `migrate()` throw rather than risk corruption.
 */
export function createDb(log: Pick<Console, "info" | "warn"> = console) {
  ensureHome();
  const dbPath = join(OPENTRADE_HOME, "app.db");
  const sqlite = new Database(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // best-effort
  }
  sqlite.pragma("journal_mode = WAL");
  const m: MigrationDb = {
    exec: (sql) => void sqlite.exec(sql),
    rows: (sql) => sqlite.prepare(sql).all(),
  };
  // Fresh = no tables yet (the `agents` table has existed since the first release),
  // decided BEFORE the DDL runs so migrate() knows whether to stamp or replay.
  const fresh =
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get() ===
    undefined;
  // An existing DB this build is about to upgrade gets a snapshot first (backup.ts) —
  // before the DDL adds tables and before any numbered migration runs — so a later
  // downgrade (a beta tester going back to stable) has a file to restore. Best-effort:
  // the upgrade proceeds even if the snapshot fails. `log` is the host's file logger in
  // production (the detached host's stdio is discarded, so `console` would say nothing).
  if (!fresh) {
    const from = userVersion(m);
    if (from < SCHEMA_VERSION) {
      try {
        const file = backupBeforeMigration(m, { home: OPENTRADE_HOME, fromVersion: from });
        log.info(`db schema v${from} → v${SCHEMA_VERSION}; pre-migration snapshot: ${file}`);
      } catch (err) {
        log.warn("db pre-migration snapshot failed — continuing with the migration", String(err));
      }
    }
  }
  sqlite.exec(SCHEMA_DDL);
  migrate(m, { fresh });

  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
