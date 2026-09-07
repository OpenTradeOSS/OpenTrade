import { FeedbackInput } from "@shared/feedback";
import { analytics } from "../../services/analytics";
import { buildDiagnostics, cliVersionOf } from "../../services/feedback/diagnostics";
import { harnessFor } from "../../services/harness";
import { buildAgentEnv } from "../../services/terminal/env";
import { publicProcedure, router } from "../trpc";

/** The in-app feedback form's backend (§12.8). */
export const feedbackRouter = router({
  available: publicProcedure.query(() => ({ available: analytics.feedbackAvailable })),

  send: publicProcedure.input(FeedbackInput).mutation(async ({ ctx, input }) => {
    let diagnostics = null;
    if (input.includeDiagnostics) {
      // Same PATH agents get, so the CLIs are found wherever they live.
      const env = buildAgentEnv("feedback");
      const [claude, codex] = await Promise.all([
        harnessFor("claude").probe(env),
        harnessFor("codex").probe(env),
      ]);
      diagnostics = buildDiagnostics({
        agents: ctx.registry.list(),
        crons: ctx.scheduler.listAllCron().length,
        monitors: ctx.scheduler.listAllMonitors().length,
        brokerStatus: ctx.broker.getStatus(),
        brokerAuthorized: ctx.broker.isAuthorized(),
        portfolioFetchedAt: ctx.broker.getCachedPortfolio()?.fetchedAt ?? null,
        pendingApprovals: ctx.approvals.pendingCount(),
        settings: ctx.settings.get(),
        claudeVersion: cliVersionOf(claude),
        codexVersion: cliVersionOf(codex),
      });
    }
    return analytics.sendFeedback(input, diagnostics);
  }),
});
