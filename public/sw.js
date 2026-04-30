// Lounge service worker
//
// Minimum-viable: registers + handles fetch so Chrome considers Lounge
// installable. Runs network-only so Supabase data is never stale —
// Lounge is a desk-bound app, offline mode would cause confusion.
//
// Uses skipWaiting + clients.claim so a deploy takes effect on next
// page reload without the old SW lingering.

// Bump this whenever the icon manifest changes — paired with the
// ?v= query string on favicons in index.html / manifest.webmanifest
// to force a fresh fetch through any caching layer.
const VERSION = 'v4';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Service worker exists purely to satisfy Chrome's installability
  // check. We don't cache anything — Lounge is desk-bound, stale
  // data would confuse staff.
  if (event.request.method !== 'GET') return;

  // Cross-origin requests must NOT be re-fetched through the SW.
  // A native <script src=> for cross-origin returns a no-cors
  // opaque response that the script tag handles fine; the SW's
  // own fetch() defaults to CORS mode and rejects the same
  // response, then we synthesise a 504. Lounge hits this every
  // time it loads Google Maps. Letting the browser handle these
  // natively (by NOT calling event.respondWith) is the correct
  // pass-through.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() => new Response('', { status: 504, statusText: `offline (sw ${VERSION})` }))
  );
});
