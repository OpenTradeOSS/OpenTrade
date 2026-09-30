import type { CSSProperties } from "react";
import { VaultPanel } from "../components/vault/VaultPanel";
import { cn } from "../lib/utils";
import { useConnectionStore } from "../stores/connection";

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** Full-screen Key Vault (sidebar → Key Vault): venue keys + per-integration switches. */
export function KeyVaultScreen() {
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  return (
    <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-background">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-6" style={DRAG}>
        <h1 className="text-sm font-semibold tracking-tight">Key Vault</h1>
      </header>
      <div
        className={cn(
          "flex-1 overflow-y-auto px-6 py-6",
          !backendConnected && "pointer-events-none opacity-50",
        )}
        style={NO_DRAG}
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Choose which venues and data providers your agents can use. Everything here is optional:
            an agent gets only the integrations that are switched on.
          </p>
          <VaultPanel />
        </div>
      </div>
    </div>
  );
}
