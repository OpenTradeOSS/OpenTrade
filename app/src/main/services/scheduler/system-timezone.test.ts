import { afterEach, describe, expect, test } from "bun:test";
import { systemTimeZone } from "./system-timezone";

const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const resolvable = (tz: string) => {
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
};

describe("systemTimeZone", () => {
  test("always returns a zone Intl can resolve", () => {
    const tz = systemTimeZone();
    expect(tz.length).toBeGreaterThan(0);
    expect(() => resolvable(tz)).not.toThrow();
  });

  test("an explicit, valid TZ env var wins", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(systemTimeZone()).toBe("Asia/Tokyo");
  });

  test("an unparseable TZ env var is ignored in favour of the OS / process zone", () => {
    process.env.TZ = "Not/AZone";
    const tz = systemTimeZone();
    expect(tz).not.toBe("Not/AZone");
    expect(() => resolvable(tz)).not.toThrow();
  });
});
