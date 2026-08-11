import { redirect } from "next/navigation";

/**
 * Superseded by `/now`.
 *
 * Overview and Now answered the same question — "what should I look at" — and
 * Now answers it from published artifacts while this page answered it from
 * `lib/fpl-portal.ts`, which is 205 lines of hand-typed placeholder squad data.
 * A dashboard whose headline numbers are invented is the failure this rebuild
 * exists to remove, so the duplicate goes rather than being kept in sync.
 *
 * The root redirects rather than 404s: it is the most-bookmarked URL in the app
 * and the service worker precaches it.
 */
export default function RootRedirect() {
  redirect("/now");
}
