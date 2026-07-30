// Bumped from 'cc-terminal-v1'. The name is what the activate handler below
// uses to delete older caches, so changing it is how a stale cache actually
// gets dropped — the old name never changed, so the cleanup never had anything
// to clean and stale content stayed resident indefinitely.
const CACHE_NAME = 'agentdeck-v2';

// Static assets to cache
const STATIC_ASSETS = [
  '/',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/**
 * Fetch: network-first, cache only as an offline fallback.
 *
 * This used to be `cached || networkFetch` — cache-first, returning the cached
 * copy without ever waiting for the network. For an app whose whole job is
 * talking to a live server that trade is backwards: it pinned each device to
 * whatever version it first loaded, so a deploy could go unseen indefinitely.
 * Observed in production, not hypothetically — a phone kept running a
 * pre-device-allowlist bundle and opened WebSockets without the device id that
 * build knew nothing about, which read server-side as unidentifiable clients.
 *
 * Offline still works: a failed request falls back to the cache. A terminal is
 * useless offline anyway, so freshness is worth strictly more than availability
 * here.
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch API or WebSocket traffic.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        // Offline or server down: serve whatever we have, else let it fail.
        const cached = await caches.match(event.request);
        if (cached) return cached;
        throw new Error('offline and not cached');
      })
  );
});
