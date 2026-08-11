import { redirect } from "next/navigation";

/**
 * Superseded by `/markets`.
 *
 * A redirect rather than a deletion because the route is bookmarkable and is
 * precached by the service worker, whose `cache.addAll` is all-or-nothing — a
 * missing entry makes the whole `install` event reject and the worker never
 * activates, disabling offline support entirely.
 *
 * Only redirected once `/markets` reached parity: market and confidence filters,
 * search, four-key sort, CSV export and the bookmaker column all moved across,
 * verified feature by feature. Redirecting before that would have deleted working
 * behaviour to make a refactor look finished.
 *
 * `/markets` additionally shows, per bet, whether the edge has the bookmaker's
 * margin removed — which this page could not, because the field it needed was
 * never read.
 */
export default function ValueBetsRedirect() {
  redirect("/markets");
}
