import type { HyperliquidStatus } from "@shared/hyperliquid";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

/** OpenTrade's read-only view of the Hyperliquid account (right panel + footer indicator). */
export const hyperliquidRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.hyperliquid.getStatus()),
  portfolio: publicProcedure.query(({ ctx }) => ctx.hyperliquid.getPortfolio()),
  /** Recent orders in the shared ledger shape — Activity joins them by order id. */
  orders: publicProcedure.query(({ ctx }) => ctx.hyperliquid.getOrders()),

  refresh: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.hyperliquid.pollOnce();
    return ctx.hyperliquid.getStatus();
  }),

  onUpdated: publicProcedure.subscription(() =>
    observable<{ at: number }>((emit) => {
      const off = bus.onEvent("hyperliquid:updated", (p) => emit.next(p));
      return () => off();
    }),
  ),

  onStatus: publicProcedure.subscription(({ ctx }) =>
    observable<HyperliquidStatus>((emit) => {
      emit.next(ctx.hyperliquid.getStatus());
      const off = bus.onEvent("hyperliquid:status", (s) => emit.next(s));
      return () => off();
    }),
  ),
});
