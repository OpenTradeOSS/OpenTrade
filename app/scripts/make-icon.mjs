// Thin wrapper so `bun run make-icon` regenerates the placeholder app icon.
// Delegates to scripts/make-icon.py (Pillow + macOS iconutil). The generated
// build/icon.icns is committed; this only needs re-running to tweak the placeholder.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync("python3", [join(here, "make-icon.py")], { stdio: "inherit" });
process.exit(r.status ?? 1);
