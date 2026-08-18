// Bumped for the ink-and-paper restyle.
//
// The cache key is the ONLY thing that evicts a precached shell. Every route in
// SHELL_ROUTES below is served cache-first, so an installed PWA would keep
// rendering the emerald design indefinitely after the new one deployed — the
// restyle would ship and no existing user would see it.
// v7: `/` stopped being a redirect to `/margin` and became the call itself.
// It is the first entry in SHELL_ROUTES and served cache-first, so every
// installed app held the redirect and forwarded away from the new front door —
// the deployment was fine and no existing user could see it, which is the exact
// failure the note above describes. Bumping the name is what evicts it: the
// activate handler below deletes every cache whose key is not CACHE_NAME.
//
// Bump this whenever a SHELL_ROUTES page changes what it renders.
const CACHE_NAME = "suca-fpl-shell-v7";
const SHELL_ROUTES = [
  "/",
  // The workspace, which the root now opens on. It was absent from this list
  // while `/markets` and `/matches` were on it — so an installed app precached
  // the betting screens that have since moved behind `/bet`, and not the four
  // tabs the app is actually for.
  "/margin",
  "/bet",
  "/now",
  "/decide",
  "/players",
  "/evidence",
  "/accuracy",
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
