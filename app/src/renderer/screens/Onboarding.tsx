import { AlertTriangle, ArrowRight, Check, ExternalLink, Loader2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { FeatureShowcase } from "../components/onboarding/FeatureShowcase";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useTrackEvent } from "../hooks/useAnalytics";
import { useBrokerStatus } from "../hooks/useBroker";
import { useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type Step = "claude" | "broker" | "showcase" | "agent";
const STEPS: Step[] = ["claude", "broker", "showcase", "agent"];
const STEP_LABELS: Record<Step, string> = {
  claude: "Agent CLI",
  broker: "Robinhood",
  showcase: "Features",
  agent: "First agent",
};

/**
 * First-run wizard. Confirm an agent CLI (Claude Code / Codex) is installed, connect Robinhood
 * (optional; the panel degrades without it), show a quick feature showcase, then
 * create the first agent. Finishing (or skipping the last step) persists
 * `onboardingComplete`, which is what App.tsx gates on.
 */
export function Onboarding() {
  const [step, setStep] = useState<Step>("claude");
  const finishSettings = useUpdateSettings();
  const track = useTrackEvent();

  // The funnel starts when the wizard first mounts.
  useEffect(() => {
    track({ event: "onboarding_started" });
  }, [track]);

  const finish = () => {
    track({ event: "onboarding_completed" });
    finishSettings.mutate({ onboardingComplete: true });
  };
  const next = () => {
    track({ event: "onboarding_step_completed", props: { step } });
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
    else finish();
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <div className={cn("w-[30rem]", step === "showcase" && "w-full max-w-5xl")}>
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">OpenTrade</h1>
        </div>

        <Stepper current={step} />

        {step === "showcase" ? (
          <FeatureShowcase onNext={next} className="mt-10" />
        ) : (
          <Card className="mt-6 rounded-lg p-5">
            {step === "claude" && <ClaudeStep onNext={next} />}
            {step === "broker" && <BrokerStep onNext={next} />}
            {step === "agent" && <AgentStep onDone={finish} pending={finishSettings.isPending} />}
          </Card>
        )}

        <button
          type="button"
          onClick={finish}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Skip setup
        </button>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: Step }) {
  const currentIdx = STEPS.indexOf(current);
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-xs font-medium",
              i < currentIdx && "bg-success text-white",
              i === currentIdx && "bg-primary text-primary-foreground",
              i > currentIdx && "bg-muted text-muted-foreground",
            )}
          >
            {i < currentIdx ? <Check className="size-3.5" /> : i + 1}
          </div>
          <span
            className={cn(
              "text-xs",
              i === currentIdx ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {STEP_LABELS[s]}
          </span>
          {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ClaudeStep({ onNext }: { onNext: () => void }) {
  const probe = trpc.onboarding.harnesses.useQuery();
  const anyFound = probe.data?.claude.found || probe.data?.codex.found;

  const row = (label: string, r?: { found: boolean; version: string | null }) => (
    <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {probe.isLoading ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking…
        </span>
      ) : r?.found ? (
        <span className="flex items-center gap-2 text-success">
          <Check className="size-4" /> {r.version}
        </span>
      ) : (
        <span className="flex items-center gap-2 text-warning">
          <AlertTriangle className="size-4" /> Not found
        </span>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Terminal className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">Agent CLI</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each agent runs as a coding-agent session in an embedded terminal. At least one
            supported CLI — <code className="rounded bg-muted px-1">claude</code> or{" "}
            <code className="rounded bg-muted px-1">codex</code> — must be installed.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {row("Claude Code", probe.data?.claude)}
        {row("Codex", probe.data?.codex)}
      </div>

      {!anyFound && !probe.isLoading && (
        <p className="text-xs text-muted-foreground">
          Install Claude Code from <span className="font-mono">claude.com/code</span> or Codex from{" "}
          <span className="font-mono">developers.openai.com/codex</span>, then re-check. You can
          continue anyway, but agents won't start until one is available.
        </p>
      )}

      <div className="flex justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => probe.refetch()}
          className="text-muted-foreground"
        >
          Re-check
        </Button>
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function BrokerStep({ onNext }: { onNext: () => void }) {
  const status = useBrokerStatus();
  const utils = trpc.useUtils();
  const connect = trpc.onboarding.connectBroker.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const disconnect = trpc.broker.disconnect.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const connected = status?.status === "connected";
  // Status-driven too, not just this mutation: a consent started before a remount /
  // GUI restart is still pending in the daemon, and Settings isn't reachable from here.
  const connecting = connect.isPending || status?.status === "connecting";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Connect Robinhood to OpenTrade</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          OpenTrade keeps its own read-only Robinhood MCP session to power the portfolio panel. This
          opens a browser for a one-time login.
        </p>
      </div>

      {connected ? (
        // Same row shape as the per-CLI MCP rows below: the account identifies the
        // row on the left, the status indicator sits right.
        <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {status?.account &&
              `${status.account.agentic ? "agentic" : status.account.type} ${status.account.accountNumber}`}
          </span>
          <span className="flex items-center gap-2 text-success">
            <Check className="size-4" /> Connected
          </span>
        </div>
      ) : connecting ? (
        <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Waiting for you to approve in the browser…
          </span>
          {/* The consent can't tell the browser tab was closed; without this the daemon
              waits out its timeout and the user is stuck here. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          onClick={() => connect.mutate()}
          className="justify-center gap-2 py-2"
        >
          Connect Robinhood
        </Button>
      )}

      {connect.isError && !connecting && (
        <p className="text-xs text-destructive">Connection failed. You can try again.</p>
      )}

      <RobinhoodMcpCheck />

      {/* Continue is NEVER gated — not on the broker session, not on the MCP check.
          Both are advisory; the wizard always lets the user move on. */}
      <div className="flex justify-end">
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Step 2's second half: is Robinhood's Agentic Trading MCP registered in the agent
 * CLIs' configs? The broker connection above only powers OpenTrade's own portfolio
 * panel — the *agents* trade through this MCP, so a missing one is the difference
 * between an agent that can trade and one that silently can't.
 *
 * This reads the CLI config files, so it answers "registered", not "authenticated";
 * the OAuth consent still happens on the user's first `/mcp` inside the CLI.
 */
function RobinhoodMcpCheck() {
  const mcp = trpc.onboarding.robinhoodMcp.useQuery();

  const clis = [
    { label: "Claude Code", ...mcp.data?.claude },
    { label: "Codex", ...mcp.data?.codex },
  ];
  // Gated on a settled query: mid-load every `configured` is undefined, which
  // would flash the link block before we know anything is actually missing.
  const anyMissing = !mcp.isLoading && clis.some((c) => !c.configured);

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Connect Robinhood to your agents</h3>
      <p className="text-sm text-muted-foreground">
        Agents place orders through Robinhood's Agentic Trading MCP. Install it for each agent you
        plan to use.
      </p>

      <div className="flex flex-col gap-2">
        {clis.map((c) => (
          <div
            key={c.label}
            className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">{c.label}</span>
            {/* Explicit loading state: an undefined `configured` would otherwise
                flash a false "Not configured" before the first result lands. */}
            {mcp.isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Checking…
              </span>
            ) : c.configured ? (
              // Reads "Connected" by product choice; the underlying check is config
              // presence, so this is optimistic — a registered-but-unauthorized MCP
              // shows green. See `robinhood-mcp.ts`.
              <span className="flex items-center gap-2 text-success">
                <Check className="size-4" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-2 text-warning">
                <AlertTriangle className="size-4" /> Not configured
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Robinhood owns the setup steps — we link their guide rather than restating
          commands here, which would rot the moment either CLI changes its syntax. */}
      {anyMissing && (
        <a
          href={mcp.data?.connectUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          How to connect your AI agent <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

function AgentStep({ onDone, pending }: { onDone: () => void; pending: boolean }) {
  const [name, setName] = useState("My first agent");
  const select = useUIStore((s) => s.select);
  const settings = trpc.settings.get.useQuery();
  const create = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      select(agent.id);
      onDone();
    },
  });

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    create.mutate({
      name: trimmed,
      template: "default",
      approvalMode: settings.data?.defaultApprovalMode ?? "approve",
    });
  };

  const busy = create.isPending || pending;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Create your first agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The agent opens a session in its own folder and interviews you about your goals.
          Order-placing tools require your approval by default.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-agent-name">Name</Label>
        <Input
          id="onboarding-agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          maxLength={80}
          className="px-2"
        />
      </div>

      {create.isError && <p className="text-xs text-destructive">Couldn't create the agent.</p>}

      <div className="flex justify-end">
        <Button type="button" onClick={submit} disabled={busy || !name.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Create agent
        </Button>
      </div>
    </div>
  );
}
