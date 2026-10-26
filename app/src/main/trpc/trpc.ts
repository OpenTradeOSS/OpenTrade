import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Db } from "../db/client";
import type { AgentRegistry } from "../services/agents/registry";
import type { ApprovalService } from "../services/approvals";
import type { AuditLog } from "../services/audit";
import type { BrokerService } from "../services/broker";
import type { RecentNotificationsService } from "../services/notifications/recent";
import type { Scheduler } from "../services/scheduler";
import type { WakeTransport } from "../services/scheduler/wake/types";
import type { SettingsService } from "../services/settings";
import type { TerminalService } from "../services/terminal";

export interface Context {
  db: Db;
  registry: AgentRegistry;
  terminal: TerminalService;
  broker: BrokerService;
  approvals: ApprovalService;
  audit: AuditLog;
  settings: SettingsService;
  scheduler: Scheduler;
  wake: WakeTransport;
  /** Durable Recent ring buffer behind `notifications.onRecent` (§12.6). */
  recent: RecentNotificationsService;
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
