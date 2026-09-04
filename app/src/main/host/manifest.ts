import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { basename, dirname, join } from "node:path";
import { OPENTRADE_HOME } from "../db/client";

/**
 * Discovery + supervision for the persistent backend host.
 *
 * The host is a singleton per OPENTRADE_HOME. The launcher (Electron app) and any
 * other starter use `ensureHost()` to adopt a live host or spawn one — guarded by
 * an exclusive lockfile so two concurrent starters (e.g. a GUI launch racing a
 * CLI/test) can never spawn two backends that fight over the stable faucet port.
 */
export interface HostManifest {
  pid: number;
  /** Stable faucet/approval-gate port (baked into agent PTYs). */
  faucetPort: number;
  /** tRPC HTTP/WS port for the GUI (discovered here; need not be stable). */
  trpcPort: number;
  /** Shared bearer token (faucet + tRPC + terminal WS). */
  token: string;
  startedAt: number;
  /**
   * App version the host was built from (= `app.getVersion()` at spawn). The
   * launcher only adopts a host whose version matches its own; after an
   * auto-update the old detached host keeps running old code, so a mismatch
   * forces a clean respawn (see `ensureHost`). Optional for forward-compat:
   * a manifest without it is treated as version "0.0.0".
   */
  version?: string;
}

const MANIFEST_FILE = join(OPENTRADE_HOME, "host.json");
const LOCK_FILE = join(OPENTRADE_HOME, "host.lock");

export function readManifest(): HostManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as HostManifest;
  } catch {
    return null;
  }
}

export function writeManifest(m: HostManifest): void {
  writeFileSync(MANIFEST_FILE, JSON.stringify(m), { mode: 0o600 });
}

export function clearManifest(): void {
  try {
    unlinkSync(MANIFEST_FILE);
  } catch {
    // already gone
  }
}

/** Whether a pid is alive (signal 0 throws ESRCH when the process is gone). */
export function isAlive(pid: number): boolean {
  // pid <= 0 is NOT a real process: `process.kill(0, …)` / `kill(-pgid, …)` target a
  // whole process GROUP, so `kill(0, 0)` would "succeed" for the caller's own group and
  // a later SIGTERM would take down the host itself. Never treat a non-positive pid as
  // alive (a stale spawn marker with pid 0 must not trigger a self-kill on boot).
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ping the host's faucet /health (no token needed) to confirm it's serving. */
export function pingHost(faucetPort: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(
      { host: "127.0.0.1", port: faucetPort, path: "/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** A live, reachable host for this home — or null. */
export async function liveHost(): Promise<HostManifest | null> {
  const m = readManifest();
  if (m && isAlive(m.pid) && (await pingHost(m.faucetPort))) return m;
  return null;
}

const versionOf = (m: HostManifest): string => m.version ?? "0.0.0";

/**
 * SIGTERM the host and wait for it to exit — its graceful handler tears down
 * everything it owns (scheduler, in-flight headless wakes + their spawn markers,
 * codex app-servers, PTYs, servers) and clears the manifest. A host still alive
 * after the grace window gets SIGKILL — and the manifest is only cleared once the
 * pid is actually dead: erasing it while a wedged host lives would let the next
 * launch spawn a second host that fights the orphan over the stable faucet port.
 * Two callers: `ensureHost` retiring a stale-version host after an auto-update,
 * and the launcher's "Quit OpenTrade Completely" (§12.6).
 */
export async function terminateHost(m: HostManifest): Promise<void> {
  if (process.platform === "win32") {
    // Windows does not deliver SIGTERM to arbitrary processes; Node terminates
    // only the requested pid. taskkill /T also retires the host-owned Codex and
    // PTY children instead of leaving them orphaned after an update/full quit.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(m.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    try {
      process.kill(m.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 50; i++) {
    if (!isAlive(m.pid)) break;
    await delay(100);
  }
  if (isAlive(m.pid)) {
    try {
      process.kill(m.pid, "SIGKILL");
    } catch {
      // died between the check and the kill
    }
    for (let i = 0; i < 20 && isAlive(m.pid); i++) await delay(100);
  }
  if (!isAlive(m.pid)) clearManifest();
}

/**
 * Acquire the exclusive spawn lock (O_EXCL). Reclaims a stale lock whose holder
 * pid is dead. Returns a release fn, or null if another live starter holds it.
 */
function acquireLock(): (() => void) | null {
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeFileSync(LOCK_FILE, String(process.pid));
    return () => {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
    };
  } catch {
    // Lock exists — reclaim if the holder is dead.
    const holder = Number(safeRead(LOCK_FILE));
    if (Number.isInteger(holder) && holder > 0 && !isAlive(holder)) {
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
      return acquireLock();
    }
    return null;
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Max consecutive spawn attempts before giving up (crash circuit-breaker). */
let spawnFailures = 0;
const MAX_SPAWN_FAILURES = 3;

/**
 * Adopt a live host or spawn one. Safe under concurrency: the spawn path runs
 * under an exclusive lock and re-checks for a live host inside it.
 *
 * @param hostEntry absolute path to the bundled host.js
 * @param expectedVersion the launcher's app version; a live host whose version
 *   differs is retired and respawned (so an auto-update's new code actually runs).
 *   Defaults to `OPENTRADE_VERSION` (which the launcher sets to `app.getVersion()`).
 */
export async function ensureHost(
  hostEntry: string,
  expectedVersion: string = process.env.OPENTRADE_VERSION ?? "0.0.0",
): Promise<HostManifest> {
  // Adopt only a host running the same version; retire a stale one before spawning.
  const adopt = async (): Promise<HostManifest | null> => {
    const m = await liveHost();
    if (!m) return null;
    if (versionOf(m) === expectedVersion) return m;
    await terminateHost(m); // stale version (post-update) — retire before respawning
    return null;
  };

  const fast = await adopt();
  if (fast) return fast;

  // Acquire the spawn lock; if another starter holds it, wait for the host it's
  // bringing up rather than spawning our own.
  let release = acquireLock();
  for (let i = 0; i < 50 && !release; i++) {
    await delay(100);
    const adopted = await adopt();
    if (adopted) return adopted;
    release = acquireLock();
  }
  if (!release) {
    const m = await adopt();
    if (m) return m;
    throw new Error("could not acquire host spawn lock");
  }

  try {
    // Re-check inside the lock.
    const inside = await adopt();
    if (inside) return inside;

    if (spawnFailures >= MAX_SPAWN_FAILURES) {
      throw new Error(`backend host failed to start ${spawnFailures}× — giving up (see host.log)`);
    }

    clearManifest();
    spawnHost(hostEntry);

    // Wait for the host to write a fresh manifest and start serving.
    for (let i = 0; i < 100; i++) {
      await delay(100);
      const m = readManifest();
      if (m && isAlive(m.pid) && (await pingHost(m.faucetPort))) {
        spawnFailures = 0;
        return m;
      }
    }
    spawnFailures++;
    throw new Error("backend host did not start within timeout (see host.log)");
  } finally {
    release();
  }
}

/**
 * The Electron binary to launch the detached host with. On macOS, spawning the
 * host from the **main app binary** (`process.execPath`) makes LaunchServices
 * check it in as a second *Foreground* app — a spurious "OpenTrade" dock icon with
 * the generic executable icon (`ELECTRON_RUN_AS_NODE` doesn't prevent this for a
 * detached launch of the bundle's main Mach-O). The bundled **`<Product> Helper.app`**
 * has `LSUIElement = true` in its Info.plist, so running the host from it stays
 * dockless. Falls back to `process.execPath` (dev / non-mac / helper missing).
 */
function hostLauncherBinary(): string {
  if (process.platform === "darwin") {
    const product = basename(process.execPath); // e.g. "OpenTrade" (or "Electron" in dev)
    const helper = join(
      dirname(process.execPath), // .../Contents/MacOS
      "..",
      "Frameworks",
      `${product} Helper.app`,
      "Contents",
      "MacOS",
      `${product} Helper`,
    );
    if (existsSync(helper)) return helper;
  }
  return process.execPath;
}

function spawnHost(hostEntry: string): void {
  if (!existsSync(hostEntry)) throw new Error(`host entry not found: ${hostEntry}`);
  const child = spawn(hostLauncherBinary(), [hostEntry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENTRADE_HOME },
  });
  child.unref();
}
