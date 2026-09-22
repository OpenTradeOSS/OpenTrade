import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Verifies the real IOKit binding against powerd — in the host's actual runtime
// (Electron-as-Node), not under Bun: koffi's N-API finalizer trips a Bun GC assertion
// and panics the test process, so this test bundles `iokit-assertion.ts` with
// `bun build` and drives it from a child Electron process. The child reports what
// `pmset -g assertions` (powerd's view) showed at each step.

const appDir = resolve(import.meta.dir, "../../../../.."); // .../app
const electron = ((): string | null => {
  try {
    const p = require("electron") as unknown; // the binary path when required outside Electron
    return typeof p === "string" && existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

const NAME = `OpenTrade iokit-assertion test ${process.pid}`;

/** The child: create with a 1 s timeout, watch powerd drop it, then release late. */
const PROBE = `
const { execFileSync } = require("node:child_process");
const { bindIOKit } = require("./iokit-assertion.cjs");
const NAME = ${JSON.stringify(NAME)};
const seen = () => execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
  .split("\\n").filter((l) => l.includes(NAME)).length;
const io = bindIOKit();
const out = {};
const a = io.create(NAME, 60);
out.createdId = a;
out.seenAfterCreate = seen();
out.releaseRc = io.release(a);
out.seenAfterRelease = seen();
const b = io.create(NAME, 1);
out.seenBeforeTimeout = seen();
setTimeout(() => {
  out.seenAfterTimeout = seen();
  out.lateReleaseRc = io.release(b);
  console.log(JSON.stringify(out));
}, 3000); // generous: powerd enforces timeouts with timer leeway
`;

describe("iokit-assertion (real binding, under Electron-as-Node)", () => {
  test.skipIf(process.platform !== "darwin" || !electron)(
    "creates a visible PreventUserIdleSystemSleep assertion; release and timeout both drop it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "opentrade-iokit-"));
      try {
        const entry = join(dirname(import.meta.path), "iokit-assertion.ts");
        const built = spawnSync(
          process.execPath, // the bun running this test — no PATH assumption
          [
            "build",
            entry,
            "--target",
            "node",
            "--format",
            "cjs",
            "--external",
            "koffi",
            "--outfile",
            join(dir, "iokit-assertion.cjs"),
          ],
          { encoding: "utf8" },
        );
        expect(built.status).toBe(0);
        writeFileSync(join(dir, "probe.cjs"), PROBE);
        const run = spawnSync(electron as string, [join(dir, "probe.cjs")], {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_PATH: join(appDir, "node_modules"), // where the built file finds koffi
          },
        });
        expect(run.status, run.stderr).toBe(0);
        const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
        expect(out.createdId).toBeGreaterThan(0);
        expect(out.seenAfterCreate).toBe(1); // powerd lists it by our name
        expect(out.releaseRc).toBe(0); // released while still held
        expect(out.seenAfterRelease).toBe(0);
        expect(out.seenBeforeTimeout).toBe(1);
        expect(out.seenAfterTimeout).toBe(0); // powerd honoured TimeoutActionRelease
        expect(out.lateReleaseRc).not.toBe(0); // a late release is told it was beaten
        // and nothing of ours is left behind in this process's view either
        expect(
          execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" }).includes(NAME),
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
