import { describe, expect, test } from "bun:test";
import { CronTimer } from "./cron-timer";

const TZ = "America/New_York";

describe("CronTimer", () => {
  test("isValid accepts 5-field expressions and rejects junk", () => {
    expect(CronTimer.isValid("30 9 * * 1-5")).toBe(true);
    expect(CronTimer.isValid("*/5 * * * *")).toBe(true);
    expect(CronTimer.isValid("not a cron")).toBe(false);
    expect(CronTimer.isValid("99 99 99 99 99")).toBe(false);
  });

  test("arm returns a future next-fire time and nextRun matches", () => {
    const t = new CronTimer();
    const next = t.arm("a", "*/5 * * * *", TZ, true, () => {});
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(Date.now());
    expect(t.nextRun("a")).toBe(next);
    t.disarmAll();
  });

  test("disarm stops a job and forgets its next run", () => {
    const t = new CronTimer();
    t.arm("b", "0 0 * * *", TZ, true, () => {});
    expect(t.nextRun("b")).not.toBeNull();
    t.disarm("b");
    expect(t.nextRun("b")).toBeNull();
  });

  test("re-arming the same id replaces the prior timer", () => {
    const t = new CronTimer();
    const first = t.arm("c", "0 9 * * *", TZ, true, () => {});
    const second = t.arm("c", "0 17 * * *", TZ, true, () => {});
    expect(second).not.toBe(first);
    expect(t.nextRun("c")).toBe(second);
    t.disarmAll();
  });

  test("the expression is evaluated in the given zone, not the process's local zone", () => {
    const t = new CronTimer();
    // 5:30 in Dubai (no DST) is always 01:30 UTC, whatever zone the test runs in.
    const next = new Date(t.arm("d", "30 5 * * *", "Asia/Dubai", true, () => {}) ?? 0);
    expect(next.getUTCHours()).toBe(1);
    expect(next.getUTCMinutes()).toBe(30);
    t.disarmAll();
  });
});
