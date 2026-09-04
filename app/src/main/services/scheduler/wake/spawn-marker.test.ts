import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionState } from "@shared/agent";
import type { AgentRegistry } from "../../agents/registry";
import {
  clearSpawnMarker,
  readSpawnMarkers,
  reconcileSpawnMarkers,
  type SpawnMarker,
  writeSpawnMarker,
} from "./spawn-marker";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Minimal AgentRegistry stand-in: only the surface reconcile touches. */
class FakeRegistry {
  agents = new Map<string, "claude" | "codex">();
  states = new Map<string, ExecutionState>();
  add(id: string, harness: "claude" | "codex" = "claude") {
    this.agents.set(id, harness);
  }
  get(id: string) {
    const harness = this.agents.get(id);
    return harness ? ({ id, harness } as ReturnType<AgentRegistry["get"]>) : undefined;
  }
  setExecutionState(id: string, s: ExecutionState): void {
    this.states.set(id, s);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wake-runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const marker = (over: Partial<SpawnMarker> = {}): SpawnMarker => ({
  agentId: "a1",
  pid: 999999,
  sessionId: "sess-1",
  startedAt: 1,
  ...over,
});

describe("spawn-marker", () => {
  test("write / read / clear round-trip", () => {
    expect(readSpawnMarkers(dir)).toEqual([]);
    writeSpawnMarker(marker(), dir);
    expect(readSpawnMarkers(dir)).toEqual([marker()]);
    clearSpawnMarker("a1", dir);
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("readSpawnMarkers on a missing dir returns []", () => {
    expect(readSpawnMarkers(join(dir, "nope"))).toEqual([]);
  });

  test("clearSpawnMarker is idempotent", () => {
    expect(() => clearSpawnMarker("ghost", dir)).not.toThrow();
  });

  test("reconcile marks broken + clears for a dead-pid marker (no orphan to kill)", () => {
    const reg = new FakeRegistry();
    reg.add("a1");
    writeSpawnMarker(marker({ pid: 999999 }), dir); // pid not alive
    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);
    expect(reg.states.get("a1")).toBe("broken");
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("reconcile SIGTERMs a live orphan, then marks broken + clears", async () => {
    const reg = new FakeRegistry();
    reg.add("a2");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    await wait(20); // let it come up
    expect(child.pid && isAlive(child.pid)).toBe(true);
    writeSpawnMarker(marker({ agentId: "a2", pid: child.pid ?? 0 }), dir);

    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);

    expect(reg.states.get("a2")).toBe("broken");
    expect(readSpawnMarkers(dir)).toEqual([]);
    await wait(50);
    expect(child.pid && isAlive(child.pid)).toBe(false); // orphan was killed
  });

  test("reconcile treats a pid<=0 marker as dead — never SIGTERMs the host's own group (B1)", () => {
    // A marker written before the server started could carry pid 0. `process.kill(0, …)`
    // targets the CALLER's process group, so a naive isAlive(0)+kill would take down the
    // new host at boot. Reconcile must treat pid<=0 as dead: mark broken, clear, no kill.
    // (This test surviving — the runner isn't SIGTERM'd — is itself the proof.)
    const reg = new FakeRegistry();
    reg.add("z0");
    writeSpawnMarker(marker({ agentId: "z0", pid: 0 }), dir);
    expect(() => reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir)).not.toThrow();
    expect(reg.states.get("z0")).toBe("broken");
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("a codex agent recovers to offline (its thread is resumable), not broken", () => {
    const reg = new FakeRegistry();
    reg.add("cx", "codex");
    writeSpawnMarker(marker({ agentId: "cx", pid: 999999 }), dir);
    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);
    expect(reg.states.get("cx")).toBe("offline"); // resumable → no forced fresh Restart
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("reconcile clears a marker for an unknown agent without marking it", () => {
    const reg = new FakeRegistry(); // a3 not registered (archived/deleted)
    writeSpawnMarker(marker({ agentId: "a3", pid: 999999 }), dir);
    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);
    expect(reg.states.has("a3")).toBe(false);
    expect(readSpawnMarkers(dir)).toEqual([]);
  });
});
