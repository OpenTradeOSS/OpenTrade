import { describe, expect, test } from "bun:test";
import type { IOKit } from "./iokit-assertion";
import { createSleepGuard } from "./sleep-guard";

// The tracking/reporting layer over a fake IOKit. The real binding is exercised in
// `iokit-assertion.test.ts` (under Electron-as-Node — Bun cannot host koffi).

/** Records creates/releases; `lateRelease` makes powerd "not have it any more". */
function fakeIOKit(opts: { lateRelease?: boolean; refuse?: boolean } = {}) {
  const live = new Set<number>();
  let next = 100;
  const kit: IOKit = {
    create: () => {
      if (opts.refuse) return null;
      const id = next++;
      live.add(id);
      return id;
    },
    release: (id) => {
      const had = live.delete(id);
      return had && !opts.lateRelease ? 0 : 0xe00002c2; // kIOReturnNotFound-ish
    },
  };
  return { kit, live };
}

const darwinOnly = test.skipIf(process.platform !== "darwin"); // the guard is a no-op elsewhere

describe("sleep guard (over a fake IOKit)", () => {
  darwinOnly("holds, counts, and releases; release is idempotent", () => {
    const { kit, live } = fakeIOKit();
    const guard = createSleepGuard(() => kit);
    const release = guard.hold("r", 60);
    expect(release).not.toBeNull();
    expect(guard.held()).toBe(1);
    expect(live.size).toBe(1);
    expect(release?.()).toBe(true);
    expect(guard.held()).toBe(0);
    expect(live.size).toBe(0);
    expect(release?.()).toBe(true); // second call: nothing to do, still "fine"
  });

  darwinOnly("a release powerd already timed out reports false", () => {
    const { kit } = fakeIOKit({ lateRelease: true });
    const guard = createSleepGuard(() => kit);
    const release = guard.hold("r", 1);
    expect(release?.()).toBe(false);
    expect(guard.held()).toBe(0); // no longer tracked either way
  });

  darwinOnly("releaseAll force-releases everything held", () => {
    const { kit, live } = fakeIOKit();
    const guard = createSleepGuard(() => kit);
    guard.hold("a", 60);
    guard.hold("b", 60);
    expect(guard.held()).toBe(2);
    expect(guard.releaseAll()).toBe(2);
    expect(guard.held()).toBe(0);
    expect(live.size).toBe(0);
  });

  darwinOnly("an unbindable IOKit degrades to null holds, binding attempted once", () => {
    let binds = 0;
    const guard = createSleepGuard(() => {
      binds += 1;
      throw new Error("no koffi here");
    });
    expect(guard.hold("r", 60)).toBeNull();
    expect(guard.hold("r", 60)).toBeNull();
    expect(guard.held()).toBe(0);
    expect(binds).toBe(1); // a failed bind is final for the process (and reported once)
  });

  darwinOnly("a release that throws is contained and reads as not released", () => {
    const kit: IOKit = {
      create: () => 7,
      release: () => {
        throw new Error("marshalling");
      },
    };
    const guard = createSleepGuard(() => kit);
    const release = guard.hold("r", 60);
    expect(release?.()).toBe(false);
    expect(guard.held()).toBe(0);
  });

  darwinOnly("a refused assertion is a null hold, not an exception", () => {
    const { kit } = fakeIOKit({ refuse: true });
    const guard = createSleepGuard(() => kit);
    expect(guard.hold("r", 60)).toBeNull();
    expect(guard.held()).toBe(0);
  });
});
