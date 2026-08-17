/**
 * Reading an article in the app, without embedding it.
 *
 * ## Why not an iframe
 *
 * Measured, not assumed: `allaboutfpl.com` answers with
 * `x-frame-options: SAMEORIGIN`, so an embedded pane renders nothing at all.
 * That route is closed and no amount of styling opens it.
 *
 * ## Why not ship the text in the artifact
 *
 * The feed carries the whole article — 46KB of HTML, 14KB of text, for the GW1
 * predicted-lineups piece. `news_view.json` holds ninety items and is fetched by
 * every visitor, so carrying full bodies would add roughly a megabyte to a
 * reading list of which a reader opens two. The artifact keeps the 400-character
 * teaser; the body is fetched when someone asks for it.
 *
 * ## Why plain text rather than the publisher's HTML
 *
 * No sanitiser is installed here and this app renders no third-party markup
 * anywhere. Adding both — a dependency and an XSS surface — to reproduce someone
 * else's typography is a poor trade when the thing of value is the sentences.
 * They are extracted server-side and rendered in Margin's own type, which also
 * means the reader gets no tracking pixels and no layout shift.
 */

/**
 * Feeds this app will fetch, by the `source` key the artifact already carries.
 *
 * An allow-list, and the reason is security rather than tidiness: the caller
 * supplies an article URL, and fetching a user-supplied URL server-side is a
 * request forgery primitive pointed at whatever the deploy can reach. Nothing
 * here ever fetches the supplied URL. It fetches a feed named by a key from this
 * map and looks the URL up inside the result, so an unknown key is simply a
 * miss.
 *
 * Mirrors `NEWS_FEEDS` in `pipeline/config.py`; `article.test.ts` asserts the
 * keys stay a subset of the sources the artifact actually publishes.
 */
export const ARTICLE_FEEDS: Readonly<Record<string, string>> = {
  allaboutfpl: "https://allaboutfpl.com/feed/",
  premierfantasytools: "https://www.premierfantasytools.com/feed/",
  // fantasyfootballscout is deliberately absent. Its feed runs in WordPress
  // Summary mode: 12 items, zero `content:encoded`, and a `description` that is
  // the excerpt plus the "The post … appeared first on …" backlink. Offering
  // "read here" there returned the same 400 characters already on screen plus
  // boilerplate, which is an affordance that lies. Measured on the live feed;
  // `article.test.ts` pins the reason.
};

/** Paragraphs shorter than this are navigation, bylines and share prompts. */
const MIN_PARAGRAPH = 40;

/** Enough for a long piece; a bound so one article cannot be a denial of service. */
export const MAX_PARAGRAPHS = 120;

/**
 * The article's sentences, with its markup discarded.
 *
 * Block-level closers become paragraph breaks before the tags are stripped, so
 * the shape of the piece survives — 87 paragraphs out of 46KB on a real
 * allaboutfpl article. Doing it the other way round (strip first, then split on
 * blank lines) yields one wall of text, because the feed's HTML carries no
 * newlines of its own.
 */
/** Whether an article was cut short by the cap, and by how much. */
export interface Body {
  readonly paragraphs: string[];
  readonly truncated: boolean;
}

/**
 * The article, with a flag when the cap cut it.
 *
 * `toParagraphs` slices at `MAX_PARAGRAPHS` and said nothing, so on 4 of the 10
 * articles in the allaboutfpl feed the text stopped 27 paragraphs early —
 * mid-list, with no ellipsis and no count. Nothing distinguished a truncated
 * article from one that simply ended, which is an absence with no reason
 * attached.
 */
export function toBody(html: string): Body {
  const all = toParagraphsUncapped(html);
  return {
    paragraphs: all.slice(0, MAX_PARAGRAPHS),
    truncated: all.length > MAX_PARAGRAPHS,
  };
}

export function toParagraphs(html: string): string[] {
  return toBody(html).paragraphs;
}

function toParagraphsUncapped(html: string): string[] {
  const withoutCode = html.replace(
    /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ",
  );
  const broken = withoutCode
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(broken.replace(/<[^>]+>/g, ""));
  return text
    .split(/\n{2,}/)
    .map((piece) => piece.split(/\s+/).filter(Boolean).join(" "))
    .filter((piece) => piece.length >= MIN_PARAGRAPH);
}

/**
 * Named entities a feed actually emits, beyond the numeric forms.
 *
 * The first version carried six and shipped: a real allaboutfpl article rendered
 * `&mdash; ALLABOUTFPL (@allaboutfpl) August 5, 2026` verbatim on the page,
 * because an em dash is exactly what a publisher puts in an attribution line.
 * Typographic punctuation is the common case in prose, so the list covers it
 * rather than the six that happened to be in the first fixture.
 */
const NAMED: Readonly<Record<string, string>> = {
  nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  bull: "\u2022", middot: "\u00b7", deg: "\u00b0",
  eacute: "\u00e9", egrave: "\u00e8", uuml: "\u00fc", ouml: "\u00f6",
  aacute: "\u00e1", oacute: "\u00f3", iacute: "\u00ed", ntilde: "\u00f1",
  pound: "\u00a3", euro: "\u20ac", trade: "\u2122", copy: "\u00a9",
};

/**
 * Entities, decoded once and in one pass.
 *
 * A single pass matters: replacing `&amp;` before the others turns an escaped
 * `&amp;lt;` into `<`, which is how an author's literal `&lt;` becomes a tag.
 * One regex over the whole string cannot do that, because each match is
 * consumed exactly once.
 *
 * The result is never rendered as markup — it goes into a text node — so
 * decoding `&lt;` cannot reintroduce an element. An entity this does not know
 * is left alone rather than mangled: an unrecognised `&foo;` on the page is a
 * visible prompt to add it, where a stripped one is silent data loss.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (whole, body: string) => {
      const token = body.toLowerCase();
      if (token.startsWith("#x")) {
        return String.fromCodePoint(parseInt(token.slice(2), 16));
      }
      if (token.startsWith("#")) return String.fromCodePoint(Number(token.slice(1)));
      return Object.prototype.hasOwnProperty.call(NAMED, token) ? NAMED[token] : whole;
    },
  );
}

/** One item from a feed: where it points, and what it says. */
export interface FeedEntry {
  readonly link: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Entries from an RSS document.
 *
 * A regex reader rather than a parser dependency. That is a real trade — a
 * malformed feed degrades to fewer entries rather than to an error — and it is
 * acceptable here because the worst case is that the reader taps through to the
 * publisher, which is what they do today anyway.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = match[0];
    const link = pick(item, "link");
    if (!link) continue;
    out.push({
      link,
      title: pick(item, "title") ?? "",
      // `content:encoded` ONLY. `description` is the teaser the artifact
      // already carries, and falling back to it made "read here" return the
      // sentence the reader was already looking at — on 12 of 13 items, after a
      // spinner and a network round trip. A feed with no full body has no
      // article to give, and the route says so rather than dressing up the
      // summary as one.
      body: pickTag(item, "content:encoded") ?? "",
    });
  }
  return out;
}

function pick(item: string, tag: string): string | null {
  return pickTag(item, tag);
}

function pickTag(item: string, tag: string): string | null {
  const escaped = tag.replace(":", "\\:");
  const match = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "i").exec(item);
  if (!match) return null;
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return (cdata ? cdata[1] : inner).trim() || null;
}

/**
 * Match a feed entry to the URL the reader tapped.
 *
 * Compared without the query string and without a trailing slash, because the
 * artifact stores the URL as the poller captured it and feeds are inconsistent
 * about both. An exact string match misses often enough to make the feature
 * look broken.
 */
export function findEntry(entries: readonly FeedEntry[], url: string): FeedEntry | null {
  const wanted = canonical(url);
  if (!wanted) return null;
  return entries.find((entry) => canonical(entry.link) === wanted) ?? null;
}

function canonical(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}


/** What the reader asked for, or why it is not there. */
export type ArticleResult =
  | {
      readonly ok: true;
      readonly title: string;
      readonly paragraphs: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetch an article body and narrow it, away from the view.
 *
 * `margin.test.ts` forbids a bare `fetch` inside the Margin surface, and the
 * reason it gives is the one that matters: the two places this app cast a
 * response to a type both turned a shape change into a blank page instead of a
 * message. Doing the call here keeps that rule intact and puts the narrowing
 * where every other narrowing in this app lives.
 *
 * Nothing is cast. A response that is not the expected shape becomes a stated
 * reason, which is the same contract `lib/data/artifact.ts` holds for artifacts.
 */
export async function readArticle(source: string, url: string): Promise<ArticleResult> {
  let payload: unknown;
  try {
    const response = await fetch(
      `/api/news/article?source=${encodeURIComponent(source)}&url=${encodeURIComponent(url)}`,
    );
    payload = await response.json();
  } catch {
    return { ok: false, reason: "The request did not complete." };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "The reader answered with something unreadable." };
  }
  const body = payload as Record<string, unknown>;

  // The route's own reason beats one invented here: it knows which of its four
  // outcomes it hit — unknown source, missing article, empty body, dead feed.
  if (typeof body.error === "string") return { ok: false, reason: body.error };

  const data = typeof body.data === "object" && body.data !== null
    ? (body.data as Record<string, unknown>) : null;
  if (!data || !Array.isArray(data.paragraphs)) {
    return { ok: false, reason: "No text came back for that article." };
  }
  const paragraphs = data.paragraphs.filter((p): p is string => typeof p === "string");
  if (paragraphs.length === 0) {
    return { ok: false, reason: "The article came back with no readable text." };
  }
  return {
    ok: true,
    title: typeof data.title === "string" ? data.title : "",
    paragraphs,
    truncated: data.truncated === true,
  };
}
