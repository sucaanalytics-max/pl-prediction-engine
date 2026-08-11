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
() => {
  const posts = [];
  for (const article of document.querySelectorAll('article')) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) continue;
    const id = (link.href.match(/status\/(\d+)/) || [])[1];
    if (!id) continue;
    posts.push({
      status_id: id,
      url: 'https://x.com/' + location.pathname.split('/')[1] + '/status/' + id,
      lines: article.innerText.split('\n'),
    });
  }
  return { handle: location.pathname.split('/')[1], posts: posts };
}
