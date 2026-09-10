import { z } from "zod";

/**
 * Durable autonomy primitives owned by the backend scheduler. These mirror Claude
 * Code's native `CronCreate`/`Monitor` surface but survive the GUI closing and the
 * host restarting — the agent programs them through the `opentrade` MCP server, and
 * the backend wakes the agent when they fire (warm: a `claude/channel` inject into the
 * live PTY if the GUI is open; else cold: a headless `claude --resume -p` run).
 */

/**
 * A 5-field cron schedule interpreted by `croner` in `timezone`, the machine's IANA
 * zone when it was created (null only on pre-v6 rows not yet backfilled). The zone is
 * host-owned and user-facing: the agent's view of a schedule omits it.
 */
export const Schedule = z.object({
  id: z.string(),
  agentId: z.string(),
  cronExpr: z.string(),
  timezone: z.string().nullable(),
  prompt: z.string(),
  recurring: z.boolean(),
  enabled: z.boolean(),
  /** Advisory; recomputed from `cronExpr` on host start. */
  nextFireAt: z.number().nullable(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Schedule = z.infer<typeof Schedule>;

/** A supervised backend process whose stdout lines are wake triggers. */
export const Monitor = z.object({
  id: z.string(),
  agentId: z.string(),
  command: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Monitor = z.infer<typeof Monitor>;

/** One recorded autonomy wake — a cron firing or a monitor trigger. */
export const Wake = z.object({
  id: z.string(),
  agentId: z.string(),
  sourceKind: z.enum(["cron", "monitor"]),
  /** Id of the originating schedule/monitor (joined with `sourceKind`); null for
   *  wakes recorded before this link existed. */
  sourceId: z.string().nullable(),
  prompt: z.string(),
  /** Delivered headlessly (no live interactive session) vs warm via the channel. */
  background: z.boolean(),
  firedAt: z.number(),
});
export type Wake = z.infer<typeof Wake>;

// ---- inputs (used by the MCP tools / LocalApi CRUD) ----

export const CronCreateInput = z.object({
  cron: z.string().min(1),
  prompt: z.string().min(1),
  recurring: z.boolean().default(true),
});
export type CronCreateInput = z.infer<typeof CronCreateInput>;

export const MonitorCreateInput = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
});
export type MonitorCreateInput = z.infer<typeof MonitorCreateInput>;
