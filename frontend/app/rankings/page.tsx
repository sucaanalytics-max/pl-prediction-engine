import { redirect } from "next/navigation";

/**
 * Superseded by `/players`.
 *
 * All eight categories moved across as tabs, along with the watchlist. The
 * `data-testid` on each row is asserted in `app/players/page.test.tsx`, so a
 * category dropped in a future edit fails a test rather than vanishing.
 *
 * Redirected rather than deleted: the service worker and any bookmark still
 * point here. This route was never on `main` and returned 404 in production,
 * so nothing that ever worked is being taken away.
 */
export default function RankingsRedirect() {
  redirect("/players");
}
