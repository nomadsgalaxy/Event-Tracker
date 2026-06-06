// Self-destructing service worker.
//
// The previous (Python) version of this app shipped a caching PWA service worker at /sw.js. The
// Next.js app does NOT use a service worker, but returning visitors still have the old one registered
// at this scope, where it serves stale cached assets (e.g. the old "eit-v108" cache) on top of the
// new app. Serving this no-op worker at the same URL makes the browser's update check replace the old
// worker with this one, which then clears all caches and unregisters itself, so the next load is a
// clean, service-worker-free fetch of the current app.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* ignore */
      }
      try {
        await self.registration.unregister();
      } catch {
        /* ignore */
      }
      // Reload any open tabs so they re-fetch without the (now-removed) worker in the way.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.navigate(client.url);
      } catch {
        /* ignore */
      }
    })(),
  );
});

// Never serve from cache — pass everything straight to the network while we wind down.
self.addEventListener('fetch', () => {});
