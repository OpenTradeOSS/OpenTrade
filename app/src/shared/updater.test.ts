import { describe, expect, test } from "bun:test";
import { isPrereleaseVersion } from "./updater";

describe("isPrereleaseVersion", () => {
  test("recognises a semver prerelease component", () => {
    expect(isPrereleaseVersion("0.2.7")).toBe(false);
    expect(isPrereleaseVersion("0.2.8-beta.1")).toBe(true);
    expect(isPrereleaseVersion("1.0.0-rc.2")).toBe(true);
  });

  test("dev / placeholder versions are not prereleases", () => {
    expect(isPrereleaseVersion("dev")).toBe(false);
    expect(isPrereleaseVersion("0.0.0")).toBe(false);
    expect(isPrereleaseVersion("")).toBe(false);
  });
});
