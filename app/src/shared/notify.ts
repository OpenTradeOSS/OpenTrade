import { z } from "zod";

/**
 * The kinds of desktop notification OpenTrade shows. Each has a settings toggle
 * (§12.4) and rides the `notification_clicked` telemetry `kind` prop.
 */
export const NotificationKind = z.enum(["wake", "order", "approval", "restricted", "update"]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/**
 * Kinds the backend host emits over the bus / `notifications.onNotify` tRPC sub.
 * `"update"` is launcher-local (electron-updater lives in the Electron main
 * process), so it never travels over the bus.
 */
export type HostNotificationKind = Exclude<NotificationKind, "update">;

/**
 * A host-formatted notification. The host owns the copy (it has the agent
 * registry and order details); the launcher only gates (per-kind toggle,
 * per-agent mute, window focus for wakes) and displays. `agentId`, when present,
 * powers the per-agent mute in the launcher.
 */
export interface HostNotification {
  kind: HostNotificationKind;
  title: string;
  body: string;
  agentId?: string;
}

/**
 * A notify-bus event as persisted in the host's `recent_notifications` ring buffer
 * (§12.6) and served to the tray's Recent submenu over `notifications.onRecent`.
 * `at` is stamped by the host at record time — keep it a plain epoch-ms number so
 * the wire shape stays superjson-trivial.
 */
export interface RecentNotification extends HostNotification {
  at: number;
}

/**
 * First non-empty line of a prompt, trimmed and truncated — the body of a wake
 * notification. Keeps a multi-line prompt from spilling into the banner.
 */
export function firstLine(text: string, max = 120): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
