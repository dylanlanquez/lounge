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
const VERSION = 'v5';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Chrome only considers a service worker installable if there's a
// `fetch` event listener registered. The listener does NOT need to
// call event.respondWith — its mere presence is enough. Earlier
// versions called fetch() inside the handler and synthesised a 504
// when the call threw, but that masked real network errors as
// "offline (sw vN)" and tripped on cross-origin script loads
// (Google Maps under no-cors). The cleanest pass-through is to
// register the listener and do absolutely nothing, letting the
// browser handle every request natively.
self.addEventListener('fetch', () => {
  // intentional no-op — see comment above
});
