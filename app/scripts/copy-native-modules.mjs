// Materialize native modules for packaging.
//
// Bun installs use an isolated store: `app/node_modules/better-sqlite3` and
// `node-pty` are SYMLINKS into `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>`.
// electron-builder cannot follow symlinks into the asar, so a packaged build would
// ship without the native `.node` binaries (and crash on boot).
//
// This replaces those symlinks with REAL, self-contained directory copies: each
// native package is copied with only its RUNTIME dependency closure nested under
// its own `node_modules/`, and its package.json is pruned to those deps. The
// pruning matters for two reasons:
//   1. Build-only deps (prebuild-install) pull deep trees
//      (prebuild-install -> simple-get -> once, ...) that aren't needed at runtime
//      and that electron-builder's dependency collector would otherwise try (and
//      fail) to resolve out of the bun store.
//   2. better-sqlite3 only `require`s `bindings` (-> file-uri-to-path) at runtime;
//      node-pty keeps `node-addon-api` (leaf package) so Linux can node-gyp rebuild.
//
// Idempotent-ish: skips packages that are already real, pruned dirs. Run it AFTER
// `electron-builder install-app-deps` (so the copied `.node` is the Electron-ABI
// build) and BEFORE electron-builder — wired as the `prepackage` npm script.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url))); // .../app
const nodeModules = join(appDir, "node_modules");

/**
 * The runtime dependency closure to keep for each package. Anything not listed is
 * pruned (build-only). Keys are every package we materialize; the top-level native
 * modules are the entry points.
 */
const RUNTIME_DEPS = {
  "better-sqlite3": ["bindings"],
  bindings: ["file-uri-to-path"],
  "file-uri-to-path": [],
  "node-pty": ["node-addon-api"],
  "node-addon-api": [],
};
const ENTRY_POINTS = ["better-sqlite3", "node-pty"];

/**
 * Copy `srcRealDir` -> `destDir` (dereferencing symlinks), prune its package.json
 * to its runtime deps, then recurse into those deps (resolved from the source's
 * bun-store sibling dir) under `destDir/node_modules/<dep>`.
 */
function materialize(name, srcRealDir, destDir) {
  const keep = RUNTIME_DEPS[name] ?? [];

  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(srcRealDir, destDir, { recursive: true, dereference: true });

  // Drop any node_modules the copy brought along; we rebuild only the runtime tree.
  rmSync(join(destDir, "node_modules"), { recursive: true, force: true });

  // Prune package.json to the runtime deps so the dependency collector only walks
  // what we actually ship.
  const pkgPath = join(destDir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const pruned = {};
    for (const d of keep) if (pkg.dependencies?.[d]) pruned[d] = pkg.dependencies[d];
    pkg.dependencies = pruned;
    delete pkg.optionalDependencies;
    delete pkg.devDependencies;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch {
    // no package.json — leaf module, nothing to prune
  }

  for (const dep of keep) {
    const sibling = join(dirname(srcRealDir), dep); // bun store sibling
    if (!existsSync(sibling)) {
      console.warn(`[copy-native] ${name}: runtime dep ${dep} not found at ${sibling}`);
      continue;
    }
    materialize(dep, realpathSync(sibling), join(destDir, "node_modules", dep));
  }
}

for (const name of ENTRY_POINTS) {
  const link = join(nodeModules, name);
  if (!existsSync(link)) {
    console.warn(`[copy-native] ${name} not found in node_modules — did you run \`bun install\`?`);
    continue;
  }
  if (!lstatSync(link).isSymbolicLink()) {
    console.log(`[copy-native] ${name} is already a real directory — skipping`);
    continue;
  }
  const real = realpathSync(link);
  console.log(`[copy-native] materializing ${name} <- ${real}`);
  rmSync(link, { recursive: true, force: true }); // remove just the symlink (rmSync uses lstat, so it unlinks the symlink itself rather than following it; recursive+force keeps it working on Node ≥24, where a bare rmSync on a symlink-to-dir throws EISDIR)
  materialize(name, real, link);
}

console.log("[copy-native] done");
