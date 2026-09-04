import { describe, expect, test } from "bun:test";
import { MonitorRunner } from "./monitor-runner";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MonitorRunner", () => {
  test("each stdout line is a trigger, rate-limited to one per window", async () => {
    const triggers: string[] = [];
    const runner = new MonitorRunner({
      command: `"${process.execPath}" -e "console.log('first'); console.log('second'); setTimeout(() => {}, 5000)"`,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onTrigger: (line) => triggers.push(line),
      rateLimitMs: 1000,
    });
    runner.start();
    await wait(250);
    runner.stop();
    // "first" fires; "second" arrives within the rate-limit window → suppressed.
    expect(triggers).toEqual(["first"]);
  });

  test("blank lines never trigger", async () => {
    const triggers: string[] = [];
    const runner = new MonitorRunner({
      command: `"${process.execPath}" -e "console.log(''); console.log('   '); setTimeout(() => {}, 5000)"`,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      onTrigger: (line) => triggers.push(line),
      rateLimitMs: 10,
    });
    runner.start();
    await wait(200);
    runner.stop();
    expect(triggers).toEqual([]);
  });
});
