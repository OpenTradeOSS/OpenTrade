import type { Monitor, Schedule, Wake } from "@shared/schedule";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const scheduleRouter = router({
  /** Every cron schedule and monitor across all agents, for the Scheduled view. */
  listAll: publicProcedure.query(({ ctx }) => ({
    schedules: ctx.scheduler.listAllCron(),
    monitors: ctx.scheduler.listAllMonitors(),
  })),

  /** One agent's schedules/monitors (**retired included** — the panel filters `enabled`
   *  for its Active list and resolves History rows' triggers from the same arrays) +
   *  its recorded wakes, for the Monitor tab. */
  forAgent: publicProcedure.input(z.object({ agentId: z.string() })).query(({ ctx, input }) => ({
    ...ctx.scheduler.listTriggers(input.agentId),
    wakes: ctx.scheduler.listWakes(input.agentId),
  })),

  onChanged: publicProcedure.subscription(() =>
    observable<{ agentId: string | null }>((emit) => {
      // Emit on (re)subscribe so the renderer refetches after a WS reconnect
      // (host restart) — matches activity/agents onChanged.
      emit.next({ agentId: null });
      const off = bus.onEvent("scheduler:changed", (p) => emit.next(p));
      return () => off();
    }),
  ),
});

// Re-exported for renderer typing convenience.
export type { Monitor, Schedule, Wake };
