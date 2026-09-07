import { useApprovals } from "../../hooks/useApprovals";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connection";
import { type RightTab, useUIStore } from "../../stores/ui";
import { FeedbackButton } from "../feedback/FeedbackButton";
import { Activity } from "../panels/Activity";
import { MarketClock } from "../panels/MarketClock";
import { MonitorPanel } from "../panels/Monitor";
import { Portfolio } from "../panels/Portfolio";
import { Badge } from "../ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { BrokerIndicator } from "./BrokerIndicator";

const TABS: { id: RightTab; label: string }[] = [
  { id: "portfolio", label: "Portfolio" },
  { id: "activity", label: "Activity" },
  { id: "monitor", label: "Monitor" },
];

export function RightPanel() {
  const rightTab = useUIStore((s) => s.rightTab);
  const setRightTab = useUIStore((s) => s.setRightTab);
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  const { pending } = useApprovals();

  // A new order needing approval pulls the panel to the Activity tab (the pending
  // queue now lives at the top of Activity).
  trpc.approvals.onPending.useSubscription(undefined, {
    onData: () => setRightTab("activity"),
  });

  // Backend down: the pane data is stale and its actions can't reach the host, so
  // grey it out + block interaction. The tab bar above stays live for nav.
  const greyed = backendConnected ? undefined : "pointer-events-none opacity-50";

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-card">
      <div className="h-10 shrink-0" style={{ WebkitAppRegion: "drag" } as never} />
      <MarketClock />

      <Tabs
        value={rightTab}
        onValueChange={(v) => setRightTab(v as RightTab)}
        className="min-h-0 flex-1"
      >
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
              {tab.id === "activity" && pending.length > 0 && (
                <Badge
                  variant="destructive"
                  className="min-w-4 rounded-full px-1 text-[10px] font-semibold leading-4"
                >
                  {pending.length}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="portfolio" className={cn(greyed)}>
          <Portfolio />
        </TabsContent>
        <TabsContent value="activity" className={cn(greyed)}>
          <Activity />
        </TabsContent>
        <TabsContent value="monitor" className={cn(greyed)}>
          <MonitorPanel />
        </TabsContent>
      </Tabs>

      <div className="flex shrink-0 items-center justify-between px-4 py-2">
        <BrokerIndicator />
        <FeedbackButton />
      </div>
    </div>
  );
}
