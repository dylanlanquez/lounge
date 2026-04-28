// Lounge service worker
//
// Minimum-viable: registers + handles fetch so Chrome considers Lounge
// installable. Runs network-only so Supabase data is never stale —
// Lounge is a desk-bound app, offline mode would cause confusion.
//
// Uses skipWaiting + clients.claim so a deploy takes effect on next
// page reload without the old SW lingering.

const VERSION = 'v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass through. No caching. Service worker exists purely to satisfy
  // installability; the network is always the source of truth.
  // We must register a fetch handler for Chrome to recognise the SW.
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504, statusText: `offline (sw ${VERSION})` })));
});
