import {
  envVarFor,
  type HyperliquidEnv,
  type KalshiEnv,
  type VaultKey,
  type VaultStatus,
} from "@shared/vault";
import { AlertTriangle, Check, ExternalLink, FileKey, Loader2, Plus, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useHyperliquidPortfolio, useHyperliquidStatus } from "../../hooks/useHyperliquid";
import { useKalshiPortfolio, useKalshiStatus } from "../../hooks/useKalshi";
import { usd } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { SegmentedControl } from "../settings/SegmentedControl";
import { SettingToggle } from "../settings/SettingToggle";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/** Where Kalshi users create API keys (Account → Profile → API Keys). */
const KALSHI_KEYS_URL: Record<KalshiEnv, string> = {
  prod: "https://kalshi.com/account/profile",
  demo: "https://demo.kalshi.co/account/profile",
};
/** Where Hyperliquid users create API wallets (More → API). */
const HYPERLIQUID_API_URL: Record<HyperliquidEnv, string> = {
  mainnet: "https://app.hyperliquid.xyz/API",
  testnet: "https://app.hyperliquid-testnet.xyz/API",
};
const HYPERLIQUID_DOCS_URL =
  "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets";
const KALSHI_DOCS_URL = "https://docs.kalshi.com/getting_started/api_keys";

/** Vault status, kept live across the sidebar screen and the onboarding step. */
export function useVault() {
  const utils = trpc.useUtils();
  const query = trpc.vault.status.useQuery();
  trpc.vault.onChanged.useSubscription(undefined, {
    onData: (s) => utils.vault.status.setData(undefined, s),
  });
  return query;
}

/**
 * The Key Vault. Two parts:
 *  - **Trading venues** — Robinhood (a switch; its CLIs sign in themselves), and Kalshi
 *    and Hyperliquid, which get a guided setup since each needs a key from its site.
 *  - **API keys** — any number of plain name + key entries; each reaches every agent as
 *    an environment variable (PMXT's is also wired to its market-data tools).
 * Secrets are write-only from here: the host returns hints (`…d808e`), never values.
 * Used full-page (sidebar → Key Vault) and as an onboarding step (`compact`).
 */
export function VaultPanel({ compact = false }: { compact?: boolean }) {
  const status = useVault().data;
  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading vault…
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col", compact ? "gap-5" : "gap-8")}>
      <section className="flex flex-col gap-3">
        <SectionTitle
          title="Trading venues"
          hint="Where agents can place orders. Every order waits for your approval unless the agent is set to auto."
        />
        <RobinhoodCard status={status} />
        <KalshiCard status={status} />
        <HyperliquidCard status={status} />
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle
          title="API keys"
          hint="Add any number of keys. Each one is handed to every agent as an environment variable."
        />
        <KeysCard keys={status.keys} />
      </section>
      <p className="text-xs text-muted-foreground">
        Changes apply the next time an agent starts; restart a running agent to pick them up. Keys
        stay on this Mac in OpenTrade's local database and are never shown back.
      </p>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

// ---- Robinhood ----

function RobinhoodCard({ status }: { status: VaultStatus }) {
  const setEnabled = useSetEnabled();
  return (
    <Card>
      <CardHeader
        title="Robinhood"
        kind="Stocks, options, crypto"
        badge={
          status.robinhood.enabled ? <Badge tone="on">On</Badge> : <Badge tone="off">Off</Badge>
        }
        action={
          <SettingToggle
            checked={status.robinhood.enabled}
            disabled={setEnabled.isPending}
            onChange={(enabled) => setEnabled.mutate({ id: "robinhood", enabled })}
          />
        }
      />
      <p className="text-xs text-muted-foreground">
        Robinhood's Agentic Trading MCP. No key needed: each agent CLI signs in to Robinhood itself.
        Switch it off if you only trade other venues.
      </p>
    </Card>
  );
}

// ---- Kalshi ----

function KalshiCard({ status }: { status: VaultStatus }) {
  const k = status.kalshi;
  const [setupOpen, setSetupOpen] = useState(false);
  const setEnabled = useSetEnabled();
  const live = useKalshiStatus();
  const portfolio = useKalshiPortfolio();
  const utils = trpc.useUtils();
  const remove = trpc.vault.removeKalshi.useMutation({
    onSuccess: (s) => utils.vault.status.setData(undefined, s),
  });
  const test = trpc.vault.testKalshi.useMutation();

  const badge = !k.configured ? (
    <Badge tone="none">Not connected</Badge>
  ) : !k.enabled ? (
    <Badge tone="off">Off</Badge>
  ) : live?.state === "connected" ? (
    <Badge tone="on">Connected{k.env === "demo" ? " · demo" : ""}</Badge>
  ) : live?.state === "error" ? (
    <Badge tone="error">Error</Badge>
  ) : (
    <Badge tone="off">Connecting…</Badge>
  );

  return (
    <Card>
      <CardHeader
        title="Kalshi"
        kind="Event contracts"
        badge={badge}
        action={
          k.configured ? (
            <SettingToggle
              checked={k.enabled}
              disabled={setEnabled.isPending}
              onChange={(enabled) => setEnabled.mutate({ id: "kalshi", enabled })}
            />
          ) : null
        }
      />

      {!k.configured || setupOpen ? (
        <KalshiSetup
          initialEnv={k.env}
          replacing={k.configured}
          onDone={() => setSetupOpen(false)}
          onCancel={k.configured ? () => setSetupOpen(false) : undefined}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Agents read markets and your Kalshi portfolio and place orders through OpenTrade. Your
            key signs requests inside OpenTrade and is never handed to an agent.
          </p>
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs text-muted-foreground">
                Key {k.keyIdHint} · {k.env === "demo" ? "Demo" : "Production"}
              </span>
              {k.enabled && live?.state === "connected" && portfolio && (
                <span className="text-xs text-success">
                  Cash {usd(portfolio.cash)} · {portfolio.positions.length} agent position
                  {portfolio.positions.length === 1 ? "" : "s"}
                </span>
              )}
              {k.enabled && live?.state === "error" && (
                <span className="text-xs text-destructive">{live.message}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={test.isPending}
                onClick={() => test.mutate()}
              >
                {test.isPending && <Loader2 className="size-3 animate-spin" />}
                Test
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSetupOpen(true)}>
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className="text-muted-foreground hover:text-destructive"
              >
                Remove
              </Button>
            </div>
          </div>
          {test.data && <Result ok={test.data.ok} message={test.data.message} />}
        </div>
      )}
    </Card>
  );
}

/**
 * Guided Kalshi connection: Kalshi issues an API key as a Key ID plus a private key file
 * that is shown/downloaded only once, so the steps mirror exactly what the user sees
 * on Kalshi's site. Saving validates the key locally, then runs a live balance check.
 */
function KalshiSetup({
  initialEnv,
  replacing,
  onDone,
  onCancel,
}: {
  initialEnv: KalshiEnv;
  replacing: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [env, setEnv] = useState<KalshiEnv>(initialEnv);
  const [keyId, setKeyId] = useState("");
  const [pem, setPem] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const test = trpc.vault.testKalshi.useMutation({
    onSuccess: (r) => {
      if (r.ok) onDone();
    },
  });
  const save = trpc.vault.saveKalshi.useMutation({
    onSuccess: (s) => {
      utils.vault.status.setData(undefined, s);
      test.mutate();
    },
  });
  const canSave = keyId.trim().length > 0 && (replacing || pem.trim().length > 0);
  const busy = save.isPending || test.isPending;

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setPem(await file.text());
    setFileName(file.name);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave)
          save.mutate({ keyId: keyId.trim(), privateKeyPem: pem.trim() || undefined, env });
      }}
    >
      <Step n={1} title="Pick the Kalshi account">
        <SegmentedControl
          options={[
            { value: "prod", label: "Production" },
            { value: "demo", label: "Demo (paper money)" },
          ]}
          value={env}
          onChange={setEnv}
        />
      </Step>

      <Step n={2} title="Create an API key on Kalshi">
        <p className="text-xs text-muted-foreground">
          On Kalshi open <span className="text-foreground">Account → Profile → API Keys</span> and
          choose <span className="text-foreground">Create key</span>. Kalshi shows a Key ID and
          downloads a private key file. The private key is shown only once, so keep that file.
        </p>
        <div className="flex flex-wrap gap-3">
          <ExternalHint href={KALSHI_KEYS_URL[env]}>
            Open Kalshi {env === "demo" ? "demo " : ""}API keys
          </ExternalHint>
          <ExternalHint href={KALSHI_DOCS_URL}>Kalshi's guide</ExternalHint>
        </div>
      </Step>

      <Step n={3} title="Paste the Key ID">
        <Input
          value={keyId}
          onChange={(e) => setKeyId(e.target.value)}
          placeholder="a952bcbe-ec3b-4b5b-b8f9-11dae589608c"
          autoComplete="off"
          spellCheck={false}
          aria-label="Kalshi Key ID"
          className="font-mono text-xs"
        />
      </Step>

      <Step
        n={4}
        title={
          replacing ? "Add the private key (optional: keeps the saved one)" : "Add the private key"
        }
      >
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".key,.pem,.txt,text/plain"
            className="hidden"
            onChange={(e) => void readFile(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <FileKey className="size-3.5" /> Choose key file…
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {fileName ? `Loaded ${fileName}` : "or paste it below"}
          </span>
        </div>
        <Textarea
          value={pem}
          onChange={(e) => {
            setPem(e.target.value);
            setFileName(null);
          }}
          placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          aria-label="Kalshi private key"
          className="resize-none font-mono text-xs"
        />
      </Step>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSave || busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {save.isPending ? "Saving…" : test.isPending ? "Checking with Kalshi…" : "Connect Kalshi"}
        </Button>
      </div>
      {save.isError && <Result ok={false} message={errorText(save.error)} />}
      {test.data && !test.data.ok && (
        <Result
          ok={false}
          message={`Saved, but Kalshi refused it: ${test.data.message}. Check the Key ID, the key file, and that the account matches.`}
        />
      )}
    </form>
  );
}

// ---- Hyperliquid ----

const shortAddr = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

function HyperliquidCard({ status }: { status: VaultStatus }) {
  const h = status.hyperliquid;
  const [setupOpen, setSetupOpen] = useState(false);
  const setEnabled = useSetEnabled();
  const live = useHyperliquidStatus();
  const portfolio = useHyperliquidPortfolio();
  const utils = trpc.useUtils();
  const remove = trpc.vault.removeHyperliquid.useMutation({
    onSuccess: (s) => utils.vault.status.setData(undefined, s),
  });
  const test = trpc.vault.testHyperliquid.useMutation();

  const badge = !h.configured ? (
    <Badge tone="none">Not connected</Badge>
  ) : !h.enabled ? (
    <Badge tone="off">Off</Badge>
  ) : live?.state === "connected" ? (
    <Badge tone="on">Connected{h.env === "testnet" ? " · testnet" : ""}</Badge>
  ) : live?.state === "error" ? (
    <Badge tone="error">Error</Badge>
  ) : (
    <Badge tone="off">Connecting…</Badge>
  );

  return (
    <Card>
      <CardHeader
        title="Hyperliquid"
        kind="Perps and spot crypto"
        badge={badge}
        action={
          h.configured ? (
            <SettingToggle
              checked={h.enabled}
              disabled={setEnabled.isPending}
              onChange={(enabled) => setEnabled.mutate({ id: "hyperliquid", enabled })}
            />
          ) : null
        }
      />

      {!h.configured || setupOpen ? (
        <HyperliquidSetup
          initialEnv={h.env}
          replacing={h.configured}
          onDone={() => setSetupOpen(false)}
          onCancel={h.configured ? () => setSetupOpen(false) : undefined}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Agents read markets and your Hyperliquid account and place orders through OpenTrade. The
            API wallet signs inside OpenTrade, is never handed to an agent, and cannot withdraw
            funds.
          </p>
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs text-muted-foreground">
                Account {shortAddr(h.account)} · API wallet {shortAddr(h.apiWallet)} ·{" "}
                {h.env === "testnet" ? "Testnet" : "Mainnet"}
              </span>
              {h.enabled && live?.state === "connected" && portfolio && (
                <span className="text-xs text-success">
                  Account value {usd(portfolio.equity)} · {portfolio.positions.length} open position
                  {portfolio.positions.length === 1 ? "" : "s"}
                </span>
              )}
              {h.enabled && live?.state === "error" && (
                <span className="text-xs text-destructive">{live.message}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={test.isPending}
                onClick={() => test.mutate()}
              >
                {test.isPending && <Loader2 className="size-3 animate-spin" />}
                Test
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSetupOpen(true)}>
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className="text-muted-foreground hover:text-destructive"
              >
                Remove
              </Button>
            </div>
          </div>
          {test.data && <Result ok={test.data.ok} message={test.data.message} />}
        </div>
      )}
    </Card>
  );
}

/**
 * Guided Hyperliquid connection. Hyperliquid's "API wallet" is a second key the main
 * wallet authorizes to trade (never to withdraw); its private key is shown once, when
 * it is generated. That key is all the user pastes: the host asks Hyperliquid which
 * account authorized it, and refuses a main wallet's key outright.
 */
function HyperliquidSetup({
  initialEnv,
  replacing,
  onDone,
  onCancel,
}: {
  initialEnv: HyperliquidEnv;
  replacing: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [env, setEnv] = useState<HyperliquidEnv>(initialEnv);
  const [key, setKey] = useState("");
  const [account, setAccount] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.vault.saveHyperliquid.useMutation({
    onSuccess: (s) => {
      utils.vault.status.setData(undefined, s);
      onDone();
    },
  });
  const canSave = replacing || key.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) {
          save.mutate({
            privateKey: key.trim() || undefined,
            accountAddress: account.trim() || undefined,
            env,
          });
        }
      }}
    >
      <Step n={1} title="Pick the network">
        <SegmentedControl
          options={[
            { value: "mainnet", label: "Mainnet" },
            { value: "testnet", label: "Testnet (mock money)" },
          ]}
          value={env}
          onChange={setEnv}
        />
      </Step>

      <Step n={2} title="Create an API wallet on Hyperliquid">
        <p className="text-xs text-muted-foreground">
          On Hyperliquid open <span className="text-foreground">More → API</span>, name a wallet,
          choose <span className="text-foreground">Generate</span>, then{" "}
          <span className="text-foreground">Authorize API Wallet</span>. Hyperliquid shows its
          private key once, so copy it then. An API wallet can trade but cannot withdraw.
        </p>
        <div className="flex flex-wrap gap-3">
          <ExternalHint href={HYPERLIQUID_API_URL[env]}>
            Open Hyperliquid {env === "testnet" ? "testnet " : ""}API
          </ExternalHint>
          <ExternalHint href={HYPERLIQUID_DOCS_URL}>About API wallets</ExternalHint>
        </div>
      </Step>

      <Step
        n={3}
        title={
          replacing
            ? "Paste the API wallet's private key (optional: keeps the saved one)"
            : "Paste the API wallet's private key"
        }
      >
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="0x… (64 hex characters)"
          autoComplete="off"
          spellCheck={false}
          aria-label="Hyperliquid API wallet private key"
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Never paste your main wallet's key or seed phrase. OpenTrade refuses a key that can
          withdraw.
        </p>
      </Step>

      <Step n={4} title="Sub-account or vault address (optional)">
        <Input
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="Leave empty to trade your main account"
          autoComplete="off"
          spellCheck={false}
          aria-label="Hyperliquid sub-account address"
          className="font-mono text-xs"
        />
      </Step>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          {save.isPending ? "Checking with Hyperliquid…" : "Connect Hyperliquid"}
        </Button>
      </div>
      {save.isError && <Result ok={false} message={errorText(save.error)} />}
    </form>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">
        {n}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}

// ---- API keys ----

function KeysCard({ keys }: { keys: VaultKey[] }) {
  return (
    <Card>
      {keys.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
          {keys.map((k) => (
            <KeyRow key={k.envVar} k={k} />
          ))}
        </div>
      )}
      <AddKeyForm existing={keys} />
      <p className="text-xs text-muted-foreground">
        Agents see keys only as environment variables and are told never to print them. A key named{" "}
        <span className="font-mono text-foreground">PMXT</span> also connects PMXT's read-only
        prediction-market data.{" "}
        <a
          href="https://pmxt.dev/dashboard"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          Get a PMXT key
        </a>
      </p>
    </Card>
  );
}

function KeyRow({ k }: { k: VaultKey }) {
  const utils = trpc.useUtils();
  const remove = trpc.vault.removeKey.useMutation({
    onSuccess: (s) => utils.vault.status.setData(undefined, s),
  });
  const test = trpc.vault.testKey.useMutation();
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{k.name}</span>
            {k.wiredAs && <Badge tone="on">{k.wiredAs}</Badge>}
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            ${k.envVar} · {k.hint}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {k.testable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate({ envVar: k.envVar })}
            >
              {test.isPending && <Loader2 className="size-3 animate-spin" />}
              Test
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${k.name}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate({ envVar: k.envVar })}
            className="text-muted-foreground hover:text-destructive"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {test.data && <Result ok={test.data.ok} message={test.data.message} />}
    </div>
  );
}

function AddKeyForm({ existing }: { existing: VaultKey[] }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.vault.saveKey.useMutation({
    onSuccess: (s) => {
      utils.vault.status.setData(undefined, s);
      setName("");
      setValue("");
    },
  });
  const envVar = envVarFor(name);
  const replaces = existing.some((k) => k.envVar === envVar);
  const canSave = envVar.length > 0 && value.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save.mutate({ name: name.trim(), value: value.trim() });
      }}
    >
      <Label className="text-xs text-muted-foreground">Add a key</Label>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. PMXT)"
          aria-label="Key name"
          autoComplete="off"
          className="w-40 shrink-0"
        />
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Key"
          aria-label="Key value"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {replaces ? "Replace" : "Add"}
        </Button>
      </div>
      {envVar && (
        <span className="font-mono text-[11px] text-muted-foreground">
          Agents will see ${envVar}
          {replaces ? " (replaces the saved key)" : ""}
        </span>
      )}
      {save.isError && <Result ok={false} message={errorText(save.error)} />}
    </form>
  );
}

// ---- building blocks ----

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      {children}
    </div>
  );
}

function CardHeader({
  title,
  kind,
  badge,
  action,
}: {
  title: string;
  kind: string;
  badge: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{title}</h3>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground">{kind}</p>
      </div>
      {action}
    </div>
  );
}

function Badge({ tone, children }: { tone: "on" | "off" | "none" | "error"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
        tone === "on" && "bg-success/15 text-success",
        tone === "off" && "bg-muted text-muted-foreground",
        tone === "error" && "bg-destructive/15 text-destructive",
        tone === "none" && "border border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function Result({ ok, message }: { ok: boolean; message: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", ok ? "text-success" : "text-destructive")}>
      {ok ? (
        <Check className="mt-px size-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
      )}
      <span>{message}</span>
    </p>
  );
}

function ExternalHint({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex w-fit items-center gap-1.5 text-xs text-primary hover:underline"
    >
      {children} <ExternalLink className="size-3" />
    </a>
  );
}

function useSetEnabled() {
  const utils = trpc.useUtils();
  return trpc.vault.setEnabled.useMutation({
    onSuccess: (s) => utils.vault.status.setData(undefined, s),
  });
}

/** tRPC surfaces zod failures as a JSON blob; show the first human message instead. */
function errorText(err: { message: string } | null): string {
  const msg = err?.message ?? "Something went wrong.";
  try {
    const parsed = JSON.parse(msg) as { message?: string }[];
    if (Array.isArray(parsed) && parsed[0]?.message) return parsed[0].message;
  } catch {
    // plain message
  }
  return msg;
}
