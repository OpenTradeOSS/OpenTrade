import { trpc } from "../lib/trpc";

/** All cron schedules + monitors across every agent, live via the onChanged subscription. */
export function useSchedules() {
  const utils = trpc.useUtils();
  const query = trpc.schedule.listAll.useQuery();

  trpc.schedule.onChanged.useSubscription(undefined, {
    onData: () => utils.schedule.listAll.invalidate(),
  });

  return query.data ?? { schedules: [], monitors: [] };
}

/**
 * One agent's schedules/monitors (retired included — the panel filters `enabled` for
 * Active and resolves History rows' triggers from the same arrays) + recorded wakes for
 * the Monitor tab, live via the same `scheduler:changed` subscription. No-ops until an
 * agent is selected.
 */
export function useMonitor(agentId?: string) {
  const utils = trpc.useUtils();
  const query = trpc.schedule.forAgent.useQuery({ agentId: agentId ?? "" }, { enabled: !!agentId });

  trpc.schedule.onChanged.useSubscription(undefined, {
    onData: (d) => {
      if (agentId && (d.agentId === null || d.agentId === agentId))
        utils.schedule.forAgent.invalidate({ agentId });
    },
  });

  return query.data ?? { schedules: [], monitors: [], wakes: [] };
}
