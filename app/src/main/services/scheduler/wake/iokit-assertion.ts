/**
 * The raw IOKit power-assertion binding — the only file that touches `koffi`. Kept
 * dependency-free so a subprocess can load it in the real host runtime
 * (Electron-as-Node): Bun's test runner cannot host koffi (its N-API finalizer trips a
 * Bun GC assertion and the process panics), so `iokit-assertion.test.ts` bundles this
 * file and runs it under Electron instead. Everything above it (`sleep-guard.ts`) is
 * plain TypeScript, unit-tested with a fake `IOKit`.
 */
export interface IOKit {
  /** `IOPMAssertionCreateWithDescription(PreventUserIdleSystemSleep, …)`: the assertion
   *  id, or null if powerd refused. `timeoutSec` → `TimeoutActionRelease`. */
  create: (reason: string, timeoutSec: number) => number | null;
  /** `IOPMAssertionRelease`: the IOReturn code (0 = released; non-zero = powerd no
   *  longer had it, e.g. its timeout already fired). */
  release: (id: number) => number;
}

/** Bind the four IOKit/CoreFoundation entry points. Throws if koffi or the frameworks
 *  can't be loaded (the caller decides how to degrade). */
export function bindIOKit(): IOKit {
  const koffi = require("koffi") as typeof import("koffi");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const io = koffi.load("/System/Library/Frameworks/IOKit.framework/IOKit");
  // CFStringRef is an opaque pointer — `void *` is the honest FFI spelling.
  const cfString = cf.func(
    "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)",
  );
  const cfRelease = cf.func("void CFRelease(void *cf)");
  const create = io.func(
    "int IOPMAssertionCreateWithDescription(void *type, void *name, void *details, void *reason, void *bundle, double timeout, void *timeoutAction, _Out_ uint32_t *id)",
  );
  const release = io.func("int IOPMAssertionRelease(uint32_t id)");
  const str = (s: string) => cfString(null, s, 0x08000100 /* kCFStringEncodingUTF8 */);
  return {
    create: (reason, timeoutSec) => {
      const type = str("PreventUserIdleSystemSleep");
      const name = str(reason);
      const action = str("TimeoutActionRelease"); // on timeout, drop the assertion
      try {
        // CFStringCreateWithCString returns NULL on an encoding failure, and
        // CFRelease(NULL) is a segfault of the whole host — never pass one through.
        if (!type || !name || !action) return null;
        const out = [0];
        const rc = create(type, name, null, null, null, timeoutSec, action, out);
        return rc === 0 ? out[0] : null;
      } finally {
        for (const s of [type, name, action]) if (s) cfRelease(s);
      }
    },
    release: (id) => release(id) as number,
  };
}
