import webpush from "web-push";
import type { Config } from "./config";
import type { Db } from "./db";

/**
 * Push to a user's devices: the iPhone app (Expo push tokens, delivered through Expo's
 * push service to APNs) and installed web apps (Web Push, VAPID). Dead targets are
 * pruned when the service reports them gone.
 */
export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link data for the app (e.g. which approval to open). */
  data?: Record<string, string | number | null>;
  /** iOS notification category (enables Approve/Reject actions). */
  category?: string;
}

interface Target {
  id: number;
  kind: "expo" | "web";
  target: string;
}

export class Push {
  private webEnabled: boolean;

  constructor(
    private db: Db,
    cfg: Config,
  ) {
    this.webEnabled = Boolean(cfg.push.vapidPublic && cfg.push.vapidPrivate);
    if (this.webEnabled) {
      webpush.setVapidDetails(
        cfg.push.vapidSubject,
        cfg.push.vapidPublic as string,
        cfg.push.vapidPrivate as string,
      );
    }
  }

  register(userId: string, kind: "expo" | "web", target: string): void {
    this.db.run(
      `INSERT INTO push_targets (user_id, kind, target, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, target) DO UPDATE SET user_id = excluded.user_id`,
      [userId, kind, target, Date.now()],
    );
  }

  unregister(kind: "expo" | "web", target: string): void {
    this.db.run("DELETE FROM push_targets WHERE kind = ? AND target = ?", [kind, target]);
  }

  async send(userId: string, msg: PushMessage): Promise<number> {
    const targets = this.db
      .query<Target, [string]>("SELECT id, kind, target FROM push_targets WHERE user_id = ?")
      .all(userId);
    const expo = targets.filter((t) => t.kind === "expo");
    const web = targets.filter((t) => t.kind === "web");
    let sent = 0;

    if (expo.length) {
      try {
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(
            expo.map((t) => ({
              to: t.target,
              title: msg.title,
              body: msg.body,
              data: msg.data ?? {},
              sound: "default",
              priority: "high",
              categoryId: msg.category,
            })),
          ),
        });
        const json = (await res.json()) as {
          data?: Array<{ status: string; details?: { error?: string } }>;
        };
        json.data?.forEach((r, i) => {
          if (r.status === "ok") sent++;
          else if (r.details?.error === "DeviceNotRegistered")
            this.unregister("expo", expo[i].target);
        });
      } catch (err) {
        console.error("expo push failed", err);
      }
    }

    if (web.length && this.webEnabled) {
      await Promise.all(
        web.map(async (t) => {
          try {
            await webpush.sendNotification(JSON.parse(t.target), JSON.stringify(msg), {
              TTL: 600,
              urgency: "high",
            });
            sent++;
          } catch (err: any) {
            if (err?.statusCode === 404 || err?.statusCode === 410)
              this.unregister("web", t.target);
          }
        }),
      );
    }
    return sent;
  }
}
