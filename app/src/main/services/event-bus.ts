import { EventEmitter } from "node:events";
import type { Agent } from "@shared/agent";
import type { Approval } from "@shared/approval";
import type { BrokerConnectionStatus } from "@shared/broker";
import type { HostNotification, RecentNotification } from "@shared/notify";
import type { AppSettings } from "@shared/settings";

/** Typed app-wide event bus bridged into tRPC observables. */
export interface AppEvents {
  "agents:changed": Agent[];
  /** An agent was archived — harness runtimes (codex app-server) shut down. */
  "agent:archived": { agentId: string };
  "system:tick": { at: number };
  /** Global settings changed; live consumers (broker poller, renderer) re-read. */
  "settings:changed": AppSettings;
  "broker:updated": { keys: string[] };
  "broker:status": { status: BrokerConnectionStatus };
  /** A dead session was auto-restarted (fresh `claude`); renderer should reattach. */
  "terminal:respawned": { agentId: string };
  /** Pending/history approvals changed; renderer re-queries both lists. */
  "approvals:changed": { agentId: string | null };
  /** A new approval needs the user's attention (drives notification + dock badge). */
  "approval:pending": Approval;
  /** A row was appended to the audit log; renderer re-queries the Activity feed. */
  "audit:changed": { agentId: string | null };
  /** A schedule/monitor was created, deleted, or fired; renderer re-queries the Scheduled view. */
  "scheduler:changed": { agentId: string | null };
  /** A host-formatted macOS notification; the launcher relay gates it (per-kind
   *  toggle, per-agent mute, window focus for wakes) and displays it (§12.4). */
  notify: HostNotification;
  /** The durable Recent ring buffer changed — full list, newest first (§12.6). */
  "notifications:recent": RecentNotification[];
  /** The last renderer (GUI) disconnected (≥1→0, after a short grace). The host
   *  blanket-kills every interactive PTY so none are maintained outside the GUI. */
  "gui:gone": undefined;
  /** A GUI (re)appeared (0→1 renderer connection). Drives the analytics `app_opened`. */
  "gui:present": undefined;
}

class TypedEmitter extends EventEmitter {
  emitEvent<K extends keyof AppEvents>(event: K, payload: AppEvents[K]) {
    this.emit(event, payload);
  }
  onEvent<K extends keyof AppEvents>(event: K, cb: (payload: AppEvents[K]) => void) {
    this.on(event, cb as (p: unknown) => void);
    return () => this.off(event, cb as (p: unknown) => void);
  }
}

export const bus = new TypedEmitter();
bus.setMaxListeners(100);
