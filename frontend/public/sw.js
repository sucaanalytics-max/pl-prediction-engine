// What this worker actually does with a page request.
//
// Navigations are NETWORK-FIRST. The handler at the bottom of this file does
// `fetch(request)`, puts a copy in the cache, and reaches for the cache only in
// the `.catch` — so an online installed app receives the freshly deployed page
// every time, and SHELL_ROUTES is reachable only when the network fetch rejects.
// Two earlier versions of this comment claimed the opposite ("every route in
// SHELL_ROUTES is served cache-first"). It was not true when it was written and
// it is not true now; nothing in this file has ever served a navigation from the
// cache while the network was up.
//
// `/_next/static/**` IS cache-first, but every URL under it is content-hashed per
// build, so a new deploy asks for URLs the old cache does not hold.
//
// So a stale precache is an OFFLINE-experience bug, and the cache key is the only
// thing that fixes one: the activate handler below deletes every cache whose key
// is not CACHE_NAME.
//
// v7 earns its bump on exactly that ground and no other. `/` stopped being a 307
// redirect to `/margin` and became the call itself, so a v6 precache still holds
// a redirect that the offline branch would replay — forwarding an offline visitor
// away from the front door. Bumping evicts it.
//
// What v7 is NOT: an explanation of the reported stale `/`. That symptom ("the
// frontend is not updating") was never diagnosed. It cannot have been this
// worker's navigation handler, which is network-first and was byte-identical in
// v6 — the reviewed commit changed the cache name and this comment, nothing else.
// The most likely cause is HTTP-level caching of the old 307 by the browser or an
// intermediary, from when `/` genuinely was a redirect, but that was not measured
// and remains unknown. If it recurs, measure the response for `/` before touching
// this file.
//
// Bump this whenever a SHELL_ROUTES page changes what it renders, so the offline
// branch cannot replay a version of it that no longer exists.
//
// v8 earned its bump on the same ground: `/margin`, `/bet`, `/now`, `/decide` and
// `/accuracy` no longer exist. A v7 precache holds five pages that are gone, and
// the offline branch would serve them to an installed app as though they were
// still the app. Bumping evicts them. The list below is also why this is one
// commit with the route deletion — `cache.addAll` rejects atomically, so a list
// naming a route that 404s precaches NOTHING.
//
// v9 is not about the list, which is unchanged. Two of the pages ON it changed
// what they render, and both changes are ones a stale offline copy actively
// misleads with: `/` gained the only link to `/capture` (a v8 copy is the version
// of the front door with no route to the write path at all), and `/capture` now
// captures for entry 20945 rather than offering the two entries that detached —
// a v8 copy would go on posting captures the agent never reads.
// v10 adds two routes. `/phases` and `/stats` are new, and the list is what the
// offline branch serves, so a v9 cache holds an app whose nav links two pages it
// cannot open — which offline reads as the app being broken rather than as pages
// missing. Bumping evicts it. Same reason this is one commit with the routes:
// `cache.addAll` rejects atomically, so a list naming a route that 404s
// precaches NOTHING.
//
// v11 is a change of what the worker DOES, not of the list, and it is the first
// bump where the answer to "what does an offline reload show" changes. Measured
// on the live site on 2026-10-24: an offline reload of `/` rendered the shell and
// then failed every data section ("Neither the agent's status nor FPL's own state
// could be read"), because v10 cached navigations and `/_next/static` and nothing
// else. `/predictions/*.json` and `GET /api/fpl/state` were never stored, so the
// page that loaded offline had nothing to draw. v11 stores both, each stamped
// `x-sw-cached-at` so the page can say how old what it is showing is (the
// offline banner and `provenance.cachedAt` read it) rather than presenting a
// stored copy as live. Three further changes ride the same bump:
//   - `/_next/static` moved to its own capped cache. It grew without bound across
//     deploys, because the only eviction was a CACHE_NAME bump.
//   - the worker no longer calls skipWaiting() on an UPDATE. v10 took over every
//     open tab the moment it installed, with no way for the page to know. v11
//     waits for a `SKIP_WAITING` message, which PwaManager sends when the person
//     taps "Reload". A FIRST install still activates at once: there is no
//     previous version to disrupt and no page open that expects one.
//   - navigations race a 4s timeout against the network, then prefer a cached
//     page. v10 waited for the browser's own, much longer, connection timeout, so
//     a flaky signal looked like a hung app rather than an offline one.
//   - prediction JSON is NETWORK-FIRST with a 3s timeout, not stale-while-
//     revalidate. SWR was the first draft and it was wrong for this app: online,
//     it hands the page the PREVIOUS copy of a decision file and refreshes behind
//     it, and nothing on screen says so, because the banner only speaks when the
//     network has failed. A call that changed on team news an hour before the
//     deadline would be shown as the old call, unlabelled. Network-first means a
//     stored copy is only ever served when the network has failed or stalled,
//     which are exactly the cases `SW_SERVED_CACHED` announces.
// v12 adds `/more` and makes the precached assets actually reachable. `/more` is
// the fifth phone tab (Call, Players, Fixtures, Stats, More) and the way into
// `/capture`, `/evidence` and `/review`, so a v11 cache holds an installed app
// whose last tab cannot open offline. The page and this list ship in one commit
// because `cache.addAll` is atomic: a route that 404s precaches NOTHING, shell
// included. Separately, measured with the network off: `/icon.svg` and
// `/manifest.webmanifest` failed offline, because `classify` answered "bypass" for
// them, so the icon entries below were precached and never served. They now
// classify as "asset" and are answered cache-first from this cache;
// `/manifest.webmanifest` and `/icon-maskable-512.png` join the list for the same
// reason.
// Bumping evicts the v11 shell cache. The data and static caches carry their own
// version keys and are NOT evicted by a shell bump: a stored artifact is worth
// more than the one precache list it is unrelated to.
/**
 * On a dev server this worker is a liability, and it removes itself.
 *
 * `/_next/static/` is served cache-first and never revalidated, which is right in
 * production because those URLs are content-hashed. A dev server reuses chunk
 * names across builds, so the worker hands yesterday's JavaScript to today's HTML:
 * React reports a hydration mismatch, the PREVIOUS design renders, and the stack
 * points at whatever component is being edited. It cost real time twice during
 * the Signal redesign, both times looking like a bug in the work in progress.
 *
 * The teardown has to live HERE rather than in the app. `PwaManager` also guards
 * registration, but a developer already carrying the worker is served the stale
 * PwaManager chunk — the guard never executes, and the cache cannot bootstrap
 * itself out. The browser byte-compares this file on every navigation, so a
 * worker that unregisters itself is the only thing that reaches a poisoned
 * install.
 */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const IS_LOCAL = LOCAL_HOSTS.indexOf(self.location.hostname) !== -1;

const CACHE_NAME = "suca-fpl-shell-v12";
// Versioned independently of the shell. Neither holds anything the shell list
// decides, and a shell bump should not throw away the only offline copy of the
// data. Bump these only if the SHAPE of what is stored in them changes.
const STATIC_CACHE = "suca-fpl-static-v1";
const DATA_CACHE = "suca-fpl-data-v1";
const KEEP_CACHES = [CACHE_NAME, STATIC_CACHE, DATA_CACHE];

// Content-hashed chunks, oldest evicted first. Roughly four to five builds of the
// app's chunks, which is as far back as an installed tab realistically lags.
const STATIC_CACHE_MAX_ENTRIES = 150;
// Long enough that a slow-but-working connection still wins, short enough that a
// dead one hands over to the cache while the person is still looking at the screen.
const NAV_TIMEOUT_MS = 4000;
// The same trade for artifacts, a little shorter: by the time data is asked for,
// the page is already on screen and waiting on it.
const DATA_TIMEOUT_MS = 3000;
const CACHED_AT_HEADER = "x-sw-cached-at";

// `classify` is the routing decision, kept in a file vitest can import. It is
// loaded before anything can fetch, and a worker whose imported script cannot be
// fetched fails to install, which leaves the previous worker in place.
importScripts("/sw-routing.js");
const SHELL_ROUTES = [
  // Every route the app has, which is still a short enough list to precache
  // whole: the call, the projections, the fixture phases, the player stats, the
  // evidence, the review of what last week cost, the position, the More tab, and
  // the page shown when a fetch fails — plus the icons and manifest, served by
  // `handleAsset`.
  "/",
  "/players",
  "/phases",
  "/stats",
  "/evidence",
  "/review",
  "/capture",
  "/more",
  "/offline",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // Nothing is precached locally: this install exists only to reach `activate`,
  // where the worker deletes its caches and unregisters.
  if (!IS_LOCAL) {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ROUTES))
    );
  }
  // Activate at once only when there is nothing to take over from. With an
  // active worker already running, this one waits for the page to say so (the
  // `message` handler below), so an update never swaps code under an open tab.
  // Locally the worker must reach `activate` to remove itself, so it never waits.
  if (IS_LOCAL || !self.registration.active) {
    self.skipWaiting();
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  if (IS_LOCAL) {
    event.waitUntil(
      (async () => {
        // Every cache, not just the stale ones — the whole point is to leave no
        // chunk behind. Then unregister, then reload the open tabs so they take
        // the dev server's own JavaScript instead of what was already served.
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) client.navigate(client.url);
      })()
    );
    return;
  }
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => KEEP_CACHES.indexOf(key) === -1)
            .map((key) => caches.delete(key))
        )
      )
  );
  self.clients.claim();
});

/**
 * A stored copy of `response` with the time it was stored added as a header.
 *
 * A new Response rather than a mutated one: headers on a fetched response are
 * immutable. The body is the clone's, so the original stays readable by the page.
 */
function stamped(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, new Date().toISOString());
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Only a plain 200 is worth keeping. A missing artifact answers with 30KB of
 * Next.js 404 HTML, and a stored 404 would replace the last good copy with it;
 * a 206 cannot be stored at all.
 */
function storable(response) {
  return response.status === 200 && response.type !== "opaque";
}

/**
 * Tell open pages that a stored copy was served in place of the network, and how
 * old it is. This is what lets the banner say "showing data as of 14:05" even for
 * fetches the page's own code never inspects for a header.
 */
async function announceCached(kind, url, cachedAt) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "SW_SERVED_CACHED", kind, url, cachedAt });
  }
}

async function trimCache(cache, max) {
  // `keys()` is in insertion order, so the front of the list is the oldest.
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function handleNavigate(event) {
  const request = event.request;
  const network = fetch(request).then((response) => {
    // A redirected response cannot answer a navigation from the cache, and a
    // non-200 is not a page worth replaying offline.
    if (storable(response) && !response.redirected) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
    }
    return response;
  });
  // The loser of the race must not surface as an unhandled rejection.
  network.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Slow, not dead: prefer a stored page, but with nothing stored keep waiting.
    const cached = await caches.match(request);
    if (cached) return cached;
    return await network;
  } catch (error) {
    return (
      (await caches.match(request)) ??
      (await caches.match("/offline")) ??
      Response.error()
    );
  }
}

async function handleStatic(event) {
  const request = event.request;
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (storable(response)) {
    const copy = response.clone();
    event.waitUntil(
      cache
        .put(request, copy)
        .then(() => trimCache(cache, STATIC_CACHE_MAX_ENTRIES))
    );
  }
  return response;
}

async function handleAsset(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  // Not precached (an install that predates this entry): fetch, and keep it.
  const response = await fetch(request);
  if (storable(response)) {
    const copy = response.clone();
    event.waitUntil(cache.put(request, copy));
  }
  return response;
}

async function handleData(event) {
  const request = event.request;
  const cache = await caches.open(DATA_CACHE);

  // Stored whether it wins the race or not: a slow answer still refreshes the
  // copy the NEXT offline read will get.
  const network = fetch(request).then((response) => {
    if (storable(response)) {
      const copy = response.clone();
      event.waitUntil(cache.put(request, stamped(copy)));
    }
    return response;
  });
  network.catch(() => {});

  // The stored copy, announced, so the banner can say how old it is. Never served
  // silently: that is the whole reason this is not stale-while-revalidate.
  async function storedCopy() {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
      event.waitUntil(announceCached("data", request.url, cached.headers.get(CACHED_AT_HEADER)));
    }
    return cached;
  }

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DATA_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Stalled, not dead: the stored copy if there is one, else keep waiting.
    return (await storedCopy()) ?? (await network);
  } catch (error) {
    // Nothing stored: a failure is the caller's to handle (`load()` turns it
    // into an `absent`/`unreadable` state).
    const cached = await storedCopy();
    if (cached) return cached;
    throw error;
  }
}

/**
 * `/api/fpl/state` answers 200-shaped JSON for success AND failure, and only the
 * `data` key separates them. Storing on `response.ok` alone would let one upstream
 * failure replace the last good state with `{error: ...}`.
 */
async function carriesData(response) {
  try {
    const body = await response.json();
    return typeof body === "object" && body !== null && body.data != null;
  } catch (error) {
    return false;
  }
}

async function handleLive(event) {
  const request = event.request;
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (storable(response)) {
      const copy = response.clone();
      event.waitUntil(
        carriesData(copy.clone()).then((ok) => (ok ? cache.put(request, stamped(copy)) : undefined))
      );
    }
    return response;
  } catch (error) {
    // Network failure only. A 5xx or an error-shaped 200 is the server's real
    // answer and is passed through: replaying an old state under a live label
    // because the server was unhappy would hide the outage.
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
      event.waitUntil(announceCached("live", request.url, cached.headers.get(CACHED_AT_HEADER)));
      return cached;
    }
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  // Locally the worker answers nothing while it is on its way out.
  if (IS_LOCAL) return;
  const request = event.request;
  const kind = self.SwRouting.classify(
    request.url, request.method, request.mode, self.location.origin
  );
  if (kind === "navigate") event.respondWith(handleNavigate(event));
  else if (kind === "static") event.respondWith(handleStatic(event));
  else if (kind === "data") event.respondWith(handleData(event));
  else if (kind === "live") event.respondWith(handleLive(event));
  else if (kind === "asset") event.respondWith(handleAsset(event));
  // "bypass": no respondWith, the browser handles it. Every non-GET and every
  // other /api route lands here.
});
