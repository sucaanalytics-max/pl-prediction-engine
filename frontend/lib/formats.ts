/**
 * Number formatting utilities for the PL Prediction Engine.
 */

export const DISPLAY_TIME_ZONE = "Asia/Kolkata";

/** Format a probability as a percentage string (e.g. 0.523 → "52.3%") */
export function pct(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Format decimal odds (e.g. 2.15 → "2.15") */
export function odds(value: number): string {
  return value.toFixed(2);
}

/** Format expected goals / xG (e.g. 1.723 → "1.72") */
export function xg(value: number): string {
  return value.toFixed(2);
}

/** Format a date string to "Sat 1 Mar" style */
export function shortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Format a date-only API value without allowing the browser timezone to move it
 * into the previous or next day (e.g. "2025-12-30T00:00:00" → "30 Dec 2025").
 */
export function calendarDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!match) return dateStr;

  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex >= monthNames.length) return dateStr;

  return `${match[3]} ${monthNames[monthIndex]} ${match[1]}`;
}

/** Format a date string to "15:00" style */
export function kickoffTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " IST";
}

/** Format a timestamp as a deterministic Kolkata date and time. */
export function istDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date) + " IST";
}

/** Compact deadline format used in navigation and cards. */
export function compactIstDeadline(dateStr?: string): string {
  if (!dateStr) return "Fri 21 Aug · 23:00 IST";
  const date = new Date(dateStr);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${day} · ${time} IST`;
}

/** Format a feature name for display (snake_case → Title Case) */
export function featureName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Confidence color class based on percentage */
export function confidenceColor(pct: number): string {
  if (pct >= 55) return "text-emerald-400";
  if (pct >= 45) return "text-amber-400";
  return "text-red-400";
}

/** Edge color for value bets */
export function edgeColor(edge: number): string {
  if (edge >= 0.10) return "text-emerald-400";
  if (edge >= 0.05) return "text-amber-400";
  return "text-slate-400";
}

/** Get result indicator emoji/label */
export function predictionLabel(pred: string): string {
  switch (pred) {
    case "home": return "H";
    case "draw": return "D";
    case "away": return "A";
    default: return pred.toUpperCase();
  }
}

/** Probability → implied odds */
export function impliedOdds(prob: number): string {
  if (prob <= 0) return "∞";
  return (1 / prob).toFixed(2);
}

/** Time since last update */
export function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHrs > 0) return `${diffHrs}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return "just now";
}

/**
 * The age line: how old the thing beside it is, in a form the reader can check.
 *
 * Two forms, and the switch between them is the whole point:
 *
 *   - inside a day  ->  `6h old`
 *   - beyond a day  ->  `as at Tue 06:30`
 *
 * `describeAge` in `lib/data/artifact.ts` keeps returning "3 days" for the
 * second case, and "3 days" is a relative claim the reader cannot verify — three
 * days from when? A weekday and a clock time can be checked against the fixture
 * list, the last deadline, or a memory of when the pipeline ran. Inside a day the
 * relative form is fine, because "6h old" and "as at 06:30" carry the same
 * information and the first is shorter.
 *
 * It lives here rather than beside `describeAge` because `artifact.ts` imports
 * nothing at all — it is the pure state machine — and this needs the display
 * zone. Age is a display concern; the state machine should not learn about time
 * zones to serve it.
 *
 * Null when there is no timestamp: the caller renders nothing rather than
 * "unknown", because the exception for absence is about data never computed, not
 * about a value whose clock we happen not to know.
 */
export function ageLine(
  producedAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!producedAt) return null;
  const then = new Date(producedAt);
  if (Number.isNaN(then.getTime())) return null;

  const ms = now.getTime() - then.getTime();
  const hours = Math.floor(Math.abs(ms) / 3_600_000);

  if (ms >= 0 && hours < 24) {
    // Under an hour still reads in hours, not minutes: these artifacts are
    // written by a cron, so minute precision would imply a freshness the
    // producer does not have.
    return `${hours}h old`;
  }

  // Beyond a day — or a future stamp, from clock skew or a mis-stamped file —
  // state the instant instead of a duration. A future age rendered as "0h old"
  // would be a quiet lie; rendered as an instant it is visibly wrong, which is
  // what we want.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(then);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `as at ${get("weekday")} ${get("hour")}:${get("minute")}`;
}

/**
 * A deadline written in the zone the deadline itself states.
 *
 * `Fri 21 Aug 2026 · 17:30 UTC` from `2026-08-21T17:30:00+00:00`.
 *
 * Deliberately NOT {@link DISPLAY_TIME_ZONE}. Every other timestamp in this app
 * is a reading of something that happened, and the reader's own zone is the right
 * frame for those. An FPL deadline is different: it is published in one zone, it
 * is quoted in that zone everywhere FPL and its community discuss it, and a
 * masthead that renders it as `23:00 IST` invites a reader to check it against a
 * source that says 17:30 and conclude the clock is wrong. So the stamp follows the
 * artifact's own offset, and it names that offset so the figure can be checked.
 *
 * Null when there is no timestamp, when it does not parse, or when it states no
 * zone at all. The last case is the reason this reads the string rather than the
 * `Date`: a naive `2026-08-21T17:30:00` has no zone to be faithful to, and
 * labelling it `UTC` would be an invention on the one figure the whole screen
 * counts down to.
 */
export function deadlineStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;

  const zone = /(Z)$|([+-])(\d{2}):?(\d{2})$/.exec(iso.trim());
  if (!zone) return null;

  const offsetMinutes = zone[1]
    ? 0
    : (zone[2] === "-" ? -1 : 1) * (Number(zone[3]) * 60 + Number(zone[4]));

  // Shift the instant and then format it in UTC: that reproduces the wall clock
  // an observer at the stated offset would read, without asking Intl for a named
  // zone the artifact never gave us.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(at + offsetMinutes * 60_000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const label = offsetMinutes === 0
    ? "UTC"
    : `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:`
      + `${String(abs % 60).padStart(2, "0")}`;

  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")} · `
    + `${get("hour")}:${get("minute")} ${label}`;
}
