/**
 * The one FPL entry this app is for.
 *
 * ## Why this is a constant and not a list
 *
 * `lib/control-room/model.ts` held a three-team model — the owner plus Ronny
 * (2561567) and Wazza (2561099) — and it outlived the screen it was written for.
 * `/control-room` was deleted; the model was not, and the write path went on
 * deriving its allowlist from that list's `kind === "bot"` entries. So
 * `/api/hub/position` accepted captures for the two entries that had detached to
 * their own project and refused the only entry this repo decides for, and
 * `/capture` offered the same two as its targets. Both were reading a true list
 * of a world that no longer existed.
 *
 * One exported number, read by the route and by the form, is what stops a second
 * answer to "which entry is this app for" from existing at all.
 *
 * ## The authority this mirrors
 *
 * `pipeline/config.py:453` `FPL_ENTRIES` — one entry, keyed `owner`, objective
 * `season`. That file decides who the agent solves for. This constant only
 * decides whose position a browser may capture, and the two must agree: a
 * capture is committed to `predictions/fpl/hub/capture/{entryId}.json`, and
 * `_read_entry` (`pipeline/learning/run_agent.py:1023`) opens exactly one such
 * path — the one named by `FPL_ENTRIES`. A capture written under any other id is
 * a file nothing ever reads.
 *
 * Deliberately NOT env-driven, unlike {@link FPL_ENTRY_ID} in `lib/fpl-live.ts`
 * which chooses whose squad to *display*. An override there shows a different
 * team; an override here would accept a capture the agent cannot consume.
 */
export const OWNER_ENTRY = 20945;
