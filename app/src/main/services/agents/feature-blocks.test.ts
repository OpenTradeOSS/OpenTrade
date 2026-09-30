import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DISPLAY_NAME, APP_HOME_DIRNAME, RELEASE_CHANNEL } from "@shared/app-identity";
import { FEATURES } from "@shared/feature-flags";
import { applyFeatureBlocks } from "./registry";

const TEMPLATES = join(import.meta.dir, "../../../../../templates/agents");
const PREFIXES = ["CLAUDE.prefix.md", "AGENTS.prefix.codex.md"];

describe("applyFeatureBlocks", () => {
  const text = [
    "a",
    "<!-- feature:x -->",
    "on",
    "<!-- /feature:x -->",
    "<!-- !feature:x -->",
    "off",
    "<!-- /!feature:x -->",
    "z",
  ].join("\n");

  test("keeps the flag's side and drops every marker", () => {
    expect(applyFeatureBlocks(text, { x: true })).toBe("a\non\nz");
    expect(applyFeatureBlocks(text, { x: false })).toBe("a\noff\nz");
  });

  test("unknown flags count as off", () => {
    expect(applyFeatureBlocks(text, {})).toBe("a\noff\nz");
  });
});

describe("agent instruction prefixes", () => {
  for (const file of PREFIXES) {
    const raw = readFileSync(join(TEMPLATES, file), "utf8");

    test(`${file}: venues off is the Robinhood-only prompt (no Key Vault, Kalshi, markers)`, () => {
      const out = applyFeatureBlocks(raw, { venues: false });
      expect(out).not.toContain("Key Vault");
      expect(out).not.toContain("Kalshi");
      expect(out).not.toContain("<!--");
      expect(out).toContain("Robinhood MCP is your only source of truth");
    });

    test(`${file}: venues on adds the optional venues section`, () => {
      const out = applyFeatureBlocks(raw, { venues: true });
      expect(out).toContain("## Venues and data (optional)");
      expect(out).not.toContain("Robinhood MCP is your only source of truth");
      expect(out).not.toContain("<!--");
    });
  }
});

describe("release channel (unbundled = stable)", () => {
  test("stable identity and flags", () => {
    expect(RELEASE_CHANNEL).toBe("stable");
    expect(APP_DISPLAY_NAME).toBe("OpenTrade");
    expect(APP_HOME_DIRNAME).toBe(".opentrade");
    expect(FEATURES.venues).toBe(false);
  });
});
