// The DOM read for an X profile scan. ONE copy, shared by two callers:
//
//   * pipeline/data/x_scan.py loads it as EXTRACT_JS (for a Claude Code session
//     driving the Chrome MCP), and
//   * scripts/x_scan.mjs loads it for the headless Playwright run.
//
// It lived as a Python string first. Two copies of a scraper's selectors drift,
// and the failure is silent: the stale copy returns zero posts and reports
// success. A test asserts both callers read this file.
//
// Measured against the live logged-out page: <time> is absent and no data-testid
// attribute is emitted in that view, so neither is used.
//
// The author comes from each post's OWN status link, never from location.pathname.
// On a profile page the two agree; on a logged-in home timeline they do not —
// pathname is "home", so a pathname-derived URL reads
// `https://x.com/home/status/<id>` and every row in a feed scan is stamped with
// the same fictional author. The href of `a[href*="/status/"]` inside an article
// is `/<author>/status/<id>` in both views, which makes one code path correct for
// both. `handle` is reported as the page being read, which is what it is.
() => {
  const posts = [];
  for (const article of document.querySelectorAll('article')) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) continue;
    // Parse the href's path rather than the absolute URL: `link.href` is
    // resolved against the origin, so a relative href works either way, and
    // matching on the path avoids picking the id out of a query string.
    const path = (link.getAttribute('href') || link.href || '');
    const match = path.match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (!match) continue;
    posts.push({
      status_id: match[2],
      author: match[1],
      url: 'https://x.com/' + match[1] + '/status/' + match[2],
      lines: article.innerText.split('\n'),
    });
  }
  return { handle: location.pathname.split('/')[1] || 'home', posts: posts };
}
