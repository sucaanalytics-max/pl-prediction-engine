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
const CACHE_NAME = "suca-fpl-shell-v9";
const SHELL_ROUTES = [
  // Every route the app has, which is now a short enough list to precache whole:
  // the call, the shortlist, the evidence, the position, and the page shown when
  // a fetch fails.
  "/",
  "/players",
  "/evidence",
  "/capture",
  "/offline",
  "/icon.svg",
  "/icon-maskable.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ROUTES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        return (
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
        );
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          return (
            (await caches.match(request)) ??
            (await caches.match("/offline")) ??
            Response.error()
          );
        })
    );
  }
});
