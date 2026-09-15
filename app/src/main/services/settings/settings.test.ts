import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { SettingsService } from "./index";

// The app uses better-sqlite3, which Bun's test runner can't load natively; the
// bun:sqlite drizzle driver exposes the same sync query API, so it stands in here.
function memDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

describe("SettingsService", () => {
  test("returns defaults on an empty store", () => {
    const s = new SettingsService(memDb());
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  test("update persists and round-trips, coercing booleans/numbers", () => {
    const s = new SettingsService(memDb());
    const next = s.update({
      approvalTimeoutSec: 120,
      pollIntervalFocusedSec: 3,
      defaultApprovalMode: "auto",
      onboardingComplete: true,
    });
    expect(next.approvalTimeoutSec).toBe(120);
    expect(next.pollIntervalFocusedSec).toBe(3);
    expect(next.defaultApprovalMode).toBe("auto");
    expect(next.onboardingComplete).toBe(true);
    // Unset fields keep their defaults.
    expect(next.pollIntervalBlurredSec).toBe(DEFAULT_SETTINGS.pollIntervalBlurredSec);
    // A fresh service over the same store reads the same values.
    expect(s.get()).toEqual(next);
  });

  test("partial update leaves other keys untouched", () => {
    const s = new SettingsService(memDb());
    s.update({ approvalTimeoutSec: 600 });
    s.update({ defaultApprovalMode: "auto" });
    const v = s.get();
    expect(v.approvalTimeoutSec).toBe(600);
    expect(v.defaultApprovalMode).toBe("auto");
  });

  test("telemetryEnabled defaults on and round-trips off", () => {
    const s = new SettingsService(memDb());
    expect(s.get().telemetryEnabled).toBe(true);
    expect(s.update({ telemetryEnabled: false }).telemetryEnabled).toBe(false);
    expect(s.get().telemetryEnabled).toBe(false);
  });

  test("showInMenuBar defaults on (menu bar item + ⌘Q→menu bar) and round-trips off", () => {
    const s = new SettingsService(memDb());
    expect(s.get().showInMenuBar).toBe(true);
    expect(s.update({ showInMenuBar: false }).showInMenuBar).toBe(false);
    expect(s.get().showInMenuBar).toBe(false);
  });

  test("updateChannel defaults to stable, round-trips, and rejects unknown channels", () => {
    const s = new SettingsService(memDb());
    expect(s.get().updateChannel).toBe("stable");
    expect(s.update({ updateChannel: "beta" }).updateChannel).toBe("beta");
    expect(s.get().updateChannel).toBe("beta");
    expect(s.update({ updateChannel: "stable" }).updateChannel).toBe("stable");
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    expect(() => s.update({ updateChannel: "canary" as any })).toThrow();
    // A garbage stored value falls back to the default rather than poisoning get().
    s.setRaw("update_channel", "nightly");
    expect(s.get().updateChannel).toBe("stable");
  });

  test("ms convenience getters convert seconds", () => {
    const s = new SettingsService(memDb());
    s.update({ pollIntervalFocusedSec: 7, pollIntervalBlurredSec: 12 });
    expect(s.pollIntervalFocusedMs).toBe(7000);
    expect(s.pollIntervalBlurredMs).toBe(12000);
  });

  test("rejects out-of-bounds values", () => {
    const s = new SettingsService(memDb());
    expect(() => s.update({ approvalTimeoutSec: 5 })).toThrow();
    expect(() => s.update({ pollIntervalFocusedSec: 0 })).toThrow();
  });

  test("getOrCreate generates once then reuses (stable token across restarts)", () => {
    const db = memDb();
    let calls = 0;
    const s1 = new SettingsService(db);
    const first = s1.getOrCreate("local_api_token", () => `tok-${++calls}`);
    expect(first).toBe("tok-1");
    // Same service: no regeneration.
    expect(s1.getOrCreate("local_api_token", () => `tok-${++calls}`)).toBe("tok-1");
    // A fresh service over the same store reads the persisted value.
    const s2 = new SettingsService(db);
    expect(s2.getOrCreate("local_api_token", () => `tok-${++calls}`)).toBe("tok-1");
    expect(calls).toBe(1);
  });
});
