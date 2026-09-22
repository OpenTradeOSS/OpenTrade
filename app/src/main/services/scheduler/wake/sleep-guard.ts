import { hostLog } from "../../../host/log";
import { analytics } from "../../analytics";
import { bindIOKit, type IOKit } from "./iokit-assertion";

/**
 * Keep the Mac awake while an unattended wake runs.
 *
 * A headless run is a long job on a machine nobody is touching, so macOS idle sleep is
 * its real adversary: the machine dozes mid-turn, the API stream is suspended, and the
 * wall-clock kill timer ends the run. The idiomatic fix is an IOKit **power assertion** —
 * the same `PreventUserIdleSystemSleep` that `caffeinate -i` and Electron's
 * `powerSaveBlocker` take — held for exactly the run's lifetime. No privileges needed; it
 * shows up by name in `pmset -g assertions`; powerd drops it if the holder dies. It blocks
 * *idle* sleep only: a closed lid, the Apple-menu Sleep item, or a low battery still
 * sleep the machine, and it has no effect during a dark wake — both accepted.
 *
 * The host is a plain Node process (`ELECTRON_RUN_AS_NODE`), so `powerSaveBlocker` is
 * not available; the call goes through `koffi` (a prebuilt N-API FFI) straight to IOKit
 * (`iokit-assertion.ts`). Bound lazily, and any failure degrades to a no-op — the wake
 * layer never depends on it.
 *
 * The worst case of this feature is a Mac kept awake indefinitely, so every way it can go
 * wrong is observable: the guard tracks what it holds (`held` / `releaseAll`, audited by
 * the coordinator after every run), a release that powerd dropped *before its timeout was
 * due* is reported (`SleepGuardTimeoutFired`), and an install where IOKit can't be bound
 * is reported once (`SleepGuardUnavailable`). All ride the `app_error` funnel.
 */
export interface SleepGuard {
  /** Hold an assertion named `reason` until the returned release is called or
   *  `timeoutSec` elapses (powerd's own safety net). Returns null when the guard is
   *  unavailable. The release returns whether powerd still had the assertion. */
  hold(reason: string, timeoutSec: number): (() => boolean) | null;
  /** Assertions this process currently holds. */
  held(): number;
  /** Force-release everything held (the leak self-heal); returns how many there were. */
  releaseAll(): number;
}

/** IOKit couldn't be bound on this install — headless runs won't hold off idle sleep. */
export class SleepGuardUnavailable extends Error {
  override name = "SleepGuardUnavailable";
}
/** powerd no longer had an assertion whose timeout was NOT yet due — something other
 *  than the safety net dropped it. */
export class SleepGuardTimeoutFired extends Error {
  override name = "SleepGuardTimeoutFired";
}
/** Assertions were still held with no headless run active — a leak, force-released. */
export class SleepGuardLeak extends Error {
  override name = "SleepGuardLeak";
}

interface Held {
  reason: string;
  heldAt: number;
  timeoutMs: number;
}

/** Build a guard over an IOKit binding (bound lazily on first use; a failed bind is
 *  not retried — the reason is reported once and the guard stays a no-op). */
export function createSleepGuard(bind: () => IOKit): SleepGuard {
  let iokit: IOKit | undefined;
  let bindFailed = false;
  /** Assertion id → what/when, for everything this guard currently holds. */
  const held = new Map<number, Held>();

  const io = (): IOKit | null => {
    if (process.platform !== "darwin" || bindFailed) return null;
    try {
      iokit ??= bind();
      return iokit;
    } catch (err) {
      bindFailed = true;
      hostLog.warn("sleep guard unavailable; headless runs won't hold off idle sleep", String(err));
      analytics.trackError("wake", new SleepGuardUnavailable(String(err)), "caught");
      return null;
    }
  };

  /** Release one assertion. `quiet` skips the late-release report (the caller is
   *  already reporting a leak). Never throws — a throw here would leave the writer
   *  stuck in HEADLESS_RUNNING, the one state the audit can't heal. */
  const release = (kit: IOKit, id: number, quiet = false): boolean => {
    const h = held.get(id);
    held.delete(id);
    let rc: number;
    try {
      rc = kit.release(id);
    } catch (err) {
      hostLog.warn("sleep guard: assertion release threw", String(err));
      return false;
    }
    if (rc === 0) return true;
    // powerd no longer had it. Past the timeout that's the safety net doing its job —
    // routine after a long lid-close (the kill timer pauses with the machine; powerd's
    // clock doesn't). Before the timeout, something else dropped it: report that.
    const expired = h ? Date.now() - h.heldAt >= h.timeoutMs : false;
    if (expired || quiet) {
      hostLog.info("sleep guard: assertion had already timed out before release", `rc=${rc}`);
    } else {
      hostLog.error("sleep guard: assertion dropped before its timeout was due", `rc=${rc}`);
      analytics.trackError("wake", new SleepGuardTimeoutFired(`rc=${rc}`), "caught");
    }
    return false;
  };

  return {
    hold(reason, timeoutSec) {
      const kit = io();
      if (!kit) return null;
      let id: number | null;
      try {
        id = kit.create(reason, timeoutSec);
      } catch (err) {
        hostLog.warn("sleep guard: assertion create threw", String(err));
        return null;
      }
      if (id === null) {
        hostLog.warn("sleep guard: IOPMAssertionCreateWithDescription refused the assertion");
        return null;
      }
      held.set(id, { reason, heldAt: Date.now(), timeoutMs: timeoutSec * 1000 });
      let done = false;
      return () => {
        if (done) return true;
        done = true;
        return release(kit, id);
      };
    },
    held: () => held.size,
    releaseAll() {
      const kit = io();
      const n = held.size;
      for (const id of [...held.keys()]) {
        if (kit) release(kit, id, true);
        else held.delete(id);
      }
      return n;
    },
  };
}

/** The real thing: `PreventUserIdleSystemSleep` via IOKit. */
export const idleSleepGuard: SleepGuard = createSleepGuard(bindIOKit);
