// sw.js
// Minimal service worker - exists to satisfy PWA installability, NOT to
// cache trading data. Only the static app shell (this HTML file, the
// manifest, icons) is cached; every actual API call (status/balance/
// stats/control/settings) goes straight to the network, uncached, so
// the dashboard never shows stale P&L or trade state. The only offline
// fallback is serving the cached shell if a page load has no network at
// all - a real trading dashboard with no network is useless anyway,
// this just avoids a blank "can't reach this page" browser error.

const SHELL_CACHE = 'bandzzbot-shell-v1';
const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only ever intercept the shell's own navigation request - every other
  // request (Netlify Functions calls in particular) passes straight
  // through untouched, network-only.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
  }
});
