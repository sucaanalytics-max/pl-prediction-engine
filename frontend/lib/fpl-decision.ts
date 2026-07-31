/**
 * Loading and freshness for the FPL agent's published decision.
 *
 * The freshness state machine is the whole point of this module. A decision is
 * advice about one specific deadline, and after that deadline it is not merely
 * old — it is wrong, and acting on it costs a gameweek. So the page must be able
 * to distinguish four situations and never quietly render the third or fourth as
 * though it were the first:
 *
 *   READY    — for the current gameweek, deadline still ahead. Act on it.
 *   EXPIRED  — the deadline has passed. Do not act on it.
 *   STALE    — published for a different gameweek than the one now current,
 *              which means the agent has not run for this one.
 *   ABSENT   — nothing published. Distinct from "published with no changes".
 *
 * Mirrors the Python contract in `pipeline/fpl/artifacts.py`. The artifact
 * served here is the stripped public projection: no entry ids, no
 * counterfactuals.
 */

export type DecisionFreshness = "ready" | "expired" | "stale" | "absent";

export interface DecisionTransfer {
  out: string;
  in: string;
  note?: string;
}

export interface DecisionTeam {
  label: string;
  objective?: string;
  captain?: string;
  viceCaptain?: string;
  transfers?: DecisionTransfer[];
  chip?: string | null;
  projectedPoints?: number;
  projectedInterval?: string;
  /** Anything other than "ok" must be surfaced, not styled away. */
  status?: string;
}

export interface Decision {
  gameweek: number;
  deadline: string;
  generatedAt: string;
  teams: DecisionTeam[];
  notices?: string[];
  metadata?: Record<string, unknown>;
}

export interface DecisionView {
  freshness: DecisionFreshness;
  decision: Decision | null;
  /** Human-readable explanation of the freshness state. */
  reason: string;
  msToDeadline: number | null;
}

/** Milliseconds until the deadline; negative once it has passed. */
export function msToDeadline(deadline: string, now: Date): number | null {
  const parsed = Date.parse(deadline);
  return Number.isNaN(parsed) ? null : parsed - now.getTime();
}

/**
 * Classify a decision against the current gameweek and time.
 *
 * `currentGameweek` is passed in rather than read from the artifact: comparing
 * the artifact to itself could never detect that the agent failed to run.
 */
export function classifyDecision(
  decision: Decision | null,
  currentGameweek: number | null,
  now: Date = new Date(),
): DecisionView {
  if (!decision) {
    return {
      freshness: "absent",
      decision: null,
      reason: "No decision has been published yet.",
      msToDeadline: null,
    };
  }

  const remaining = msToDeadline(decision.deadline, now);

  if (remaining !== null && remaining <= 0) {
    return {
      freshness: "expired",
      decision,
      reason: `The GW${decision.gameweek} deadline has passed. Do not act on this.`,
      msToDeadline: remaining,
    };
  }

  if (currentGameweek !== null && decision.gameweek !== currentGameweek) {
    return {
      freshness: "stale",
      decision,
      reason:
        `This decision is for GW${decision.gameweek}, but GW${currentGameweek} ` +
        `is now current. The agent has not published for this gameweek.`,
      msToDeadline: remaining,
    };
  }

  return {
    freshness: "ready",
    decision,
    reason: `GW${decision.gameweek} deadline in ${formatRemaining(remaining)}.`,
    msToDeadline: remaining,
  };
}

/** Compact "3h 20m" style countdown. */
export function formatRemaining(ms: number | null): string {
  if (ms === null) return "unknown";
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Map the artifact's snake_case to the camelCase the UI uses. */
export function parseDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, any>;
  if (typeof source.gameweek !== "number") return null;

  return {
    gameweek: source.gameweek,
    deadline: String(source.deadline ?? ""),
    generatedAt: String(source.generated_at ?? source.generatedAt ?? ""),
    notices: Array.isArray(source.notices) ? source.notices.map(String) : [],
    metadata: source.metadata ?? {},
    teams: Array.isArray(source.teams)
      ? source.teams.map((team: Record<string, any>) => ({
          label: String(team.label ?? team.objective ?? "team"),
          objective: team.objective,
          captain: team.captain,
          viceCaptain: team.vice_captain ?? team.viceCaptain,
          transfers: Array.isArray(team.transfers)
            ? team.transfers.map((move: Record<string, any>) => ({
                out: String(move.out ?? ""),
                in: String(move.in ?? ""),
                note: move.note,
              }))
            : [],
          chip: team.chip ?? null,
          projectedPoints: team.projected_points ?? team.projectedPoints,
          projectedInterval: team.projected_interval ?? team.projectedInterval,
          status: team.status,
        }))
      : [],
  };
}

/**
 * Fetch the published decision.
 *
 * A 404 is the normal state before the agent has ever published, so it resolves
 * to null rather than throwing — "absent" is a state the UI renders, not an
 * error.
 */
export async function loadDecision(
  basePath = "/predictions/fpl",
): Promise<Decision | null> {
  try {
    const response = await fetch(`${basePath}/decision_latest.json`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return parseDecision(await response.json());
  } catch {
    return null;
  }
}
