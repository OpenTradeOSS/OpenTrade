import type { Agent, AgentStatus } from "@shared/agent";
import type { RecentNotification } from "@shared/notify";
import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";

/**
 * The macOS menu bar (status) item — §12.6.
 *
 * A launcher-side monitor over the same relay stream that drives notifications:
 * per-agent status, the pending-approval count (also shown as the item's title so
 * it's visible without opening the menu), and a short in-memory log of recent
 * events (wakes / order results / approvals / turn-limit pauses). It's what lets the
 * launcher stay useful once the window is gone — with `showInMenuBar` on, ⌘Q and
 * window-close retreat here instead of exiting, so agents running headless in the
 * host still surface to the user. State is fed by `main/index.ts`; this module only
 * renders it and routes clicks back through `TrayActions`.
 *
 * Pure presentation: no tRPC, no settings gate — callers decide what to feed.
 */

/** Click routing back into the launcher (all resolve to "open the window" variants). */
export interface TrayActions {
  /** Show/restore/recreate the main window. */
  openWindow(): void;
  /** Open the window and select this agent (§12.6 shell bridge). */
  openAgent(agentId: string): void;
  /** Really quit the launcher (the host keeps running, as always). */
  quit(): void;
  /** Full quit: terminate the backend host too — nothing keeps running. */
  quitCompletely(): void;
}

/** Keep menu rows on one line; macOS menus don't wrap. */
const ROW_MAX = 60;
const DAY_MS = 86_400_000;
/** Relative times go stale in a menu that isn't rebuilt; re-render on this cadence. */
const REFRESH_MS = 60_000;

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  "needs-input": "Needs input",
  "awaiting-approval": "Awaiting approval",
};

// The app mark (app/build/icon.svg) rasterized at 16px (1x) and 32px (2x) — embedded
// so the tray needs no on-disk asset lookup that differs between dev and the packaged
// .app. Flagged as a *template* image so macOS recolors it for light/dark menu bars.
// A template image is read by ALPHA ONLY (every non-transparent pixel is "ink"), so the
// background must be truly transparent — an opaque white background renders as a solid
// square. Regenerate: `qlmanage -t -s 512` the SVG (it paints on opaque white and ignores
// viewBox crops), then luminance→alpha, crop to the mark's bbox, LANCZOS-downsample into
// a 1px-padded 16/32 square (see docs/TODO.md for the script note).
const ICON_16 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABVklEQVR42q3TPUjWURgF8F/6YgSCUCBJBLnpGtEeOEhLodEgTW6CELi5RkNWCjpktQdBNDS4KVgQgotDk+SgFgnah8hbWG9+LMe4vPESSBcul/v8zznPx/9c/uNqznkG9/AO33CAjxjH2TrsX+Sr+IrP2MUvDGMSG9hBXyOR3mR7glPojNBQvrfgYTB99eTTqOJpXXwurVTQlNgD1NBRAu9jq6hkBl+SbSnxpkJoDY9LgU+YxlRIbzGCN3hf4FpyvsR2KbCd/R09RXwUH5L5aGiXsZc2/vTVjFZcwWyGWMHJYH6HdA2vsZm7SgSqmMdiyqyFVM2/f4aL6IofdnG7FHiOm6lkryi3hhO4lASDWMAqXpQzaMdPTOReye7PUNsK7F3s43y9F64HPFbMBlbwCt24E8xAIyv3p+/1eONGzHSQ/QO3/vUezuFRbHxEXI5HLjQiH3sdAh7NVrWb5tLzAAAAAElFTkSuQmCC";
const ICON_32 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADpklEQVR42sWX24tVZRjGf7P3nqYZtUmIQC8GpAtBJIRwiETvkgwPieFVmgQp6IWCUYQHRMl/QJARVMQLEVT0QkJRBCPNQ2JMgYJW6KCjEB085szee3nzfPLM65q1tgT5wWLttfb7Pe/zPe/h+xa85NFW8n8VaNjzu8Bs3ScBrwMZcA+4AVwETgDf27yI0fKo6l4DlgFngWE5LLrqwCVgFdAVsF7Y+Uzgx+BgGBgCmlr5z8AA8CSHzBXgQ2FVWlB8hPM1ki6BNSVzem7oeTwwFpgMLAEO55DZbNiFJGq6b7HVZsApYAYwRjlw3cC35+BMA44EjL4yEmnlqzUhrWJDju1bwF9S5V+gRxK3h3ivUk4MCWvraDlRtSxv2ITPLX6JeWdQKQNWBAUr9nthIDEvj0Ri32+gaeWvCCyyXmS5sTsQwOaihSTbAWCcfI4YS835d3rXEWzGAu+oLK9Zkp60hcTRrvtBw/8yGlWAC2JYB6YbWBVYAOwDbsrGaz4DfihobKn8JgGPNP9X6xEA9IaMd5kvlzSdDDhX0llT+PbY3Pku2RyL3y5Jv0+yTTOgG3q3SU4TcNZCy08qpzHXDb4VyH2pcdqSJsV4gXIgjYmyz9SmixRIiztjClx2g6t6+Tfwmxn9CXySA1YDuoE7sjtTQKA9JHndsJ+NOyG2TSXcVIth6gPJyXjgbgGBNnP+NvCP8qxhHfI5AnX9cc+ct4+yhbsCZxXjSmhCqKJuhep5jsC10Lc/G8W5ExgHDIYq8NEJrAUemvML5mtECE4Ys3Mle3ibNaVBy51ebVbTgfWWV57IPcBtPfc76DdG4As5qZUQGGME0uY1kNMrmsA24c2y93scdKYlx+EWFeiy1TRyHD8W1ns2d6cpsjiWVr/+HAKmyFG1gECHKsUJXAUOaUufHEpxgkKVNqTXIvBKY3+0IAl9/GRzNuaErQK8qt+7c05IIww7tUkkiVaGLTWvt+83+16p0yEiFZv7sSn1B/BGbFoJcLYMh9QTPrIQVXJa6zJb1QHDqpl6s1SK6UCypOxUtNmyehhYHmyqtsV2hy76dcBcDDyw/rKjKMG99PpCY9ofkspBPg2254F12lW99x8MR7tRSywBbw1l9QDYqzPdBAvJVOVB05zFq89UK/02aDPwhWF3zKzz/aKj201zXg9fT4PKE1p1nidxN/CVvnKyFq/flUtvln0LvMjHaRfwPvCB+n2PnW4fqrlcAo4Bx7X9/qeP0/9lPAXLNXbyrktA3AAAAABJRU5ErkJggg==";

function trayIcon() {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(ICON_16, "base64") });
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(ICON_32, "base64") });
  img.setTemplateImage(true);
  return img;
}

function truncate(s: string, max = ROW_MAX): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Coarse "how long ago", for a glanceable one-line sublabel. */
function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export class AppTray {
  private tray: Tray | null = null;
  private agents: Agent[] = [];
  private pending = 0;
  private recent: RecentNotification[] = [];
  private refresh: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly actions: TrayActions) {}

  /** Idempotent: create the status item if it isn't showing. */
  show(): void {
    if (this.tray) return;
    this.tray = new Tray(trayIcon());
    this.tray.setToolTip("OpenTrade");
    this.render();
    // Rows carry relative times ("2h ago"), which would otherwise freeze at whatever
    // the last data push rendered. macOS can't update an open menu, but every reopen
    // then shows fresh values.
    this.refresh = setInterval(() => this.render(), REFRESH_MS);
  }

  /** Idempotent: remove the status item (state is kept so a later show() is warm). */
  hide(): void {
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
    this.tray?.destroy();
    this.tray = null;
  }

  get visible(): boolean {
    return this.tray !== null;
  }

  setAgents(agents: Agent[]): void {
    this.agents = agents;
    this.render();
  }

  setPendingCount(n: number): void {
    this.pending = n;
    this.render();
  }

  /** Replace the Recent list wholesale — the host owns it (durable ring buffer,
   *  newest first, already capped), so there is nothing to merge here. */
  setRecent(list: RecentNotification[]): void {
    this.recent = list;
    this.render();
  }

  private render(): void {
    if (!this.tray) return;
    // The pending-approval count rides next to the icon so the one actionable state is
    // visible without opening the menu (the dock badge is gone once the window closes).
    this.tray.setTitle(this.pending > 0 ? String(this.pending) : "", {
      fontType: "monospacedDigit",
    });
    this.tray.setContextMenu(Menu.buildFromTemplate(this.template()));
  }

  private template(): MenuItemConstructorOptions[] {
    // Opening the app leads: it's the action people reach for, so it sits under the
    // cursor the moment the menu drops rather than at the far end of the list.
    const items: MenuItemConstructorOptions[] = [
      { label: "Open OpenTrade", click: () => this.actions.openWindow() },
    ];

    if (this.agents.length > 0) {
      items.push({ type: "separator" });
      for (const a of this.agents) {
        items.push({
          label: truncate(a.name),
          // `sublabel` is a native NSMenuItem subtitle: darwin-only, macOS >= 14.4,
          // silently dropped below that — the row then reads as just the agent name.
          sublabel:
            a.lastActiveAt !== null
              ? `${STATUS_LABEL[a.status]} · ${relativeTime(a.lastActiveAt)}`
              : STATUS_LABEL[a.status],
          click: () => this.actions.openAgent(a.id),
        });
      }
    }

    items.push({ type: "separator" });
    if (this.pending > 0) {
      items.push({
        label: `${this.pending} order${this.pending === 1 ? "" : "s"} awaiting your approval…`,
        click: () => this.actions.openWindow(),
      });
    }
    items.push({
      label: "Recent",
      submenu:
        this.recent.length === 0
          ? [{ label: "No recent activity", enabled: false }]
          : this.recent.map((ev) => ({
              label: truncate(`${ev.title} — ${ev.body}`),
              // Clock time reads naturally for today's events; older ones need the
              // distance instead. (Sublabel: macOS >= 14.4 — see the agent rows.)
              sublabel: Date.now() - ev.at < DAY_MS ? clock(ev.at) : relativeTime(ev.at),
              // The ring buffer outlives agents — an event's agent may have been
              // archived since, so only select ids still in the live list.
              click: () =>
                ev.agentId && this.agents.some((a) => a.id === ev.agentId)
                  ? this.actions.openAgent(ev.agentId)
                  : this.actions.openWindow(),
            })),
    });

    items.push(
      { type: "separator" },
      // Quit = the launcher only (agents keep running headless, the Docker Desktop
      // model); Completely = the backend host too — the full process tree.
      { label: "Quit OpenTrade", click: () => this.actions.quit() },
      { label: "Quit OpenTrade Completely", click: () => this.actions.quitCompletely() },
    );
    return items;
  }
}
