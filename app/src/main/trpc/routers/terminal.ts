import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const terminalRouter = router({
  /** Open (first run) or attach the agent's persistent Claude Code session. */
  openOrAttach: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
        cols: z.number().optional(),
        rows: z.number().optional(),
        // `attach` never spawns — the post-respawn reconnect, which must not
        // relaunch a dead session as a resume (that re-armed the respawn loop).
        intent: z.enum(["auto", "resume", "attach"]).default("auto"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = ctx.registry.get(input.agentId);
      if (!agent) throw new Error("agent not found");
      return ctx.terminal.openOrAttach(agent, input.cols, input.rows, input.intent);
    }),

  /**
   * The WebSocket URL the renderer connects to for this agent's live terminal
   * (output stream + input/resize). Control plane only — the byte stream never
   * touches tRPC/IPC. Call AFTER openOrAttach so the session exists.
   */
  wsEndpoint: publicProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const url = await ctx.terminal.wsEndpointFor(input.agentId);
      return { url };
    }),

  kill: publicProcedure.input(z.object({ agentId: z.string() })).mutation(({ ctx, input }) => {
    ctx.terminal.kill(input.agentId);
    return { ok: true };
  }),

  /** EC1 "Stop task": cancel an in-progress headless scheduled run for the agent. */
  stopHeadlessRun: publicProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(({ ctx, input }) => ({ stopped: ctx.wake.stop(input.agentId) })),

  /** EC13 "Restart": start a fresh session for a broken (unresumable) agent. */
  restart: publicProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(({ ctx, input }) => ctx.terminal.restart(input.agentId)),

  /**
   * Fires when a dead session was transparently restarted with a fresh `claude`
   * (e.g. a `--resume` that had nothing to resume). The renderer reattaches
   * the focused agent so the new session streams in without a manual Resume.
   */
  onRespawn: publicProcedure.subscription(() =>
    observable<{ agentId: string }>((emit) => {
      const off = bus.onEvent("terminal:respawned", (payload) => emit.next(payload));
      return () => off();
    }),
  ),
});
