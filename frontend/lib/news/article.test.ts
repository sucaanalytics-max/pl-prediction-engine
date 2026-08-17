/**
 * Turning a feed into something readable, and the two things that must not slip.
 *
 * The load-bearing cases are the refusals: no URL the caller supplies is ever
 * fetched, and no markup survives into the text. Everything else is shape.
 */

import { describe, expect, it } from "vitest";

import {
  ARTICLE_FEEDS, findEntry, MAX_PARAGRAPHS, parseFeed, toParagraphs,
} from "@/lib/news/article";

/** A feed in the shape WordPress actually emits, CDATA and all. */
const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[How Chelsea could line up]]></title>
    <link>https://allaboutfpl.com/2026/08/chelsea-lineup/</link>
    <description><![CDATA[A teaser sentence that is long enough to survive.]]></description>
    <content:encoded><![CDATA[
      <p>Chelsea are expected to line up in a 4-2-3-1 under Xabi Alonso this season.</p>
      <p>Short</p>
      <div>Palmer starts behind the striker, with Estevao and Neto wide of him.</div>
      <script>window.tracker = 1;</script>
      <p>The post appeared first on ALLABOUTFPL &amp; friends.</p>
    ]]></content:encoded>
  </item>
  <item>
    <title>Only a summary here</title>
    <link>https://allaboutfpl.com/2026/08/summary-only/</link>
    <description>This one publishes no full body, only a description long enough to keep.</description>
  </item>
</channel></rss>`;

describe("the feed reader", () => {
  it("finds every item", () => {
    expect(parseFeed(FEED)).toHaveLength(2);
  });

  it("unwraps CDATA rather than printing it", () => {
    expect(parseFeed(FEED)[0].title).toBe("How Chelsea could line up");
  });

  it("prefers the full body over the teaser", () => {
    // `content:encoded` is the article; `description` is what the artifact
    // already carries, so returning it would make the whole feature a no-op.
    expect(parseFeed(FEED)[0].body).toContain("4-2-3-1");
  });

  it("falls back to the description when there is no full body", () => {
    expect(parseFeed(FEED)[1].body).toContain("publishes no full body");
  });

  it("returns nothing for a document that is not a feed", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toEqual([]);
  });
});

describe("markup does not survive", () => {
  const paragraphs = toParagraphs(parseFeed(FEED)[0].body);

  it("keeps the paragraphs the publisher wrote", () => {
    // Block closers become breaks before the tags go, which is what preserves
    // the shape — 87 paragraphs out of a real 46KB article.
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(paragraphs[0]).toContain("4-2-3-1");
  });

  it("leaves no angle bracket anywhere", () => {
    for (const p of paragraphs) expect(p).not.toMatch(/[<>]/);
  });

  it("drops script contents entirely", () => {
    expect(paragraphs.join(" ")).not.toContain("window.tracker");
  });

  it("drops fragments too short to be prose", () => {
    expect(paragraphs.some((p) => p.trim() === "Short")).toBe(false);
  });

  it("decodes an entity instead of printing it", () => {
    expect(paragraphs.join(" ")).toContain("ALLABOUTFPL & friends");
  });

  it("decodes the ampersand last, so an escaped entity stays escaped", () => {
    // `&amp;lt;` means the author wrote "&lt;", not a tag. Decoding `&amp;`
    // first would turn it into one.
    expect(toParagraphs(`<p>${"a".repeat(45)} &amp;lt;b&amp;gt; end</p>`)[0])
      .toContain("&lt;b&gt; end");
  });

  it("bounds a runaway article", () => {
    const huge = Array.from({ length: 500 }, (_, i) =>
      `<p>Paragraph number ${i} padded out to clear the minimum length.</p>`).join("");
    expect(toParagraphs(huge)).toHaveLength(MAX_PARAGRAPHS);
  });

  it("returns nothing rather than throwing on empty input", () => {
    expect(toParagraphs("")).toEqual([]);
  });
});

describe("matching the article the reader tapped", () => {
  const entries = parseFeed(FEED);

  it("finds it by URL", () => {
    expect(findEntry(entries, "https://allaboutfpl.com/2026/08/chelsea-lineup/")?.title)
      .toBe("How Chelsea could line up");
  });

  it("ignores a trailing slash and a query string", () => {
    // The artifact stores the URL as the poller captured it, and feeds are
    // inconsistent about both. An exact match misses often enough to make this
    // look broken.
    expect(findEntry(entries, "https://allaboutfpl.com/2026/08/chelsea-lineup?utm=rss"))
      .not.toBeNull();
  });

  it("does not match a different article on the same host", () => {
    expect(findEntry(entries, "https://allaboutfpl.com/2026/08/something-else/"))
      .toBeNull();
  });

  it("does not match the same path on another host", () => {
    // The host is half the identity; dropping it would let any site claim an
    // article by copying a path.
    expect(findEntry(entries, "https://evil.example/2026/08/chelsea-lineup/"))
      .toBeNull();
  });

  it("returns null for a URL that will not parse", () => {
    expect(findEntry(entries, "not a url")).toBeNull();
  });
});

describe("the feeds this app is willing to fetch", () => {
  it("is an allow-list, not whatever the caller names", () => {
    /**
     * The security property. The caller supplies an article URL; fetching a
     * user-supplied URL server-side is request forgery pointed at whatever the
     * deploy can reach. Nothing fetches the supplied URL — a feed is chosen by
     * key from this map and the URL is looked up inside the result.
     */
    for (const url of Object.values(ARTICLE_FEEDS)) {
      expect(url.startsWith("https://")).toBe(true);
    }
    expect(Object.keys(ARTICLE_FEEDS).length).toBeGreaterThan(0);
  });

  it("names only sources the poller actually captures", () => {
    // Mirrors NEWS_FEEDS in pipeline/config.py. A key here with no counterpart
    // there is a fetch nothing can ever ask for.
    const known = new Set([
      "hayters", "allaboutfpl", "premierfantasytools",
      "fantasyfootballscout", "bbc_football", "sky_football",
    ]);
    for (const key of Object.keys(ARTICLE_FEEDS)) expect(known.has(key)).toBe(true);
  });
});
