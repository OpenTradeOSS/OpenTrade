import { NewAgentDialog } from "./components/agents/NewAgentDialog";
import { AgentSidebar } from "./components/layout/AgentSidebar";
import { RightPanel } from "./components/layout/RightPanel";
import { TerminalPane } from "./components/terminal/TerminalPane";
import { useAgents } from "./hooks/useAgents";
import { useSettings } from "./hooks/useSettings";
import { useShortcuts } from "./hooks/useShortcuts";
import { useShellSelection } from "./lib/shell";
import { backendStarted } from "./lib/trpc";
import { cn } from "./lib/utils";
import { BackendFailed } from "./screens/BackendFailed";
import { Onboarding } from "./screens/Onboarding";
import { ScheduledScreen } from "./screens/Scheduled";
import { SettingsScreen } from "./screens/Settings";
import { useConnectionStore } from "./stores/connection";
import { useUIStore } from "./stores/ui";

export function App() {
  const agents = useAgents();
  const selectedId = useUIStore((s) => s.selectedAgentId);
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const view = useUIStore((s) => s.view);
  const settings = useSettings();
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const backendConnected = useConnectionStore((s) => s.backendConnected);

  // ⌘T opens the New Agent configuration dialog (create happens from the form).
  // Gated off while the backend is down to match the disabled New Agent button.
  useShortcuts({ "create-agent": backendConnected ? openNewAgent : () => {} });

  // A click on an agent in the macOS menu bar item (launcher-side) selects it here.
  useShellSelection();

  // The launcher couldn't bring up the backend host (trpcPort===0), so nothing can
  // ever load — show the restart screen instead of hanging on a blank background.
  if (!backendStarted) return <BackendFailed />;

  // Wait for settings to load before deciding what to show, so the three-pane
  // doesn't flash before the onboarding gate resolves.
  if (!settings.data) return <div className="h-full w-full bg-background" />;
  if (!settings.data.onboardingComplete) return <Onboarding />;

  // The agent panes stay mounted (just hidden) while Settings is open so the live
  // terminal/WebSocket survives the switch — see lib/terminal/session-controller.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        <AgentSidebar />
        <div className={cn("flex flex-1 min-w-0", view !== "agents" && "hidden")}>
          <TerminalPane agent={selected} />
          <RightPanel />
        </div>
        {view === "scheduled" && <ScheduledScreen />}
        {view === "settings" && <SettingsScreen />}
      </div>
      <NewAgentDialog />
    </div>
  );
}
