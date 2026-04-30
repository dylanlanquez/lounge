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
const VERSION = 'v6';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Deliberately no fetch listener. Modern Chrome considers a PWA
// installable as long as there's a registered service worker, a
// manifest with the right keys, and HTTPS — a fetch handler is no
// longer required and a no-op handler triggers Chrome's "fetch
// event handler is recognized as no-op" warning plus per-
// navigation overhead. Lounge has no offline story (it's a
// desk-bound, network-only app), so the right move is to skip
// the listener entirely and let every request go through the
// browser's native code path.
