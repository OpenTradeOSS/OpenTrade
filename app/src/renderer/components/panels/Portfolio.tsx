import type { CryptoPosition, OptionPosition } from "@shared/broker";
import { contractLabel } from "@shared/options";
import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { useBrokerData, useBrokerStatus } from "../../hooks/useBroker";
import { ago, num, pct, signedPct, signedUsd, usd } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { type PositionsMetric, useUIStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/** Placeholder shown in place of a dollar amount when balances are hidden. */
const MASK = "****";

export function Portfolio() {
  const status = useBrokerStatus();
  const connect = trpc.onboarding.connectBroker.useMutation();
  const disconnect = trpc.broker.disconnect.useMutation();
  const data = useBrokerData();
  const balancesHidden = useUIStore((s) => s.balancesHidden);
  const toggleBalances = useUIStore((s) => s.toggleBalances);
  const [equitiesOpen, setEquitiesOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [cryptoOpen, setCryptoOpen] = useState(true);

  if (!status || status.status === "disconnected" || status.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Connect your Robinhood account to see live portfolio data. This opens a browser for a
          one-time login; OpenTrade keeps a read-only session.
        </p>
        <Button
          type="button"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
          className="gap-2"
        >
          {connect.isPending && <Loader2 className="size-4 animate-spin" />}
          Connect Robinhood
        </Button>
        {status?.status === "error" && (
          <p className="text-xs text-destructive">Connection failed. Try again.</p>
        )}
      </div>
    );
  }

  if (status.status === "connecting") {
    return (
      <div className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Waiting for Robinhood…
        {/* The consent can't tell the browser tab was closed; Cancel is the way out. */}
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
    );
  }

  const p = data.portfolio?.value;
  const positions = data.positions?.value ?? [];
  const optionPositions = data.optionPositions?.value ?? [];
  const cryptoPositions = data.cryptoPositions?.value ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        {/* Click the value to hide/show all dollar balances (masked as ****). */}
        <button
          type="button"
          onClick={toggleBalances}
          aria-label={balancesHidden ? "Show balances" : "Hide balances"}
          className="cursor-pointer text-3xl font-semibold tabular-nums outline-none transition-opacity hover:opacity-70"
        >
          {balancesHidden ? MASK : usd(p?.equity)}
        </button>
        <DayChange change={p?.dayChange} fraction={p?.dayChangePct} hidden={balancesHidden} />
      </div>

      <div className="flex flex-col">
        <Row label="Buying power" value={balancesHidden ? MASK : usd(p?.buyingPower)} />
        <Row label="Cash" value={balancesHidden ? MASK : usd(p?.cash)} />
      </div>

      <div>
        <SectionHeader
          label="Equities"
          open={equitiesOpen}
          onToggle={() => setEquitiesOpen((o) => !o)}
        />
        {equitiesOpen &&
          (positions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                  <MetricHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((pos) => (
                  <TableRow key={pos.symbol}>
                    <TableCell className="font-medium">{pos.symbol}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(pos.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(pos.lastPrice)}</TableCell>
                    <MetricCell
                      pnl={pos.unrealizedPnl}
                      costBasis={pos.averageCost !== null ? pos.averageCost * pos.quantity : null}
                      value={pos.marketValue}
                    />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </div>

      {/* Option holdings, in contract units: Mark is the per-share quote, P&L is per
          the multiplier-included cost basis. */}
      <div>
        <SectionHeader
          label="Options"
          open={optionsOpen}
          onToggle={() => setOptionsOpen((o) => !o)}
        />
        {optionsOpen &&
          (optionPositions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Mark</TableHead>
                  <MetricHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {optionPositions.map((pos) => (
                  <OptionRow key={pos.optionId} pos={pos} />
                ))}
              </TableBody>
            </Table>
          ))}
      </div>

      {/* Crypto holdings: coin quantities (never "shares"), per-coin price, P&L
          against the direct cost basis. */}
      <div>
        <SectionHeader label="Crypto" open={cryptoOpen} onToggle={() => setCryptoOpen((o) => !o)} />
        {cryptoOpen &&
          (cryptoPositions.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <MetricHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cryptoPositions.map((pos) => (
                  <CryptoRow key={pos.assetCode} pos={pos} />
                ))}
              </TableBody>
            </Table>
          ))}
      </div>

      {isStale(data.portfolio?.fetchedAt) && (
        <p className="text-[11px] text-muted-foreground">as of {ago(data.portfolio?.fetchedAt)}</p>
      )}
    </div>
  );
}

const METRIC_LABEL: Record<PositionsMetric, string> = {
  pnl: "P&L",
  pct: "% Gain",
  value: "Value",
};

/**
 * The last column's header, shared by both tables: clicking it cycles what the
 * column shows (P&L $ → % gain → market value), the same click-to-change family
 * as the account value's balance masking. One store field drives both tables.
 */
function MetricHead() {
  const metric = useUIStore((s) => s.positionsMetric);
  const cycle = useUIStore((s) => s.cyclePositionsMetric);
  return (
    <TableHead className="text-right">
      <button
        type="button"
        onClick={cycle}
        title="Switch between P&L, % gain, and market value"
        className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {METRIC_LABEL[metric]}
      </button>
    </TableHead>
  );
}

/**
 * The last column's cell. `costBasis` is what the position cost (per-contract
 * basis × contracts for options — the credit received for a short, so a short's
 * % is "fraction of the premium kept/lost"). P&L and % color by sign; Value is
 * neutral and masks with the other balances.
 */
function MetricCell({
  pnl,
  costBasis,
  value,
}: {
  pnl: number | null;
  costBasis: number | null;
  value: number | null;
}) {
  const metric = useUIStore((s) => s.positionsMetric);
  const balancesHidden = useUIStore((s) => s.balancesHidden);
  if (metric === "value") {
    return (
      <TableCell className="text-right tabular-nums">
        {balancesHidden ? MASK : usd(value)}
      </TableCell>
    );
  }
  const pctGain =
    metric === "pct" && pnl !== null && costBasis !== null && costBasis !== 0
      ? pnl / Math.abs(costBasis)
      : null;
  // P&L dollars mask with the other balances (color still shows direction, like the
  // account day-change line); the % metric is relative and stays visible.
  return (
    <TableCell
      className={cn(
        "text-right tabular-nums",
        (pnl ?? 0) > 0 && "text-success",
        (pnl ?? 0) < 0 && "text-destructive",
      )}
    >
      {metric === "pnl" ? (balancesHidden ? MASK : signedUsd(pnl)) : signedPct(pctGain)}
    </TableCell>
  );
}

/**
 * Collapsible section heading, in the Monitor tab's History style (13px, between the
 * Monitor's `text-xs` and `text-sm`): the label is the toggle, the chevron rotates open.
 */
function SectionHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {label}
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
      </button>
    </div>
  );
}

/** One crypto holding: asset code, coins (up to 8 decimals), per-coin price, metric. */
function CryptoRow({ pos }: { pos: CryptoPosition }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{pos.assetCode}</TableCell>
      <TableCell className="text-right tabular-nums">{num(pos.quantity, 8)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(pos.lastPrice)}</TableCell>
      <MetricCell
        pnl={pos.unrealizedPnl}
        // P&L covers only the directly purchased lots (transfers have no basis),
        // so the % denominator must be those lots' cost, not the whole holding's.
        costBasis={
          pos.avgCost !== null && pos.directQuantity ? pos.avgCost * pos.directQuantity : null
        }
        value={pos.marketValue}
      />
    </TableRow>
  );
}

/** One option holding: `TLT $86C 11/20/26`, contracts (negative for a short), mark, P&L. */
function OptionRow({ pos }: { pos: OptionPosition }) {
  const label = contractLabel({
    optionId: pos.optionId,
    chainSymbol: pos.chainSymbol,
    expirationDate: pos.expirationDate,
    strikePrice: pos.strikePrice,
    optionType: pos.optionType,
    multiplier: pos.multiplier,
  });
  const qty = pos.type === "short" ? -pos.quantity : pos.quantity;
  // `pendingQuantity` (contracts queued for exercise/assignment/expiry) is mapped
  // but deliberately not surfaced yet — the row annotations (pending, partial
  // basis, …) are being designed together; see TODO.md.
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{num(qty)}</TableCell>
      <TableCell className="text-right tabular-nums">{usd(pos.lastPrice)}</TableCell>
      <MetricCell
        pnl={pos.unrealizedPnl}
        costBasis={pos.averagePrice !== null ? pos.averagePrice * pos.quantity : null}
        value={pos.marketValue}
      />
    </TableRow>
  );
}

/** True when the last successful broker update is missing or older than a minute. */
function isStale(ts: number | null | undefined): boolean {
  if (!ts) return true;
  return Date.now() - ts > 60_000;
}

/** Today's account move: ▲/▼ $X (Y%) Today, colored green/red. The dollar amount
 *  masks with the other balances; the direction arrow and percentage stay visible. */
function DayChange({
  change,
  fraction,
  hidden,
}: {
  change: number | null | undefined;
  fraction: number | null | undefined;
  hidden: boolean;
}) {
  if (change === null || change === undefined) {
    return <div className="mt-1 text-sm text-muted-foreground">— Today</div>;
  }
  const up = change >= 0;
  return (
    <div
      className={cn(
        "mt-1 flex items-baseline gap-1.5 text-sm font-medium",
        up ? "text-success" : "text-destructive",
      )}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      <span className="tabular-nums">
        {hidden ? MASK : usd(Math.abs(change))} ({pct(fraction)})
      </span>
      <span className="font-normal text-muted-foreground">Today</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-2 text-sm first:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
