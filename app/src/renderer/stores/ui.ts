import { create } from "zustand";

export type RightTab = "portfolio" | "activity" | "monitor";
/** What the Portfolio tables' last column shows. Cycled by clicking the column header. */
export type PositionsMetric = "pnl" | "pct" | "value";
/** Top-level pane: the agent workspace, the full-screen Scheduled view, or Settings. */
export type AppView = "agents" | "scheduled" | "settings";

interface UIState {
  selectedAgentId: string | null;
  rightTab: RightTab;
  view: AppView;
  /** Whether the New Agent configuration dialog is open. */
  newAgentOpen: boolean;
  /** Hide dollar balances in the Portfolio pane (masked as ****). Session-only. */
  balancesHidden: boolean;
  /** Last column of the Equities/Options tables: P&L $ / % gain / market value. Session-only. */
  positionsMetric: PositionsMetric;
  select: (id: string | null) => void;
  setRightTab: (tab: RightTab) => void;
  setView: (view: AppView) => void;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  toggleBalances: () => void;
  cyclePositionsMetric: () => void;
}

const METRIC_CYCLE: Record<PositionsMetric, PositionsMetric> = {
  pnl: "pct",
  pct: "value",
  value: "pnl",
};

export const useUIStore = create<UIState>((set) => ({
  selectedAgentId: null,
  rightTab: "portfolio",
  view: "agents",
  newAgentOpen: false,
  balancesHidden: false,
  positionsMetric: "pnl",
  select: (id) => set({ selectedAgentId: id }),
  setRightTab: (tab) => set({ rightTab: tab }),
  setView: (view) => set({ view }),
  openNewAgent: () => set({ newAgentOpen: true }),
  closeNewAgent: () => set({ newAgentOpen: false }),
  toggleBalances: () => set((s) => ({ balancesHidden: !s.balancesHidden })),
  cyclePositionsMetric: () => set((s) => ({ positionsMetric: METRIC_CYCLE[s.positionsMetric] })),
}));
