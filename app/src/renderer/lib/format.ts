export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function signedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const s = usd(Math.abs(value));
  return value < 0 ? `-${s}` : `+${s}`;
}

/** Format a fraction (0.031) as a signed percent ("+3.10%" / "-3.10%"). */
export function signedPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return "—";
  const s = `${(Math.abs(fraction) * 100).toFixed(2)}%`;
  return fraction < 0 ? `-${s}` : `+${s}`;
}

/** Format a fraction (0.0072) as an unsigned percent ("0.72%"). */
export function pct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return "—";
  return `${(Math.abs(fraction) * 100).toFixed(2)}%`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const now = Date.now();
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const d = new Date(ts);
  const today = new Date(now);
  const sameYear = d.getFullYear() === today.getFullYear();
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateStr} ${timeStr}`;
}

const CRON_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Best-effort human description of a 5-field cron expression. Covers the common
 * minutely/hourly/daily/weekly forms; anything it can't confidently describe (e.g.
 * monthly/yearly, day-of-month, odd field combos) returns "Custom" — the raw
 * expression is still shown alongside it in the UI.
 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Custom";
  const [min, hour, dom, mon, dow] = parts;
  const wild = dom === "*" && mon === "*";
  const timeOf = (h: string, m: string): string | null => {
    const hh = Number(h);
    const mm = Number(m);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
    const period = hh < 12 ? "AM" : "PM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
  };
  const dayName = (d: string): string | null => {
    const n = Number(d);
    return Number.isInteger(n) ? CRON_DAYS[n % 7] : null;
  };
  // Day-of-week field → words, handling ranges (1-5), lists (1,3,5), and the
  // common weekday/weekend shorthands. Returns null if it can't be parsed.
  const describeDow = (d: string): string | null => {
    if (d === "1-5") return "Weekdays";
    if (d === "0,6" || d === "6,0" || d === "6,7" || d === "0,7") return "Weekends";
    const range = d.match(/^(\d)-(\d)$/);
    if (range) {
      const a = dayName(range[1]);
      const b = dayName(range[2]);
      return a && b ? `${a}–${b}` : null;
    }
    if (/^\d(,\d)*$/.test(d)) {
      const names = d.split(",").map(dayName);
      return names.every((n): n is string => n !== null) ? names.join(", ") : null;
    }
    return dayName(d);
  };

  if (expr.trim() === "* * * * *") return "Every minute";
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && wild && dow === "*") return `Every ${everyMin[1]} min`;
  if (/^\d+$/.test(min) && hour === "*" && wild && dow === "*")
    return min === "0" ? "Hourly" : `Hourly at :${min.padStart(2, "0")}`;
  const everyHour = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(min) && everyHour && wild && dow === "*") return `Every ${everyHour[1]} hours`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && wild && dow === "*") {
    const t = timeOf(hour, min);
    return t ? `Daily at ${t}` : "Custom";
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && wild && dow !== "*") {
    const t = timeOf(hour, min);
    const days = describeDow(dow);
    return t && days ? `${days} at ${t}` : "Custom";
  }
  return "Custom";
}

/** Absolute local date + time, e.g. "Jun 24, 9:00 AM". */
export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateStr}, ${timeStr}`;
}

/** Format a future timestamp as "in 3m" / "in 2h", or an absolute date/time further out. */
export function until(ts: number | null | undefined): string {
  if (!ts) return "—";
  const now = Date.now();
  const secs = Math.round((ts - now) / 1000);
  if (secs <= 0) return "due";
  if (secs < 60) return `in ${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateStr} ${timeStr}`;
}
