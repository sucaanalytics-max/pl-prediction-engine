import { redirect } from "next/navigation";

/**
 * Superseded by `/decide`.
 *
 * This page rendered `captainPlan` and `transferScenarios` from
 * `lib/fpl-portal.ts` — a six-gameweek captaincy plan carrying `confidence: 91`
 * for picks nobody computed, and transfer scenarios with hand-written point
 * gains. Invented precision is worse than the badged heuristic it sat next to:
 * the heuristic at least calculates something and says what it is.
 *
 * `/decide` carries the real captaincy plan and transfer shortlist, and labels
 * their provenance.
 */
export default function PlannerRedirect() {
  redirect("/decide");
}
