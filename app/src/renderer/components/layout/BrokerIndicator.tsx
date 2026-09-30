import { FEATURES } from "@shared/feature-flags";
import { KeyRound } from "lucide-react";
import { useBrokerStatus } from "../../hooks/useBroker";
import { useKalshiStatus } from "../../hooks/useKalshi";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const TONE: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/50",
  off: "bg-muted-foreground/50",
};

/** Footer connection status: every venue in Nightly (`FEATURES.venues`), else Robinhood. */
export function BrokerIndicator() {
  return FEATURES.venues ? <VenueIndicator /> : <RobinhoodIndicator />;
}

/** Robinhood connection status dot + label. */
function RobinhoodIndicator() {
  const s = useBrokerStatus()?.status ?? "disconnected";
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
      <span className={cn("size-2 shrink-0 rounded-full", TONE[s])} />
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * Venue connection status for the right pane footer — Robinhood and Kalshi side by
 * side — plus a shortcut into the Key Vault, where both are set up. Clicking a venue
 * switches the panel to it (or opens the vault when it isn't set up).
 */
function VenueIndicator() {
  const rh = useBrokerStatus()?.status ?? "disconnected";
  const kalshi = useKalshiStatus();
  const k = kalshi?.state ?? "off";
  const setVenue = useUIStore((s) => s.setVenue);
  const setRightTab = useUIStore((s) => s.setRightTab);
  const setView = useUIStore((s) => s.setView);

  const show = (venue: "robinhood" | "kalshi") => {
    setVenue(venue);
    setRightTab("portfolio");
  };

  const rhLabel =
    rh === "connected"
      ? "Robinhood connected"
      : rh === "connecting"
        ? "Robinhood connecting…"
        : rh === "error"
          ? "Robinhood error"
          : "Robinhood disconnected";
  const kLabel =
    k === "connected"
      ? `Kalshi connected${kalshi?.env === "demo" ? " (demo)" : ""}`
      : k === "connecting"
        ? "Kalshi connecting…"
        : k === "error"
          ? `Kalshi error: ${kalshi?.message ?? "request failed"}`
          : "Kalshi not set up";

  return (
    <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
      <Dot tone={TONE[rh]} label="Robinhood" title={rhLabel} onClick={() => show("robinhood")} />
      <Dot
        tone={TONE[k]}
        label="Kalshi"
        title={kLabel}
        onClick={() => (k === "off" ? setView("vault") : show("kalshi"))}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Open Key Vault"
            onClick={() => setView("vault")}
            className="rounded p-1 hover:bg-accent hover:text-foreground"
          >
            <KeyRound className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Key Vault</TooltipContent>
      </Tooltip>
    </div>
  );
}

function Dot({
  tone,
  label,
  title,
  onClick,
}: {
  tone: string;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex items-center gap-1.5 hover:text-foreground"
        >
          <span className={cn("size-2 shrink-0 rounded-full", tone)} />
          <span className="truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
