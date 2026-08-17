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
  fantasyfootballscout: "https://www.fantasyfootballscout.co.uk/feed",
  premierfantasytools: "https://www.premierfantasytools.com/feed/",
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
export function toParagraphs(html: string): string[] {
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
    .filter((piece) => piece.length >= MIN_PARAGRAPH)
    .slice(0, MAX_PARAGRAPHS);
}

/**
 * The handful of entities a feed actually emits.
 *
 * Deliberately not a general HTML entity table: the tags are already gone by the
 * time this runs, so the only job is to stop `&amp;` and `&#038;` reaching the
 * page as literals. `&lt;` and `&gt;` are decoded last and the result is never
 * rendered as markup, so decoding them cannot reintroduce a tag.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Ampersand last: doing it first would turn `&amp;lt;` into `<`.
    .replace(/&amp;/gi, "&");
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
      // `content:encoded` is the full article; `description` is the teaser the
      // artifact already carries. Prefer the former and fall back, so a feed
      // that publishes only a summary still returns something readable.
      body: pickTag(item, "content:encoded") ?? pick(item, "description") ?? "",
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
