import { readlinkSync } from "node:fs";

/**
 * The machine's CURRENT IANA timezone (e.g. `America/New_York`), read from the OS on
 * every call. Node resolves the process's local zone once at startup and never
 * refreshes it, so a long-lived host goes stale after a system timezone change while
 * every fresh shell (the agent's `date`) already sees the new zone; the
 * `/etc/localtime` symlink (`…/zoneinfo/<Area>/<City>`) does not go stale. An explicit
 * `TZ` env var wins, since that is what the process itself honours.
 */
export function systemTimeZone(): string {
  return (
    [process.env.TZ, zoneFromLocaltimeLink()].find(isValidTimeZone) ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `/etc/localtime -> /var/db/timezone/zoneinfo/Asia/Dubai` → `Asia/Dubai`. */
function zoneFromLocaltimeLink(): string | undefined {
  try {
    const target = readlinkSync("/etc/localtime");
    const idx = target.lastIndexOf("zoneinfo/");
    return idx === -1 ? undefined : target.slice(idx + "zoneinfo/".length);
  } catch {
    return undefined;
  }
}
