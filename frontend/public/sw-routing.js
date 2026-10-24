/**
 * Which strategy a request gets, as a pure function.
 *
 * Lives in its own file so the worker can `importScripts` it AND vitest can
 * import it. The alternative — a copy inside `sw.js` with a parity test — would
 * assert that two copies agree, which is weaker than there being one. A worker
 * cannot be unit tested directly (it needs `self`, `caches` and a registration),
 * but the decision that matters most — what is NEVER cached — needs no browser.
 *
 * Returns one of:
 *   "navigate"  page loads. Network-first with a timeout, then cached page, then /offline.
 *   "static"    `/_next/static/**`. Content-hashed, so cache-first and capped.
 *   "data"      `/predictions/**.json[l]`, same-origin or Supabase public storage.
 *               Network-first with a timeout, stamped with `x-sw-cached-at`; a
 *               stored copy is served only when the network fails or stalls.
 *   "live"      `GET /api/fpl/state` and nothing else. Network-first, last-good fallback.
 *   "bypass"    everything else. The worker does not answer it.
 *
 * The bypass list is the safety property. Every non-GET is bypassed, so
 * `/capture`'s POST to `/api/hub/position` can never be answered from a cache, and
 * every other `/api/*` route is bypassed, so a write path or an uncached read can
 * never be replayed stale. New API routes are bypassed by default: caching one
 * means naming it here.
 */
(function (root) {
  var SUPABASE_PUBLIC_PREDICTIONS = "/storage/v1/object/public/predictions/";

  function isDataFile(pathname) {
    return /\.jsonl?$/.test(pathname);
  }

  /**
   * @param {string | URL} urlLike absolute URL of the request
   * @param {string} method
   * @param {string} mode  `Request.mode`; only "navigate" is distinguished
   * @param {string} origin the worker's own origin, `self.location.origin`
   * @returns {"navigate" | "static" | "data" | "live" | "bypass"}
   */
  function classify(urlLike, method, mode, origin) {
    if (String(method).toUpperCase() !== "GET") return "bypass";

    var url;
    try {
      url = urlLike instanceof URL ? urlLike : new URL(String(urlLike));
    } catch (e) {
      return "bypass";
    }

    if (url.origin !== origin) {
      // The one cross-origin read the app makes for artifacts, if configured.
      // Matched on the hostname suffix and the exact storage path, so no other
      // Supabase endpoint (auth, REST, a private bucket) is ever cached.
      var host = url.hostname;
      var isSupabase = host === "supabase.co" || host.slice(-12) === ".supabase.co";
      if (
        isSupabase &&
        url.protocol === "https:" &&
        url.pathname.indexOf(SUPABASE_PUBLIC_PREDICTIONS) === 0 &&
        isDataFile(url.pathname)
      ) {
        return "data";
      }
      return "bypass";
    }

    var path = url.pathname;
    if (path.indexOf("/api/") === 0) {
      return path === "/api/fpl/state" ? "live" : "bypass";
    }
    if (mode === "navigate") return "navigate";
    if (path.indexOf("/_next/static/") === 0) return "static";
    if (path.indexOf("/predictions/") === 0 && isDataFile(path)) return "data";
    return "bypass";
  }

  var api = { classify: classify };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.SwRouting = api;
})(typeof self !== "undefined" ? self : this);
