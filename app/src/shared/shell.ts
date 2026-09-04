/**
 * Wire contract for the "shell" bridge between the Electron MAIN process and the
 * renderer — main-process UI chrome that needs to steer the renderer. Today that
 * is the desktop status item (§12.6): clicking an agent in the tray menu opens the
 * window *and* selects that agent. Like the updater bridge (`shared/updater.ts`),
 * this is main-process state (the tray lives in the launcher, not the host), so it
 * rides `ipcRenderer` rather than tRPC.
 *
 * Delivery is push + pull because the window may not exist yet when the click
 * lands: main pushes `selectAgent` to a live renderer, and a freshly created
 * renderer pulls any selection that was requested before it mounted.
 */
export const SHELL_IPC = {
  /** main → renderer push: select this agent (and switch to the agents view). */
  selectAgent: "shell:selectAgent",
  /** invoke → the agent id requested before the renderer mounted (consumed on read), or null. */
  takePendingAgent: "shell:takePendingAgent",
  /** invoke → full quit: terminate the backend host, then exit the launcher (§12.6).
   *  A launcher action (it owns the host pid + its own exit), so it rides this
   *  bridge — the Settings button and the tray row share one main-process path. */
  quitCompletely: "shell:quitCompletely",
} as const;
