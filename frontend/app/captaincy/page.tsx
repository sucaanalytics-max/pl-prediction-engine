import { redirect } from "next/navigation";

/**
 * Superseded by `/decide`.
 *
 * The captaincy plan moved intact: gameweek, captain, vice, fixture, projected
 * points and confidence.
 *
 * Redirected rather than deleted: the service worker and any bookmark still
 * point here. This route was never on `main` and returned 404 in production,
 * so nothing that ever worked is being taken away.
 */
export default function CaptaincyRedirect() {
  redirect("/decide");
}
