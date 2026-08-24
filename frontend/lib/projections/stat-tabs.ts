/**
 * What the stats screen can show, and what it cannot.
 *
 * A tab is defined by the artifact it needs. That is the whole design: the
 * question "can we build a Defending tab" has one answer, and it is a fact about
 * a published file rather than a matter of effort. Encoding it here means the
 * screen greys the tab and names the missing feed, instead of rendering an empty
 * column that a reader has to interpret.
 *
 * ## Why blocked tabs are shown at all
 *
 * A tab that is absent tells the reader nothing; a tab that is struck through with
 * a reason tells them the column exists in the game, is not in this app, and why.
 * The alternative — omitting it — invites the same feature to be requested again,
 * and invites a future contributor to fill it with something that resembles it.
 * FPL publishes defensive contributions, set-piece order and transfer counts in
 * its own bootstrap; this pipeline does not carry them into an artifact yet, which
 * is a small piece of work rather than a missing capability.
 */

export type StatSource = "playerStats" | "projections" | "playerEvents";

export interface StatTab {
  readonly key: string;
  readonly label: string;
  /** The artifact this tab reads. Null for a tab nothing published can fill. */
  readonly source: StatSource | null;
  /** One line, shown on hover and beside the table. */
  readonly note: string;
  /** For a blocked tab: what is missing, in the reader's terms. */
  readonly blockedBy?: string;
}

export const STAT_TABS: readonly StatTab[] = [
  {
    key: "season",
    label: "Season",
    source: "playerStats",
    note: "What has actually happened: minutes, goals, assists, and FPL's own xG and "
      + "xA. Per-90 columns are withheld below 90 minutes played, because a rate over "
      + "eight minutes is arithmetic rather than a measurement.",
  },
  {
    key: "expected",
    label: "Expected",
    source: "projections",
    note: "The simulation's view of the coming gameweek: expected points and the "
      + "pieces they are made of. Every figure here is a forecast, and the spread "
      + "beside it is what says how much to trust it.",
  },
  {
    key: "shots",
    label: "Shots & creation",
    source: "playerEvents",
    note: "Understat's own count of shots and chances created, plus a SECOND xG model "
      + "that disagrees with FPL's by design. The disagreement is the information; "
      + "neither is a correction of the other.",
  },
  {
    key: "defending",
    label: "Defending",
    source: null,
    note: "Clearances, blocks, interceptions, tackles and recoveries — the numbers "
      + "behind FPL's defensive-contribution points.",
    blockedBy: "FPL publishes these in its bootstrap; this pipeline does not carry "
      + "them into an artifact yet. Greyed rather than filled with something that "
      + "resembles them.",
  },
  {
    key: "setpieces",
    label: "Set pieces",
    source: null,
    note: "Who takes the penalties, the corners and the free kicks, and where in the "
      + "order they stand.",
    blockedBy: "FPL publishes a set-piece order per club; nothing here reads it yet. "
      + "Guessing it from past goals would invent a hierarchy the clubs did not set.",
  },
  {
    key: "market",
    label: "Market",
    source: null,
    note: "Transfers in and out this gameweek, price movement, and how owned a player "
      + "is against how well he is doing.",
    blockedBy: "Transfer counts and price deltas are in FPL's bootstrap and are not "
      + "published by this pipeline. Ownership alone is available and sits in the "
      + "Season tab.",
  },
];

export function tabByKey(key: string): StatTab {
  return STAT_TABS.find((tab) => tab.key === key) ?? STAT_TABS[0];
}

/** The tabs a reader can actually open. */
export function livedTabs(): readonly StatTab[] {
  return STAT_TABS.filter((tab) => tab.source !== null);
}

/** The tabs that exist in the game and not in this app. */
export function blockedTabs(): readonly StatTab[] {
  return STAT_TABS.filter((tab) => tab.source === null);
}
