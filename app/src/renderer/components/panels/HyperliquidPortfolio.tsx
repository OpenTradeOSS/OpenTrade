import {
  type HyperliquidBalance,
  type HyperliquidPosition,
  hyperliquidMarketUrl,
} from "@shared/hyperliquid";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { useHyperliquidPortfolio, useHyperliquidStatus } from "../../hooks/useHyperliquid";
import { ago, num, signedUsd, usd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { MASK, MetricCell, MetricHead, Row, SectionHeader } from "./Portfolio";

/** The Hyperliquid account's value, for the "All" view's combined total. */
export function useHyperliquidTotal(): {
  state: string;
  connected: boolean;
  total: number | null;
} {
  const status = useHyperliquidStatus();
  const portfolio = useHyperliquidPortfolio();
  const state = status?.state ?? "off";
  return { state, connected: state === "connected", total: portfolio?.equity ?? null };
}

/** Portfolio → Hyperliquid: account value, perp positions, and spot balances. */
export function HyperliquidPortfolioView() {
  const status = useHyperliquidStatus();
  const portfolio = useHyperliquidPortfolio();
  const setView = useUIStore((s) => s.setView);
  const balancesHidden = useUIStore((s) => s.balancesHidden);
  const toggleBalances = useUIStore((s) => s.toggleBalances);
  const state = status?.state ?? "off";

  if (state === "off") {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Connect Hyperliquid to see your perp positions and spot balances here and let agents trade
          them (every order still waits for your approval).
        </p>
        <Button type="button" onClick={() => setView("vault")} className="gap-2">
          <KeyRound className="size-4" /> Set up Hyperliquid
        </Button>
      </div>
    );
  }

  if (state === "connecting" && !portfolio) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting to Hyperliquid…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {state === "error" && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <span className="text-destructive">
            {status?.message ?? "Hyperliquid request failed."}
          </span>
          <button
            type="button"
            onClick={() => setView("vault")}
            className="w-fit text-foreground underline underline-offset-2"
          >
            Check the Hyperliquid API wallet in Key Vault
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
              {balancesHidden ? MASK : usd(portfolio.equity)}
            </button>
            <div className="mt-1 text-sm text-muted-foreground">
              Hyperliquid account{status?.env === "testnet" ? " · testnet" : ""}
            </div>
          </div>
          <div className="flex flex-col">
            <Row
              label="Unrealized P&L"
              value={balancesHidden ? MASK : signedUsd(portfolio.unrealizedPnl)}
            />
            <Row
              label="Available USDC"
              value={balancesHidden ? MASK : usd(portfolio.withdrawable)}
            />
          </div>
        </>
      )}
      <HyperliquidSections />
      {portfolio && Date.now() - portfolio.at > 60_000 && (
        <p className="text-[11px] text-muted-foreground">as of {ago(portfolio.at)}</p>
      )}
    </div>
  );
}

/** Hyperliquid holdings for the "All" view (renders nothing unless it is connected). */
export function HyperliquidHoldings() {
  const status = useHyperliquidStatus();
  if (status?.state !== "connected") return null;
  return (
    <div className="px-4">
      <HyperliquidSections />
    </div>
  );
}

function HyperliquidSections() {
  const portfolio = useHyperliquidPortfolio();
  const env = useHyperliquidStatus()?.env ?? null;
  const [perpsOpen, setPerpsOpen] = useState(true);
  const [spotOpen, setSpotOpen] = useState(true);
  const positions = portfolio?.positions ?? [];
  const balances = portfolio?.balances ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionHeader label="Perps" open={perpsOpen} onToggle={() => setPerpsOpen((o) => !o)} />
        {perpsOpen &&
          (positions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No open perp positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Mark</TableHead>
                  <MetricHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((pos) => (
                  <PositionRow
                    key={pos.symbol}
                    pos={pos}
                    url={hyperliquidMarketUrl(pos.symbol, env)}
                  />
                ))}
              </TableBody>
            </Table>
          ))}
      </div>
      <div>
        <SectionHeader label="Spot" open={spotOpen} onToggle={() => setSpotOpen((o) => !o)} />
        {spotOpen &&
          (balances.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No spot balances.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <MetricHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((b) => (
                  <BalanceRow key={b.coin} balance={b} />
                ))}
              </TableBody>
            </Table>
          ))}
      </div>
    </div>
  );
}

/** One perp: LONG/SHORT + market, size, mark, metric (return measured on margin). */
function PositionRow({ pos, url }: { pos: HyperliquidPosition; url: string }) {
  return (
    <TableRow>
      <TableCell className="max-w-[9rem]">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "shrink-0 rounded px-1 text-[10px] font-semibold",
                  pos.side === "long"
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive",
                )}
              >
                {pos.side.toUpperCase()}
              </span>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="group/link flex min-w-0 items-center gap-1 font-medium hover:text-primary hover:underline underline-offset-2"
              >
                <span className="truncate">{pos.symbol}</span>
                <ExternalLink className="size-3 shrink-0 opacity-0 group-hover/link:opacity-100" />
              </a>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-64">
            {pos.leverage ? `${pos.leverage}x · ` : ""}entry {usd(pos.entryPrice)}
            <span className="block text-muted-foreground">
              {pos.liquidationPrice !== null
                ? `Liquidation at ${usd(pos.liquidationPrice)}`
                : "No liquidation price"}
            </span>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-right tabular-nums">{num(pos.size, 4)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(pos.markPrice)}</TableCell>
      <MetricCell pnl={pos.unrealizedPnl} costBasis={pos.marginUsed} value={pos.positionValue} />
    </TableRow>
  );
}

function BalanceRow({ balance: b }: { balance: HyperliquidBalance }) {
  const pnl = b.value !== null && b.cost !== null ? b.value - b.cost : null;
  return (
    <TableRow>
      <TableCell className="max-w-[9rem] truncate font-medium">{b.coin}</TableCell>
      <TableCell className="text-right tabular-nums">{num(b.total, 4)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(b.price)}</TableCell>
      <MetricCell pnl={pnl} costBasis={b.cost} value={b.value} />
    </TableRow>
  );
}
