import { Cron } from "croner";

/**
 * Thin wrapper over `croner` holding one live timer per schedule id. 5-field cron
 * expressions, each evaluated in the IANA timezone passed to `arm` (so DST shifts in
 * that zone are handled by the library). Recurring schedules run forever; one-shot
 * schedules use `maxRuns: 1` and croner auto-stops them after the single occurrence.
 */
export class CronTimer {
  private jobs = new Map<string, Cron>();

  /**
   * Arm (or re-arm) a schedule in `timezone`. `onFire` runs on each occurrence.
   * Returns the next fire time in epoch-ms, or null if the expression never fires again.
   */
  arm(
    id: string,
    cronExpr: string,
    timezone: string,
    recurring: boolean,
    onFire: () => void,
  ): number | null {
    this.disarm(id);
    const job = new Cron(cronExpr, recurring ? { timezone } : { timezone, maxRuns: 1 }, onFire);
    this.jobs.set(id, job);
    return job.nextRun()?.getTime() ?? null;
  }

  nextRun(id: string): number | null {
    return this.jobs.get(id)?.nextRun()?.getTime() ?? null;
  }

  disarm(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
  }

  disarmAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Validate a cron expression (and that it has a future occurrence) without arming it. */
  static isValid(cronExpr: string): boolean {
    try {
      const c = new Cron(cronExpr, { paused: true });
      const ok = c.nextRun() !== null;
      c.stop();
      return ok;
    } catch {
      return false;
    }
  }
}
