import {
  IntegrationId,
  PMXT_KEY_ENV,
  SaveHyperliquidInput,
  SaveKalshiInput,
  SaveKeyInput,
  type VaultStatus,
} from "@shared/vault";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { testPmxtKey } from "../../services/venues/pmxt";
import { publicProcedure, router } from "../trpc";

/**
 * The Key Vault (sidebar screen + onboarding step). Secrets only flow IN: every
 * response is a `VaultStatus` (hints, never keys).
 */
export const vaultRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.vault.status()),

  // ---- venues ----
  saveKalshi: publicProcedure
    .input(SaveKalshiInput)
    .mutation(({ ctx, input }) => ctx.vault.saveKalshi(input)),

  removeKalshi: publicProcedure.mutation(({ ctx }) => ctx.vault.removeKalshi()),

  /** Resolves the account on Hyperliquid and verifies the key is an API wallet first. */
  saveHyperliquid: publicProcedure
    .input(SaveHyperliquidInput)
    .mutation(({ ctx, input }) => ctx.hyperliquid.save(input)),

  removeHyperliquid: publicProcedure.mutation(({ ctx }) => ctx.vault.removeHyperliquid()),

  /** Prove the stored key is still an approved API wallet for the account. */
  testHyperliquid: publicProcedure.mutation(({ ctx }) => ctx.hyperliquid.test()),

  setEnabled: publicProcedure
    .input(z.object({ id: IntegrationId, enabled: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.vault.setEnabled(input.id, input.enabled)),

  /** Prove the stored Kalshi key works (an authenticated balance read). */
  testKalshi: publicProcedure.mutation(({ ctx }) => ctx.kalshi.test()),

  // ---- API keys (any number; each becomes an agent env var) ----
  saveKey: publicProcedure
    .input(SaveKeyInput)
    .mutation(({ ctx, input }) => ctx.vault.saveKey(input)),

  removeKey: publicProcedure
    .input(z.object({ envVar: z.string().min(1).max(100) }))
    .mutation(({ ctx, input }) => ctx.vault.removeKey(input.envVar)),

  /** Live check for keys the vault recognizes (PMXT today). */
  testKey: publicProcedure
    .input(z.object({ envVar: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const value = ctx.vault.keyValue(input.envVar);
      if (!value) return { ok: false, message: "No such key." };
      if (input.envVar === PMXT_KEY_ENV) return testPmxtKey(value);
      return { ok: false, message: "No live check for this key." };
    }),

  onChanged: publicProcedure.subscription(() =>
    observable<VaultStatus>((emit) => {
      const off = bus.onEvent("vault:changed", (s) => emit.next(s));
      return () => off();
    }),
  ),
});
