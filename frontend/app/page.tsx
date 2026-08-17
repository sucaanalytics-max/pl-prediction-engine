import { redirect } from "next/navigation";

/**
 * The front door, which opens on the workspace.
 *
 * It pointed at `/now` — correct when `/now` replaced a homepage whose headline
 * numbers came from 205 lines of hand-typed placeholder squad data. Then the app
 * was restructured into four tabs at `/margin`, Plan was made the default, and
 * this line was never moved: the workspace the restructure exists for sat one
 * click away behind a sidebar, and every visitor landed on the screen it
 * replaced.
 *
 * `/now` is still a real page and still linked. Everything it shows is in the
 * workspace too — the squad and the call on Plan, the change ledger on Now —
 * so this is about which one a visitor meets first, not about removing it.
 *
 * A redirect rather than a 404: this is the most-bookmarked URL in the app and
 * the service worker precaches it.
 */
export default function RootRedirect() {
  redirect("/margin");
}
