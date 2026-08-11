import { redirect } from "next/navigation";

/**
 * Superseded by `/players`.
 *
 * The per-gameweek projection columns, the search and the coverage line moved
 * into the ranked-players section. Its headline numbers came from a paid
 * competitor CSV that is no longer a build input; the section now names its
 * source, which is `fallback` whenever that export is absent.
 *
 * Redirected rather than deleted: the service worker and any bookmark still
 * point here. This route was never on `main` and returned 404 in production,
 * so nothing that ever worked is being taken away.
 */
export default function ProjectionsRedirect() {
  redirect("/players");
}
