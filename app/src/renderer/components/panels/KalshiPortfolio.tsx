import { type KalshiPosition, kalshiMarketUrl } from "@shared/kalshi";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { useAgents } from "../../hooks/useAgents";
import { useKalshiPortfolio, useKalshiStatus } from "../../hooks/useKalshi";
import { ago, num, signedUsd, usd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { MASK, MetricCell, MetricHead, Row, SectionHeader } from "./Portfolio";

/** The agents' Kalshi positions value, for the "All" view's combined value. */
export function useKalshiTotal(): { state: string; connected: boolean; total: number | null } {
  const status = useKalshiStatus();
  const portfolio = useKalshiPortfolio();
  const state = status?.state ?? "off";
  return { state, connected: state === "connected", total: portfolio?.positionsValue ?? null };
}

/** Portfolio → Kalshi: cash, positions value, and every open event-contract position. */
export function KalshiPortfolioView() {
  const status = useKalshiStatus();
  const portfolio = useKalshiPortfolio();
  const setView = useUIStore((s) => s.setView);
  const balancesHidden = useUIStore((s) => s.balancesHidden);
  const toggleBalances = useUIStore((s) => s.toggleBalances);
  const state = status?.state ?? "off";

  if (state === "off") {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Connect Kalshi to see your event-contract positions here and let agents trade them (every
          order still waits for your approval).
        </p>
        <Button type="button" onClick={() => setView("vault")} className="gap-2">
          <KeyRound className="size-4" /> Set up Kalshi
        </Button>
      </div>
    );
  }

  if (state === "connecting" && !portfolio) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting to Kalshi…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {state === "error" && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <span className="text-destructive">{status?.message ?? "Kalshi request failed."}</span>
          <button
            type="button"
            onClick={() => setView("vault")}
            className="w-fit text-foreground underline underline-offset-2"
          >
            Check the Kalshi key in Key Vault
          </button>
        </div>
      )}
      {portfolio && (
        <>
          <div>
            <button
              type="button"
              onClick={toggleBalances}
              aria-label={balancesHidden ? "Show balances" : "Hide balances"}
              className="cursor-pointer text-3xl font-semibold tabular-nums outline-none transition-opacity hover:opacity-70"
            >
              {balancesHidden ? MASK : usd(portfolio.positionsValue)}
            </button>
            <div className="mt-1 text-sm text-muted-foreground">
              Agent positions on Kalshi{status?.env === "demo" ? " · demo account" : ""}
            </div>
          </div>
          <div className="flex flex-col">
            <Row
              label="Unrealized P&L"
              value={balancesHidden ? MASK : signedUsd(portfolio.unrealizedPnl)}
            />
            <Row
              label="Cash (shared account)"
              value={balancesHidden ? MASK : usd(portfolio.cash)}
            />
          </div>
        </>
      )}
      <KalshiPositionsSection />
      {portfolio && Date.now() - portfolio.at > 60_000 && (
        <p className="text-[11px] text-muted-foreground">as of {ago(portfolio.at)}</p>
      )}
    </div>
  );
}

/** Kalshi positions for the "All" view (renders nothing unless Kalshi is connected). */
export function KalshiHoldings() {
  const status = useKalshiStatus();
  if (status?.state !== "connected") return null;
  return (
    <div className="px-4">
      <KalshiPositionsSection />
    </div>
  );
}

function KalshiPositionsSection() {
  const portfolio = useKalshiPortfolio();
  const [open, setOpen] = useState(true);
  const positions = portfolio?.positions ?? [];
  return (
    <div>
      <SectionHeader label="Event contracts" open={open} onToggle={() => setOpen((o) => !o)} />
      {open &&
        (positions.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No agent positions. Only contracts your agents bought show here, not the rest of your
            Kalshi account.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Mark</TableHead>
                <MetricHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((pos) => (
                <KalshiRow key={pos.ticker} pos={pos} />
              ))}
            </TableBody>
          </Table>
        ))}
    </div>
  );
}

/** One position: ticker + held side (YES/NO), contracts, that side's bid, metric. */
function KalshiRow({ pos }: { pos: KalshiPosition }) {
  const env = useKalshiStatus()?.env ?? null;
  const agents = useAgents();
  const by = pos.agentIds
    .map((id) => agents.find((a) => a.id === id)?.name ?? "an archived agent")
    .join(", ");
  return (
    <TableRow>
      <TableCell className="max-w-[9rem]">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "shrink-0 rounded px-1 text-[10px] font-semibold",
                  pos.side === "yes"
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive",
                )}
              >
                {pos.side.toUpperCase()}
              </span>
              <a
                href={kalshiMarketUrl(pos.ticker, env)}
                target="_blank"
                rel="noreferrer"
                className="group/link flex min-w-0 items-center gap-1 font-medium hover:text-primary hover:underline underline-offset-2"
              >
                <span className="truncate">{pos.ticker}</span>
                <ExternalLink className="size-3 shrink-0 opacity-0 group-hover/link:opacity-100" />
              </a>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-64">
            {pos.title ?? pos.ticker}
            <span className="block text-muted-foreground">By {by} · click to open on Kalshi</span>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-right tabular-nums">{num(pos.contracts)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(pos.mark)}</TableCell>
      <MetricCell pnl={pos.unrealizedPnl} costBasis={pos.cost} value={pos.marketValue} />
    </TableRow>
  );
}
