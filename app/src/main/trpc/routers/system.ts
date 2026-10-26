import { observable } from "@trpc/server/observable";
import { OPENTRADE_HOME } from "../../db/client";
import { readClaudeRetention } from "../../services/claude-config";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const systemRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, at: Date.now() })),

  /** App metadata for the About settings panel. The backend runs headless under
   *  ELECTRON_RUN_AS_NODE (no `app`), so the launcher passes the version via env. */
  appInfo: publicProcedure.query(() => ({
    version: process.env.OPENTRADE_VERSION ?? "dev",
    platform: process.platform,
    home: OPENTRADE_HOME,
  })),

  /** Claude Code's transcript retention (`cleanupPeriodDays`, default 30). Agents
   *  resume via those transcripts, so this is effectively how long an idle agent keeps
   *  its memory — surfaced in Settings so the user can extend it. */
  claudeRetention: publicProcedure.query(() => readClaudeRetention()),

  /** Observable subscription proving IPC subscriptions stream end to end. */
  tick: publicProcedure.subscription(() =>
    observable<{ at: number }>((emit) => {
      const off = bus.onEvent("system:tick", (p) => emit.next(p));
      return () => off();
    }),
  ),
});
