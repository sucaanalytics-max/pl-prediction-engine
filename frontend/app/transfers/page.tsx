import { redirect } from "next/navigation";

/**
 * Superseded by `/decide`.
 *
 * The single-move shortlist moved across whole — rank, both deltas, bank,
 * confidence and the rationale, which is the only checkable part of a heuristic.
 * The 4/6 horizon toggle became two columns instead, so both are visible at once
 * rather than one being a click away.
 *
 * Redirected rather than deleted: the service worker and any bookmark still
 * point here. This route was never on `main` and returned 404 in production,
 * so nothing that ever worked is being taken away.
 */
export default function TransfersRedirect() {
  redirect("/decide");
}
