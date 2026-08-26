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

/**
 * Compact deadline format: `Fri 21 Aug · 23:00 IST`.
 *
 * ## Why `dateStr` is required, and why there is no fallback
 *
 * This function used to take an optional argument and answer
 * `"Fri 21 Aug · 23:00 IST"` when given nothing — GW1's real deadline, copied out of
 * a design document and baked permanently into a shared formatter. Any caller that
 * had no deadline to show rendered that one as fact, and on screen an invented
 * deadline is indistinguishable from a measured one. On a pre-deadline planner it is
 * close to the worst single wrong number available.
 *
 * So absence is the CALLER's decision now: the type stops a caller from asking this
 * function to invent one, and each surface says in its own words that it does not
 * know. `components/DeadlineClock.tsx` is the one caller, and it renders a line of
 * prose rather than a time.
 *
 * An unparseable string comes back unchanged, which is what `istDateTime` above
 * already does — degrade to the input rather than fabricate a substitute. The
 * invariant `lib/formats.test.ts` pins is that there is no input for which this
 * returns a date it was not given.
 */
export function compactIstDeadline(dateStr: string): string {
  if (dateStr == null) return dateStr;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
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
/**
 * How long a weekday still names one day.
 *
 * Six, not seven: at exactly seven the weekday repeats, and a boundary that only fails
 * at the collision is a boundary that ships the collision.
 */
const WEEKDAY_IS_UNAMBIGUOUS_HOURS = 6 * 24;

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
  //
  // A weekday alone only identifies an instant inside the current week. Past that it
  // names two days and the reader picks the recent one: `accuracy.json` and
  // `evidence_view.json` are 5.3 days old today and render "as at Thu 18:53", which on a
  // Wednesday reads as yesterday. At seven days it is strictly ambiguous. So beyond the
  // week the date replaces the weekday — day and month, the same format
  // `fpl-live-server.ts` uses for the capture date and for the same reason: a provenance
  // line the reader can check.
  const withinTheWeek = ms >= 0 && hours < WEEKDAY_IS_UNAMBIGUOUS_HOURS;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE,
    ...(withinTheWeek
      ? { weekday: "short" as const }
      : { day: "numeric" as const, month: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(then);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const when = withinTheWeek
    ? get("weekday")
    : `${get("day")} ${get("month")}`;
  return `as at ${when} ${get("hour")}:${get("minute")}`;
}

/*
 * What used to be here: the betting surface's formatters.
 *
 * `confidenceColor`, `edgeColor`, `predictionLabel`, `impliedOdds` and
 * `featureName` dressed a value-bet card and a SHAP waterfall — screens that went
 * with the single-team cut. `shortDate`, `calendarDate` and `deadlineStamp` were
 * three more date spellings on top of the four that remain, none with a caller.
 *
 * All eight had a test and no reader, which is the shape that keeps a dead module
 * alive: a green suite over code nothing renders reads as coverage. This file is
 * now sixteen exports down to eight, and every one of the eight is called from a
 * screen. `ageLine` was the ninth until this pass wired it — it had a 134-line
 * dedicated test and zero callers while all three provenance strips rendered the
 * relative form its own docstring forbids.
 */
