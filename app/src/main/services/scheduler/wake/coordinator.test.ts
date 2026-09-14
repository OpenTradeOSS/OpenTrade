import { describe, expect, test } from "bun:test";
import type { ExecutionState } from "@shared/agent";
import type { WakeFailureCategory } from "@shared/analytics";
import type { AgentRegistry } from "../../agents/registry";
import { WakeCoordinator } from "./coordinator";
import type {
  HeadlessExit,
  HeadlessExitReason,
  HeadlessWakeStrategy,
  PendingWake,
  SchedulerControl,
  WakeResult,
} from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal AgentRegistry stand-in: the execution-state surface the coordinator
 *  reads (seed) and writes (publish) — it IS the actor's state, 1:1 — plus the
 *  headless turn budget (`get` + `incrementHeadlessTurns`). An agent with no
 *  seeded budget record reads as un-gated (like the real registry's default row
 *  with the limit toggled off). */
class FakeRegistry {
  states = new Map<string, ExecutionState>();
  budgets = new Map<string, { turnLimitEnabled: boolean; headlessTurnsUsed: number }>();
  executionStateOf(id: string): ExecutionState {
    return this.states.get(id) ?? "offline";
  }
  setExecutionState(id: string, s: ExecutionState): void {
    if (s === "offline") this.states.delete(id);
    else this.states.set(id, s);
  }
  get(id: string) {
    return this.budgets.get(id);
  }
  incrementHeadlessTurns(id: string): number {
    const b = this.budgets.get(id);
    if (!b) return 0;
    b.headlessTurnsUsed += 1;
    return b.headlessTurnsUsed;
  }
}

/** Headless runs report their outcome only when the test calls `finishNext(reason)`. */
class FakeHeadless implements HeadlessWakeStrategy {
  calls: string[] = [];
  stops = 0;
  private exits: HeadlessExit[] = [];
  run(id: string, prompt: string, onExit: HeadlessExit): void {
    this.calls.push(`${id}:${prompt}`);
    this.exits.push(onExit);
  }
  /** Simulate the active `-p` child exiting with the given outcome. */
  finishNext(reason: HeadlessExitReason = "ok", failureCategory?: WakeFailureCategory): void {
    this.exits.shift()?.(reason, failureCategory);
  }
  stop(): boolean {
    this.stops++;
    return true;
  }
  stopAll(): void {}
}

function make(maxHeadlessRunMs = 10_000, maxHeadlessTurns = 20, featureEnabled = true) {
  const reg = new FakeRegistry();
  const headless = new FakeHeadless();
  const coord = new WakeCoordinator(reg as unknown as AgentRegistry, headless, {
    maxHeadlessRunMs: () => maxHeadlessRunMs,
    maxHeadlessTurns: () => maxHeadlessTurns,
    turnLimitFeatureEnabled: () => featureEnabled,
  });
  return { reg, headless, coord };
}

let wakeSeq = 0;
/** A queued wake carrying `prompt` (the scheduler mints these at fire time). */
function w(prompt: string): PendingWake {
  wakeSeq += 1;
  return { id: `wake${wakeSeq}`, agentId: "a", prompt, sourceKind: "cron", sourceId: "s1" };
}

/** A recording `SchedulerControl`: what the coordinator reported started/finished. */
function makeRecorder() {
  const started: Array<{ prompt: string; background: boolean }> = [];
  const finished: Array<{ wakeId: string; result: WakeResult }> = [];
  const sched: SchedulerControl = {
    disarmAgent: () => {},
    rearmAgent: () => {},
    wakeStarted: (wake, background) => started.push({ prompt: wake.prompt, background }),
    wakeFinished: (wake, result) => finished.push({ wakeId: wake.id, result }),
  };
  return { sched, started, finished };
}

/** Start a `/wake-stream` poll; returns the promise + its abort controller. */
function poll(c: WakeCoordinator, id: string, holdMs = 10_000) {
  const ac = new AbortController();
  return { p: c.awaitPoll(id, ac.signal, holdMs), ac };
}

describe("WakeCoordinator — headless transport (ported)", () => {
  test("offline agent runs headless, completion-gated on exit", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("a", w("p1"));
    expect(headless.calls).toEqual(["a:p1"]);
    expect(reg.executionStateOf("a")).toBe("headless");
    headless.finishNext("ok");
    expect(reg.executionStateOf("a")).toBe("offline");
  });

  test("a second headless wake queues behind the active run, then drains in order", () => {
    const { headless, coord } = make();
    coord.enqueue("b", w("p1"));
    coord.enqueue("b", w("p2"));
    expect(headless.calls).toEqual(["b:p1"]); // p2 queued, held at the head until exit
    headless.finishNext("ok");
    expect(headless.calls).toEqual(["b:p1", "b:p2"]);
    headless.finishNext("ok");
  });

  test("never serves a poll while a headless run holds the agent", async () => {
    const { headless, coord } = make();
    coord.enqueue("f", w("p1")); // offline → headless run
    expect(headless.calls).toEqual(["f:p1"]);
    const ac = new AbortController();
    expect(await coord.awaitPoll("f", ac.signal, 20)).toBeNull(); // channel inert under -p
    expect(headless.calls).toEqual(["f:p1"]); // unchanged
    headless.finishNext("ok");
  });

  test("a headless run is killed by the max-runtime timer", async () => {
    const { headless, coord } = make(20); // tiny max-runtime
    coord.enqueue("x", w("p1"));
    expect(headless.calls).toEqual(["x:p1"]);
    await wait(40); // kill timer fires → SIGTERM the child
    expect(headless.stops).toBe(1);
  });
});

describe("WakeCoordinator — interactive transport (channel)", () => {
  test("a wake queued before any poll is handed to the next poll", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("d");
    coord.enqueue("d", w("p1"));
    expect(headless.calls).toEqual([]); // interactive, no poll yet → queued, never headless
    const { p } = poll(coord, "d");
    expect(await p).toBe("p1"); // handed off from the queue head
  });

  test("the head is delivered to a parked poll immediately (no turn gating)", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("c");
    const { p } = poll(coord, "c");
    await tick();
    coord.enqueue("c", w("p1")); // mid-turn or not, the channel accepts the push
    expect(await p).toBe("p1");
    expect(headless.calls).toEqual([]); // never headless while interactive
  });

  test("two wakes fired back-to-back are handed to successive polls in order", async () => {
    const { coord } = make();
    coord.onInteractiveUp("t");
    coord.enqueue("t", w("p1"));
    coord.enqueue("t", w("p2")); // both queued (no poll parked yet)
    const { p: p1 } = poll(coord, "t");
    expect(await p1).toBe("p1");
    const { p: p2 } = poll(coord, "t");
    expect(await p2).toBe("p2");
  });

  test("an undelivered head re-routes to headless when the PTY dies before handoff", () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("m");
    coord.enqueue("m", w("p1")); // interactive, no poll → queued
    expect(headless.calls).toEqual([]);
    coord.onInteractiveDown("m"); // PTY dies (crash / GUI quit) before any handoff
    expect(headless.calls).toEqual(["m:p1"]); // re-routed to the -p transport
    headless.finishNext("ok");
  });

  test("awaitPoll returns null when the hold elapses", async () => {
    const { coord } = make();
    const ac = new AbortController();
    expect(await coord.awaitPoll("e", ac.signal, 10)).toBeNull();
  });

  test("awaitPoll returns null when the request aborts", async () => {
    const { coord } = make();
    const ac = new AbortController();
    const p = coord.awaitPoll("e2", ac.signal, 10_000);
    await tick();
    ac.abort();
    expect(await p).toBeNull();
  });
});

describe("WakeCoordinator — broken / resume-fail", () => {
  test("a broken agent drops its queued wakes and is never served", async () => {
    const { reg, headless, coord } = make();
    reg.setExecutionState("h", "broken"); // seed from a boot-time reconcile
    coord.enqueue("h", w("p1"));
    expect(headless.calls).toEqual([]);
    expect(reg.executionStateOf("h")).toBe("broken");
    const ac = new AbortController();
    expect(await coord.awaitPoll("h", ac.signal, 10)).toBeNull();
  });

  test("broken only after 3 consecutive resume-fails; each drops its own wake", () => {
    const { reg, headless, coord } = make();
    for (let i = 1; i <= 2; i++) {
      coord.enqueue("r", w(`p${i}`));
      expect(reg.executionStateOf("r")).toBe("headless");
      headless.finishNext("resumeFail"); // drops the wake, increments the streak
      expect(reg.executionStateOf("r")).toBe("offline"); // not broken yet
    }
    coord.enqueue("r", w("p3"));
    headless.finishNext("resumeFail"); // 3rd in a row
    expect(reg.executionStateOf("r")).toBe("broken");
    expect(headless.calls).toEqual(["r:p1", "r:p2", "r:p3"]); // each ran once, then dropped
  });

  test("a clean exit resets the resume-fail streak", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("s", w("p1"));
    headless.finishNext("resumeFail"); // streak = 1
    coord.enqueue("s", w("p2"));
    headless.finishNext("ok"); // streak reset to 0
    coord.enqueue("s", w("p3"));
    headless.finishNext("resumeFail"); // streak = 1 again, NOT 3
    expect(reg.executionStateOf("s")).toBe("offline");
  });

  test("a spawn error is one-strike broken and drops the queue", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("z", w("p1"));
    coord.enqueue("z", w("p2")); // queued behind the active run
    headless.finishNext("spawnFail");
    expect(reg.executionStateOf("z")).toBe("broken");
    expect(headless.calls).toEqual(["z:p1"]); // p2 dropped, never ran
  });

  test("restart (onInteractiveUp) clears broken back to interactive", () => {
    const { reg, coord } = make();
    reg.setExecutionState("w", "broken");
    coord.enqueue("w", w("p1")); // creates the writer, seeded broken
    expect(reg.executionStateOf("w")).toBe("broken");
    coord.onInteractiveUp("w"); // manual Restart spawns a fresh PTY
    expect(reg.executionStateOf("w")).toBe("interactive");
  });

  test("going broken disarms the agent's scheduling; recovering re-arms it", () => {
    const { headless, coord } = make();
    const sched = {
      ...makeRecorder().sched,
      disarmed: [] as string[],
      rearmed: [] as string[],
      disarmAgent(id: string) {
        this.disarmed.push(id);
      },
      rearmAgent(id: string) {
        this.rearmed.push(id);
      },
    };
    coord.setScheduler(sched);

    for (let i = 1; i <= 3; i++) {
      coord.enqueue("b", w(`p${i}`));
      headless.finishNext("resumeFail");
    }
    expect(sched.disarmed).toEqual(["b"]); // paused exactly once, on the broken transition
    expect(sched.rearmed).toEqual([]);

    coord.onInteractiveUp("b"); // manual Restart
    expect(sched.rearmed).toEqual(["b"]); // scheduling resumes
  });

  test("a spawn-fail broken also disarms scheduling", () => {
    const { coord, headless } = make();
    const disarmed: string[] = [];
    coord.setScheduler({ ...makeRecorder().sched, disarmAgent: (id) => disarmed.push(id) });
    coord.enqueue("s", w("p1"));
    headless.finishNext("spawnFail"); // one-strike broken
    expect(disarmed).toEqual(["s"]);
  });
});

describe("WakeCoordinator — headless turn limit", () => {
  test("each headless run consumes one turn; the run past the budget is dropped", () => {
    const { reg, headless, coord } = make(10_000, 2);
    reg.budgets.set("a", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    coord.enqueue("a", w("p1"));
    headless.finishNext("ok");
    coord.enqueue("a", w("p2"));
    headless.finishNext("ok");
    expect(reg.budgets.get("a")!.headlessTurnsUsed).toBe(2);
    coord.enqueue("a", w("p3")); // budget spent → dropped, never spawned
    expect(headless.calls).toEqual(["a:p1", "a:p2"]);
    expect(reg.executionStateOf("a")).toBe("offline"); // stays OFFLINE, not headless
  });

  test("an exhausted budget also gates queued wakes draining after the active run", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("q", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    coord.enqueue("q", w("p1")); // consumes the only turn
    coord.enqueue("q", w("p2")); // queued behind the active run
    headless.finishNext("ok"); // drain → gate trips → p2 dropped
    expect(headless.calls).toEqual(["q:p1"]);
    expect(reg.executionStateOf("q")).toBe("offline");
  });

  test("a reset (the turn-limit button's Reset control) re-opens the budget", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("v", { turnLimitEnabled: true, headlessTurnsUsed: 1 }); // spent
    coord.enqueue("v", w("p1"));
    expect(headless.calls).toEqual([]); // gated
    reg.budgets.get("v")!.headlessTurnsUsed = 0; // = registry.resetHeadlessTurns (agents.resetTurnLimit)
    coord.enqueue("v", w("p2"));
    expect(headless.calls).toEqual(["v:p2"]);
    headless.finishNext("ok");
  });

  test("a disabled per-agent toggle bypasses the limit", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("d", { turnLimitEnabled: false, headlessTurnsUsed: 99 });
    coord.enqueue("d", w("p1"));
    expect(headless.calls).toEqual(["d:p1"]);
    headless.finishNext("ok");
    expect(reg.budgets.get("d")!.headlessTurnsUsed).toBe(100); // still counted, never gated
  });

  test("interactive (channel) delivery is never gated or counted", async () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("i", { turnLimitEnabled: true, headlessTurnsUsed: 5 }); // way past the limit
    coord.onInteractiveUp("i");
    coord.enqueue("i", w("p1"));
    const { p } = poll(coord, "i");
    expect(await p).toBe("p1"); // delivered via the channel regardless of the budget
    expect(headless.calls).toEqual([]);
    expect(reg.budgets.get("i")!.headlessTurnsUsed).toBe(5); // untouched
  });

  test("wouldDropWake: true when broken or turn-exhausted (offline), false when interactive", () => {
    const { reg, coord } = make(10_000, 1);
    // Fresh offline agent, budget open → deliverable.
    reg.budgets.set("w", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    expect(coord.wouldDropWake("w")).toBe(false);
    // Spent budget while offline → would drop.
    reg.budgets.get("w")!.headlessTurnsUsed = 1;
    expect(coord.wouldDropWake("w")).toBe(true);
    // Interactive session ignores the budget → deliverable via the channel.
    coord.onInteractiveUp("w");
    expect(coord.wouldDropWake("w")).toBe(false);
    // Broken → would drop.
    const { reg: reg2, coord: coord2 } = make();
    reg2.setExecutionState("b", "broken");
    expect(coord2.wouldDropWake("b")).toBe(true);
  });

  test("the global feature switch off: never gated (but still counts — no freeze)", () => {
    const { reg, headless, coord } = make(10_000, 1, /* featureEnabled */ false);
    reg.budgets.set("g", { turnLimitEnabled: true, headlessTurnsUsed: 5 }); // past the limit
    coord.enqueue("g", w("p1"));
    coord.enqueue("g", w("p2")); // queued behind the active run
    expect(headless.calls).toEqual(["g:p1"]); // runs despite budget being spent
    headless.finishNext("ok");
    expect(headless.calls).toEqual(["g:p1", "g:p2"]); // and drains the next, no gate
    headless.finishNext("ok");
    // No freeze: the count still advances while off (it's reset wholesale on re-enable,
    // so there's nothing to preserve). Only gating/notifying is suppressed.
    expect(reg.budgets.get("g")!.headlessTurnsUsed).toBe(7); // 5 + 2 runs
  });
});

describe("WakeCoordinator — stop", () => {
  test("stop() clears pending and ends an in-flight headless run", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("i", w("p1")); // headless run in flight
    coord.enqueue("i", w("p2")); // queued
    expect(coord.stop("i")).toBe(true);
    expect(headless.stops).toBe(1);
    headless.finishNext("ok"); // the SIGTERM'd child exits (treated as a deliberate stop)
    expect(reg.executionStateOf("i")).toBe("offline");
    expect(headless.calls).toEqual(["i:p1"]); // p2 was cleared, never ran
  });

  test("stop() on an interactive agent clears the queue and reports no headless run", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("j");
    coord.enqueue("j", w("p1")); // queued (no poll)
    expect(coord.stop("j")).toBe(false); // nothing headless to stop
    const { p } = poll(coord, "j", 10);
    expect(await p).toBeNull(); // queue cleared → a fresh poll parks, then the hold elapses
    expect(headless.calls).toEqual([]);
  });

  test("stop() on an unknown agent is a no-op", () => {
    const { coord } = make();
    expect(coord.stop("nope")).toBe(false);
  });
});

describe("WakeCoordinator — push transport (codex interactive)", () => {
  /** A controllable InteractivePush: resolves when the test settles it. */
  function makePush() {
    const delivered: string[] = [];
    const settles: Array<(ok: boolean) => void> = [];
    const push = (prompt: string) =>
      new Promise<boolean>((resolve) => {
        delivered.push(prompt);
        settles.push(resolve);
      });
    return { push, delivered, settle: (ok: boolean) => settles.shift()?.(ok) };
  }

  test("wake while interactive delivers via push; head advances only on ack", async () => {
    const { headless, coord } = make();
    const { push, delivered, settle } = makePush();
    coord.onInteractiveUp("a", push);
    coord.enqueue("a", w("w1"));
    expect(delivered).toEqual(["w1"]);
    // Not acked yet — a PTY drop now must re-route the (still-queued) head.
    settle(true);
    await tick();
    expect(headless.calls).toEqual([]); // delivered interactively, nothing headless
  });

  test("queued wakes deliver one at a time, in order, after each ack", async () => {
    const { coord } = make();
    const { push, delivered, settle } = makePush();
    coord.onInteractiveUp("a", push);
    coord.enqueue("a", w("w1"));
    coord.enqueue("a", w("w2"));
    expect(delivered).toEqual(["w1"]); // one in flight at a time
    settle(true);
    await tick();
    expect(delivered).toEqual(["w1", "w2"]);
    settle(true);
  });

  test("a failed push keeps the head and retries after the backoff", async () => {
    const { coord } = make();
    const { push, delivered, settle } = makePush();
    coord.onInteractiveUp("a", push);
    coord.enqueue("a", w("w1"));
    settle(false);
    await tick();
    expect(delivered).toEqual(["w1"]); // not retried yet (5s backoff)
    // The head was NOT dropped: PTY down re-routes it to headless.
    coord.onInteractiveDown("a");
    // (drain goes headless — asserted via the fake in the next test)
  });

  test("un-acked head re-routes to headless when the PTY dies mid-push", async () => {
    const { headless, coord } = make();
    const { push, settle } = makePush();
    coord.onInteractiveUp("a", push);
    coord.enqueue("a", w("w1"));
    coord.onInteractiveDown("a"); // TUI died before the ack
    expect(headless.calls).toEqual(["a:w1"]); // head re-routed, not lost
    settle(true); // late ack from the dead session must not double-deliver
    await tick();
    expect(headless.calls).toEqual(["a:w1"]);
  });

  test("in push mode the parked /wake-stream poll is never served", async () => {
    const { coord } = make();
    const { push, delivered, settle } = makePush();
    coord.onInteractiveUp("a", push);
    const { p, ac } = poll(coord, "a", 50);
    coord.enqueue("a", w("w1"));
    expect(delivered).toEqual(["w1"]); // push got it…
    settle(true);
    expect(await p).toBeNull(); // …the poll parked inertly and timed out empty
    ac.abort();
  });

  test("channel mode (no push) still serves the parked poll — claude unchanged", async () => {
    const { coord } = make();
    coord.onInteractiveUp("a"); // no push: channel transport
    const { p } = poll(coord, "a");
    coord.enqueue("a", w("w1"));
    expect(await p).toBe("w1");
  });

  test("respawn-while-interactive: a new push isn't wedged by the old in-flight one (B5)", async () => {
    const { coord } = make();
    const first = makePush();
    coord.onInteractiveUp("a", first.push);
    coord.enqueue("a", w("w1"));
    expect(first.delivered).toEqual(["w1"]); // in flight on the first push, not yet acked

    // A respawn-while-interactive installs a FRESH push before the first one settled
    // (maybeRespawnFresh keeps the writer INTERACTIVE and re-reports onInteractiveUp).
    const second = makePush();
    coord.onInteractiveUp("a", second.push);
    // The queue head must be served by the new push right away (pushInFlight was reset).
    expect(second.delivered).toEqual(["w1"]);

    // A late settle from the STALE push must not clobber the new push's in-flight state
    // or shift the head — the new push still owns delivery.
    first.settle(true);
    await tick();
    second.settle(true);
    await tick();
    // A follow-up wake still delivers, proving the queue isn't wedged.
    coord.enqueue("a", w("w2"));
    expect(second.delivered).toEqual(["w1", "w2"]);
  });
});

describe("WakeCoordinator — History recording (wakeStarted / wakeFinished)", () => {
  test("a headless run is recorded when it starts and settled succeeded on a clean exit", () => {
    const { headless, coord } = make();
    const { sched, started, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    expect(started).toEqual([{ prompt: "p1", background: true }]);
    expect(finished).toEqual([]); // still running
    headless.finishNext("ok");
    expect(finished).toEqual([{ wakeId: wake.id, result: { outcome: "succeeded" } }]);
  });

  test("a resume failure settles failed with its reason + classified category", () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    headless.finishNext("resumeFail", "billing");
    expect(finished).toEqual([
      {
        wakeId: wake.id,
        result: { outcome: "failed", failureReason: "resume_fail", failureCategory: "billing" },
      },
    ]);
  });

  test("a spawn failure settles failed (spawn_fail) before the agent goes broken", () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    headless.finishNext("spawnFail");
    expect(finished[0]).toEqual({
      wakeId: wake.id,
      result: { outcome: "failed", failureReason: "spawn_fail", failureCategory: undefined },
    });
  });

  test("a user Stop mid-run settles the head as stopped", () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    expect(coord.stop("a")).toBe(true);
    headless.finishNext("ok"); // the SIGTERM'd child's exit
    expect(finished).toEqual([{ wakeId: wake.id, result: { outcome: "stopped" } }]);
  });

  test("a wake queued behind a run is recorded only when ITS run starts", () => {
    const { headless, coord } = make();
    const { sched, started } = makeRecorder();
    coord.setScheduler(sched);
    coord.enqueue("a", w("p1"));
    coord.enqueue("a", w("p2")); // queued behind the active run
    expect(started.map((s) => s.prompt)).toEqual(["p1"]);
    headless.finishNext("ok");
    expect(started.map((s) => s.prompt)).toEqual(["p1", "p2"]);
  });

  test("a wake dropped for an exhausted turn budget is never recorded", () => {
    const { reg, headless, coord } = make(10_000, 1);
    reg.budgets.set("a", { turnLimitEnabled: true, headlessTurnsUsed: 0 });
    const { sched, started } = makeRecorder();
    coord.setScheduler(sched);
    coord.enqueue("a", w("p1")); // consumes the only turn
    headless.finishNext("ok");
    coord.enqueue("a", w("p2")); // budget spent → dropped, never spawned
    expect(started.map((s) => s.prompt)).toEqual(["p1"]);
    expect(headless.calls).toEqual(["a:p1"]);
  });

  test("a warm (channel) wake is recorded on handoff and settled succeeded by the Stop hook", async () => {
    const { coord } = make();
    const { sched, started, finished } = makeRecorder();
    coord.setScheduler(sched);
    coord.onInteractiveUp("a");
    const { p } = poll(coord, "a");
    const wake = w("p1");
    coord.enqueue("a", wake);
    expect(await p).toBe("p1");
    expect(started).toEqual([{ prompt: "p1", background: false }]);
    expect(finished).toEqual([]); // the turn hasn't ended
    coord.onTurnEnded("a");
    expect(finished).toEqual([{ wakeId: wake.id, result: { outcome: "succeeded" } }]);
    coord.onTurnEnded("a"); // a later user turn: nothing outstanding, no double settle
    expect(finished).toHaveLength(1);
  });

  test("a warm wake whose session goes away before its turn ends settles stopped", async () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    coord.onInteractiveUp("a");
    const { p } = poll(coord, "a");
    const wake = w("p1");
    coord.enqueue("a", wake);
    await p;
    coord.onInteractiveDown("a");
    expect(finished).toEqual([{ wakeId: wake.id, result: { outcome: "stopped" } }]);
    expect(headless.calls).toEqual([]); // already handed off; nothing re-routes
  });

  test("StopFailure settles an outstanding warm wake as failed with the hook's category", async () => {
    const { coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    coord.onInteractiveUp("a");
    const { p } = poll(coord, "a");
    const wake = w("p1");
    coord.enqueue("a", wake);
    await p;
    coord.onTurnFailed("a", "billing");
    expect(finished).toEqual([
      {
        wakeId: wake.id,
        result: { outcome: "failed", failureReason: "api_error", failureCategory: "billing" },
      },
    ]);
    coord.onTurnEnded("a"); // nothing outstanding any more
    expect(finished).toHaveLength(1);
  });

  test("StopFailure during a headless run makes its otherwise-clean exit settle failed", () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    coord.onTurnFailed("a", "rate_limit"); // the hook lands before the child exits
    expect(finished).toEqual([]); // held until exit
    headless.finishNext("ok"); // past the fast-fail window, exit code alone says "ok"
    expect(finished).toEqual([
      {
        wakeId: wake.id,
        result: { outcome: "failed", failureReason: "api_error", failureCategory: "rate_limit" },
      },
    ]);
    // The held failure belongs to that child only: the next run starts clean.
    coord.enqueue("a", w("p2"));
    headless.finishNext("ok");
    expect(finished[1].result).toEqual({ outcome: "succeeded" });
  });

  test("StopFailure's category wins over a fast resume-fail's stderr guess", () => {
    const { headless, coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    const wake = w("p1");
    coord.enqueue("a", wake);
    coord.onTurnFailed("a", "auth");
    headless.finishNext("resumeFail", "other");
    expect(finished).toEqual([
      {
        wakeId: wake.id,
        result: { outcome: "failed", failureReason: "resume_fail", failureCategory: "auth" },
      },
    ]);
  });

  test("StopFailure with nothing outstanding is a no-op", () => {
    const { coord } = make();
    const { sched, finished } = makeRecorder();
    coord.setScheduler(sched);
    coord.onTurnFailed("a", "billing"); // a user's own turn failed; no wake involved
    expect(finished).toEqual([]);
  });

  test("a push (codex) wake is recorded once the app-server acks it", async () => {
    const { coord } = make();
    const { sched, started } = makeRecorder();
    coord.setScheduler(sched);
    const settles: Array<(ok: boolean) => void> = [];
    coord.onInteractiveUp("a", () => new Promise<boolean>((r) => settles.push(r)));
    coord.enqueue("a", w("p1"));
    expect(started).toEqual([]); // in flight, not yet accepted
    settles.shift()?.(true);
    await tick();
    expect(started).toEqual([{ prompt: "p1", background: false }]);
  });
});
