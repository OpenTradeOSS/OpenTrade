import { useBrokerStatus } from "../../hooks/useBroker";
import { cn } from "../../lib/utils";

const BROKER_TONE: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/50",
};

/** Robinhood connection status dot + label (lives in the right pane footer). */
export function BrokerIndicator() {
  const status = useBrokerStatus();
  const s = status?.status ?? "disconnected";
  const label =
    s === "connected"
      ? "Robinhood connected"
      : s === "connecting"
        ? "Connecting…"
        : s === "error"
          ? "Robinhood error"
          : "Robinhood disconnected";
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={cn("size-2 shrink-0 rounded-full", BROKER_TONE[s])} />
      <span className="truncate">{label}</span>
    </div>
  );
}
