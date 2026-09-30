import type { KalshiStatus } from "@shared/kalshi";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

/** OpenTrade's read-only view of the Kalshi account (right panel + footer indicator). */
export const kalshiRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.kalshi.getStatus()),
  portfolio: publicProcedure.query(({ ctx }) => ctx.kalshi.getPortfolio()),
  /** Recent orders in the shared ledger shape — Activity joins them by order id. */
  orders: publicProcedure.query(({ ctx }) => ctx.kalshi.getOrders()),

  refresh: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.kalshi.pollOnce();
    return ctx.kalshi.getStatus();
  }),

  onUpdated: publicProcedure.subscription(() =>
    observable<{ at: number }>((emit) => {
      const off = bus.onEvent("kalshi:updated", (p) => emit.next(p));
      return () => off();
    }),
  ),

  onStatus: publicProcedure.subscription(({ ctx }) =>
    observable<KalshiStatus>((emit) => {
      emit.next(ctx.kalshi.getStatus());
      const off = bus.onEvent("kalshi:status", (s) => emit.next(s));
      return () => off();
    }),
  ),
});
