import type { BrokerConnectionStatus } from "@shared/broker";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const brokerRouter = router({
  connectionStatus: publicProcedure.query(({ ctx }) => ({
    status: ctx.broker.getStatus(),
    account: ctx.broker.getAccount(),
  })),

  portfolio: publicProcedure.query(({ ctx }) => ctx.broker.getCachedPortfolio()),
  positions: publicProcedure.query(({ ctx }) => ctx.broker.getCachedPositions()),
  optionPositions: publicProcedure.query(({ ctx }) => ctx.broker.getCachedOptionPositions()),
  cryptoPositions: publicProcedure.query(({ ctx }) => ctx.broker.getCachedCryptoPositions()),
  /** The agentic order ledger from RH — source of truth for execution status. */
  agenticOrders: publicProcedure.query(({ ctx }) => ctx.broker.getAgenticOrdersCached()),

  quote: publicProcedure
    .input(z.object({ symbol: z.string(), maxAgeMs: z.number().default(5000) }))
    .query(({ ctx, input }) => ctx.broker.getQuote(input.symbol, input.maxAgeMs)),

  /** Reset/Disconnect: abandon a pending consent, forget the session (§6.6). */
  disconnect: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.disconnect();
    return { status: ctx.broker.getStatus() };
  }),

  refreshNow: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.getPositionsLive(0);
    return { ok: true };
  }),

  /** Force a full-history order sweep; resolves once the ledger is rebuilt. */
  refreshOrders: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.refreshOrders();
    return { ok: true };
  }),

  /** The GUI relays its window focus so the host polls at the fast cadence only
   *  while someone is watching; with no GUI it stays on the blurred cadence. */
  setFocused: publicProcedure
    .input(z.object({ focused: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.broker.setFocused(input.focused);
      return { ok: true };
    }),

  /** Fires when any cache key updates; payload is which keys changed. */
  onUpdated: publicProcedure.subscription(() =>
    observable<{ keys: string[] }>((emit) => {
      const off = bus.onEvent("broker:updated", (p) => emit.next(p));
      return () => off();
    }),
  ),

  onStatus: publicProcedure.subscription(({ ctx }) =>
    observable<{ status: BrokerConnectionStatus }>((emit) => {
      emit.next({ status: ctx.broker.getStatus() });
      const off = bus.onEvent("broker:status", (p) => emit.next(p));
      return () => off();
    }),
  ),
});
