import { type AgentIntegrations, DEFAULT_AGENT_INTEGRATIONS } from "@shared/vault";

/**
 * Process-wide view of which optional integrations agents get, read by the harness
 * config writers (`writeConfig`, before every spawn) and `buildAgentEnv`. Those are
 * module-level functions called from many places, so rather than thread the vault
 * through every call site the host registers it here once at boot. Until then (and in
 * tests) agents get the pre-vault behavior: Robinhood only, no extra env.
 */
export interface IntegrationSource {
  agentIntegrations(): AgentIntegrations;
  /** Env vars agents need for the enabled integrations (e.g. `PMXT_API_KEY`). */
  agentEnv(): Record<string, string>;
}

const FALLBACK: IntegrationSource = {
  agentIntegrations: () => DEFAULT_AGENT_INTEGRATIONS,
  agentEnv: () => ({}),
};

let source: IntegrationSource = FALLBACK;

export function setIntegrationSource(next: IntegrationSource | null): void {
  source = next ?? FALLBACK;
}

export function agentIntegrations(): AgentIntegrations {
  return source.agentIntegrations();
}

export function integrationEnv(): Record<string, string> {
  return source.agentEnv();
}
