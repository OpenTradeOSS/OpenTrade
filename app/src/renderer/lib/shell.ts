import { useEffect } from "react";
import { useUIStore } from "../stores/ui";

/**
 * Renderer side of the main-process shell bridge (`window.__opentradeShell`, exposed
 * by the preload; contract in shared/shell.ts). The desktop status item (§12.6) lives
 * in the launcher; when the user clicks an agent there, main opens/focuses the window
 * and asks us to select that agent. Two paths: a push for an already-mounted renderer,
 * and a pull on mount for the case where the click created the window (the push would
 * have landed before this effect subscribed).
 */
declare global {
  interface Window {
    __opentradeShell?: {
      takePendingAgent: () => Promise<string | null>;
      onSelectAgent: (cb: (agentId: string) => void) => () => void;
      quitCompletely: () => Promise<void>;
    };
  }
}

export function useShellSelection(): void {
  const select = useUIStore((s) => s.select);
  const setView = useUIStore((s) => s.setView);

  useEffect(() => {
    const bridge = window.__opentradeShell;
    if (!bridge) return;
    const apply = (agentId: string) => {
      select(agentId);
      setView("agents");
    };
    let alive = true;
    bridge.takePendingAgent().then((id) => {
      if (alive && id) apply(id);
    });
    const unsubscribe = bridge.onSelectAgent(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [select, setView]);
}
