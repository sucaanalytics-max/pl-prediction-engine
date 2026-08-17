/**
 * News, and the two things it refuses to take from the artifact.
 *
 * `touches_squad` is false on all ninety published items — not a matching bug:
 * the poller reads the squad from a decision file the deadline-gated agent has
 * not written, so it answered a question it had no information for. This view
 * therefore does its own join against the live fifteen and ignores that field.
 *
 * These pin both halves: a squad that IS known marks the right items, and a
 * squad that is NOT known says so rather than showing an empty "nothing about
 * your team", which reads as good news and is the more expensive failure.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewsView } from "@/components/margin/NewsView";
import { resetHeuristicsForTests } from "@/lib/data/useHeuristics";

const FEED = {
  schema_version: 1,
  generated_at: "2026-08-17T00:00:00Z",
  n_dropped: 0,
  window_days: 5,
  n_articles: 5,
  n_shown: 5,
  dropped_by_source: {},
  basis: "A reading list. None of this has moved a projection.",
  items: [
    {
      digest: "a1",
      headline: "How Chelsea could line up under Xabi Alonso",
      summary: "In this blog, we look at how Chelsea could line up.",
      source: "allaboutfpl",
      tier: 3,
      url: "https://allaboutfpl.com/chelsea/",
      claimed_at: "2026-08-16T14:55:36Z",
      // Resolved by the producer, and owned by the manager in these tests.
      players: [{ element_id: 391, name: "Gvardiol", club: "MCI", held: false }],
      touches_squad: false,
    },
    {
      digest: "b2",
      headline: "Opta match report cards for the friendlies",
      summary: null,
      source: "x:robtFPL",
      tier: 3,
      url: "https://x.com/robtFPL/status/1",
      claimed_at: "2026-08-15T15:28:32Z",
      players: [{ element_id: 999, name: "Nobody", club: "AVL", held: false }],
      touches_squad: false,
    },
    // Three BBC items against one allaboutfpl, because that asymmetry IS the
    // thing under test. With one item per source every count was 1, the
    // count tiebreak was a no-op, and stable sort put allaboutfpl first by
    // insertion order — so the ordering test passed with the preferred-source
    // rule deleted entirely. Verified by mutation.
    ...[1, 2, 3].map((n) => ({
      digest: `c${n}`,
      headline: `Bournemouth story ${n}`,
      summary: `Bournemouth vow to do better, part ${n}.`,
      source: "bbc_football",
      tier: 3,
      url: `https://bbc.co.uk/${n}`,
      claimed_at: "2026-08-16T13:00:00Z",
      players: [],
      touches_squad: false,
    })),
  ],
};

/**
 * A squad holding exactly the player the allaboutfpl piece is about.
 *
 * The shape is the live route's, not the narrower's — `useHeuristics` fetches
 * `/api/fpl/state` and narrows it, so a hand-built inner shape would test the
 * fixture rather than the join.
 */
const SQUAD = {
  schemaVersion: 4,
  generatedAt: "2026-08-17T00:00:00Z",
  season: "2026/27",
  entry: { id: 20945, teamName: "Margin FC" },
  event: { id: 1, deadlineTime: "2026-08-21T17:30:00Z" },
  freshness: { squad: "captured" },
  projections: { source: "fallback", sourceLabel: "No FPLReview export" },
  squad: {
    source: "captured_authenticated_draft",
    value: 100.0,
    bank: 0.8,
    formation: "4-4-2",
    players: [
      {
        elementId: 391, name: "Gvardiol", position: "DEF", team: "MCI",
        price: 5.5, bench: false, status: undefined, fixture: "BUR (H)",
      },
    ],
  },
  fixtureMatrix: [],
  // Required by the narrower. Omitting them failed the whole document, so the
  // squad came back null and the join had nothing to match — which looked
  // exactly like the bug under test rather than like a broken fixture.
  recommendations: {
    modelVersion: "heuristic-only",
    transfers4: [],
    multiTransferPlans4: [],
    captaincyPlan: [],
  },
  rankings: {
    overall: [], captaincy: [], value: [], differentials: [],
    goalkeepers: [], defenders: [], midfielders: [], forwards: [],
  },
};

function mockFetch(feed: unknown, live: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("news_view")) {
      if (feed === undefined) return new Response("", { status: 404 });
      return new Response(JSON.stringify(feed), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/fpl/state")) {
      // The route answers `{ data }` on success and `{ error }` on failure, both
      // with a 200 — `useHeuristics` separates them on the `data` key, so a bare
      // body narrows to absent and looks exactly like the bug under test.
      const body = live === null ? { error: "live route unavailable" } : { data: live };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  });
}

/**
 * `null` is the absent squad, not `undefined`.
 *
 * A default parameter fires on `undefined`, so `draw(undefined)` handed the
 * caller the very squad it was trying to remove — the two absence tests passed
 * a squad in and asserted it was missing.
 */
async function draw(live: unknown = SQUAD, feed: unknown = FEED) {
  vi.stubGlobal("fetch", mockFetch(feed, live));
  render(<NewsView />);
  await screen.findByTestId("margin-news");
  await new Promise((resolve) => setTimeout(resolve, 60));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  // The live squad is resolved once per module, so without this the first test's
  // fetch decides every later one.
  resetHeuristicsForTests();
});
afterEach(() => {
  cleanup();
  resetHeuristicsForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the squad join happens here, not in the artifact", () => {
  it("marks an item about a player you own, though the artifact says otherwise", async () => {
    // Every item arrives with `touches_squad: false`. Trusting it would mark none.
    await draw();
    const owned = document.querySelectorAll("[data-owned='yes']");
    expect(owned).toHaveLength(1);
    expect(owned[0].textContent).toContain("Gvardiol");
  });

  it("leaves an item about nobody you own unmarked", async () => {
    await draw();
    expect(document.querySelectorAll("[data-owned='no']")).toHaveLength(4);
  });

  it("says the squad is unknown rather than showing nothing is yours", async () => {
    // The failure that matters: an empty "nothing about your team" reads as
    // reassurance when the truth is that we never knew the team.
    await draw(null);
    expect(screen.getByTestId("news-squad-state")).toHaveAttribute("data-known", "no");
    expect(screen.getByTestId("news-squad-state").textContent)
      .toMatch(/your squad is not loaded/);
    expect(document.querySelectorAll("[data-owned='yes']")).toHaveLength(0);
  });

  it("disables the my-fifteen filter when there is nothing to match against", async () => {
    await draw(null);
    expect(screen.getByTestId("news-filter-mine")).toBeDisabled();
  });
});

describe("sources are reachable rather than merely present", () => {
  it("offers every source with its real count", async () => {
    await draw();
    const labels = [...screen.getAllByTestId("news-filter-source")]
      .map((b) => b.textContent);
    expect(labels.some((l) => l?.includes("allaboutfpl"))).toBe(true);
    expect(labels.some((l) => l?.includes("@robtFPL"))).toBe(true);
  });

  it("filters to one source when it is chosen", async () => {
    await draw();
    const button = [...screen.getAllByTestId("news-filter-source")]
      .find((b) => b.textContent?.includes("allaboutfpl"))!;
    fireEvent.click(button);
    expect(screen.getAllByTestId("news-item")).toHaveLength(1);
  });

  it("puts the FPL-specific sources ahead of the volume feeds", async () => {
    // allaboutfpl contributes 1 item against BBC's 3 here and BBC's 33 in the
    // real feed. Sorting the filter row by count is exactly what buries it, so
    // the preferred source must lead DESPITE having the smaller count.
    await draw();
    const labels = [...screen.getAllByTestId("news-filter-source")]
      .map((b) => b.textContent ?? "");
    expect(labels[0]).toContain("allaboutfpl");
    expect(labels.findIndex((l) => l.includes("allaboutfpl")))
      .toBeLessThan(labels.findIndex((l) => l.includes("bbc_football")));
  });
});

describe("reading the article in the app", () => {
  /**
   * `allaboutfpl.com` sends `x-frame-options: SAMEORIGIN`, so an embedded pane
   * renders nothing. The feed carries the whole article instead, and the route
   * turns it into paragraphs.
   */
  function withArticle(paragraphs: string[]) {
    const base = mockFetch(FEED, SQUAD);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/news/article")) {
        return new Response(JSON.stringify({ data: { title: "t", url: "u", paragraphs } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }));
  }

  it("offers to read only the sources whose feed carries a body", async () => {
    /**
     * The fixture holds five items across three sources, and only allaboutfpl is
     * in ARTICLE_FEEDS. BBC and X are in the reading list and cannot be read in
     * full, so their control is absent rather than present and failing.
     */
    await draw();
    expect(screen.getAllByTestId("news-item")).toHaveLength(5);
    const buttons = screen.getAllByTestId("news-read");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].closest("[data-testid='news-item']")?.textContent)
      .toContain("allaboutfpl");
  });

  it("renders the paragraphs the route returned", async () => {
    await draw();
    withArticle(["Chelsea line up in a 4-2-3-1.", "Palmer starts behind the striker."]);
    fireEvent.click(screen.getAllByTestId("news-read")[0]);
    expect(await screen.findByText(/Palmer starts behind the striker/)).toBeInTheDocument();
  });

  it("says why when there is no body, and keeps the link", async () => {
    // An article older than the ten-item feed is a real state within a day.
    await draw();
    const base = mockFetch(FEED, SQUAD);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/news/article")) {
        return new Response(JSON.stringify({ error: "That article has scrolled out of the feed." }),
          { status: 404, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }));
    fireEvent.click(screen.getAllByTestId("news-read")[0]);
    expect(await screen.findByTestId("news-body-refused")).toHaveTextContent(/scrolled out/);
    // The way out survives every failure.
    expect(screen.getByText(/How Chelsea could line up/).closest("a")).not.toBeNull();
  });
});

describe("the article's own summary", () => {
  it("renders the teaser the store has been keeping", async () => {
    await draw();
    expect(screen.getByText(/we look at how Chelsea could line up/)).toBeInTheDocument();
  });

  it("renders no body for an item that never had one", async () => {
    // Four of the five carry a summary; the robtFPL post does not.
    await draw();
    expect(screen.getAllByTestId("news-summary")).toHaveLength(4);
  });
});
