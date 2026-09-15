import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_DIR, backupBeforeMigration } from "./backup";
import type { MigrationDb } from "./migrate";

/** Adapt bun:sqlite to the runner's minimal surface (the app adapts better-sqlite3). */
function wrap(db: Database): MigrationDb {
  return { exec: (sql) => void db.exec(sql), rows: (sql) => db.query(sql).all() };
}

const homes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ot-backup-"));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("pre-migration DB backup", () => {
  test("snapshots the DB into <home>/backups with the schema version in the name", () => {
    const home = tempHome();
    const src = new Database(join(home, "app.db"));
    src.exec("PRAGMA journal_mode = WAL");
    src.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    src.exec("INSERT INTO settings VALUES ('rh_oauth_tokens', 'secret')");
    src.exec("PRAGMA user_version = 7");

    const file = backupBeforeMigration(wrap(src), {
      home,
      fromVersion: 7,
      now: new Date("2026-09-14T22:30:00.000Z"),
    });

    expect(file).toBe(join(home, BACKUP_DIR, "app.db.2026-09-14T22-30-00-000Z.v7.bak"));
    expect(existsSync(file)).toBe(true);
    // The copy is a complete, standalone DB: same rows, same version stamp, no -wal sibling.
    const copy = new Database(file, { readonly: true });
    expect(copy.query("SELECT value FROM settings WHERE key='rh_oauth_tokens'").get()).toEqual({
      value: "secret",
    });
    expect(copy.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(existsSync(`${file}-wal`)).toBe(false);
    // The source is untouched (still at v7, still has its row) — the migration runs after.
    expect(src.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  });

  test("a second attempt from the same schema version reuses the existing snapshot", () => {
    const home = tempHome();
    const src = new Database(":memory:");
    src.exec("CREATE TABLE t (x)");
    const m = wrap(src);
    const first = backupBeforeMigration(m, {
      home,
      fromVersion: 7,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // e.g. the v8 migration threw, so user_version is still 7 on the next host start.
    const again = backupBeforeMigration(m, {
      home,
      fromVersion: 7,
      now: new Date("2026-01-02T00:00:00Z"),
    });
    expect(again).toBe(first);
    expect(readdirSync(join(home, BACKUP_DIR))).toEqual(["app.db.2026-01-01T00-00-00-000Z.v7.bak"]);
  });

  test("snapshots accumulate — an older schema's snapshot is never evicted by a newer one", () => {
    const home = tempHome();
    const src = new Database(":memory:");
    src.exec("CREATE TABLE t (x)");
    const m = wrap(src);
    backupBeforeMigration(m, { home, fromVersion: 7, now: new Date("2026-01-01T00:00:00Z") });
    backupBeforeMigration(m, { home, fromVersion: 8, now: new Date("2026-02-01T00:00:00Z") });
    backupBeforeMigration(m, { home, fromVersion: 9, now: new Date("2026-03-01T00:00:00Z") });
    expect(readdirSync(join(home, BACKUP_DIR)).sort()).toEqual([
      "app.db.2026-01-01T00-00-00-000Z.v7.bak",
      "app.db.2026-02-01T00-00-00-000Z.v8.bak",
      "app.db.2026-03-01T00-00-00-000Z.v9.bak",
    ]);
  });
});
