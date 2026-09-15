import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MigrationDb } from "./migrate";

/**
 * Pre-migration snapshots of `app.db`.
 *
 * Migrations are additive and never lose data, but they are also one-way: a DB stamped
 * with a newer `user_version` is refused by older code (`migrate()` throws). That is the
 * right call for correctness, and it is exactly what bites someone who installs a beta
 * that bumps the schema and then wants to go back to the stable build — without a copy
 * of the pre-beta file there is no way back. So before `createDb()` lets a build replay
 * migrations on an existing DB (i.e. its `user_version` is below the build's
 * `SCHEMA_VERSION`), it snapshots the file here. Best-effort: a failed backup is logged
 * and the migration proceeds, because blocking every user's boot on a full disk is worse
 * than a missing safety net.
 *
 * Snapshots go to `<home>/backups/app.db.<utc-stamp>.v<from>.bak`, taken with
 * `VACUUM INTO` (a consistent, compacted copy even in WAL mode — no `-wal`/`-shm`
 * siblings to keep track of). At most one per *source* schema version: if a `.v<from>.bak`
 * already exists it is reused, so a migration that keeps failing (and so never advances
 * `user_version`) does not write a fresh copy on every host start. They are never pruned:
 * they accumulate at release cadence, and the one that matters for a rollback is the
 * oldest of a beta line — pruning by count would evict it first. Restoring is a manual
 * step (quit OpenTrade, swap the file back over `app.db`, delete any
 * `app.db-wal`/`-shm`) — documented in `docs/PACKAGING.md`.
 */

/** Subdirectory of the OpenTrade home the snapshots live in. */
export const BACKUP_DIR = "backups";

export interface BackupOptions {
  /** The OpenTrade home (`OPENTRADE_HOME`) — `backups/` is created under it. */
  home: string;
  /** The DB's current `user_version`, recorded in the filename so the matching build is obvious. */
  fromVersion: number;
  /** Injected clock (tests). */
  now?: Date;
}

/**
 * Snapshot the open DB before a migration. Returns the path written — or the path of an
 * existing snapshot for the same source version, in which case nothing is written.
 * Throws on failure (the caller decides whether that's fatal — `createDb()` treats it as
 * a warning).
 */
export function backupBeforeMigration(db: MigrationDb, opts: BackupOptions): string {
  const dir = join(opts.home, BACKUP_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `.v${opts.fromVersion}.bak`;
  const existing = readdirSync(dir).find((f) => f.startsWith("app.db.") && f.endsWith(suffix));
  if (existing) return join(dir, existing);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `app.db.${stamp}.v${opts.fromVersion}.bak`);
  // VACUUM INTO refuses to overwrite; the stamp makes the name unique per boot.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try {
    chmodSync(file, 0o600); // the DB holds broker tokens (see client.ts)
  } catch {
    // best-effort (e.g. not owner)
  }
  return file;
}
