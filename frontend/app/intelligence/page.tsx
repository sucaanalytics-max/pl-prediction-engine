import { redirect } from "next/navigation";

/**
 * Superseded by `/now`.
 *
 * This page rendered `intelligenceItems` from `lib/fpl-portal.ts`: a hand-typed
 * list of article summaries with invented `age` and `confidence` fields. It read
 * no artifact and made no request — every word on it was written by hand and
 * presented as a research feed.
 *
 * `/now` answers the same question from the news connectors that actually poll
 * those sources, and shows what changed rather than what someone typed.
 */
export default function IntelligenceRedirect() {
  redirect("/now");
}
