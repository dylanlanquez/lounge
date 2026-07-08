// Lounge service worker
//
// Minimum-viable: registers + handles fetch so Chrome considers Lounge
// installable. Runs network-only so Supabase data is never stale —
// Lounge is a desk-bound app, offline mode would cause confusion.
//
// Uses skipWaiting + clients.claim so a deploy takes effect on next
// page reload without the old SW lingering.

// Bump this to force every device onto the latest deploy. The
// kiosk auto-update chain in src/main.tsx only reloads a running tab
// when the bytes of this file change (new worker -> controllerchange
// -> reload). A normal code deploy leaves sw.js untouched, so an
// always-on tablet keeps its old in-memory bundle indefinitely until
// this VERSION changes. Bump it on any deploy that must reach the
// kiosks (a correctness fix, not just icon-manifest changes). Also
// paired with the ?v= query string on favicons in index.html /
// manifest.webmanifest to force a fresh favicon fetch.
const VERSION = 'v9';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge any Cache Storage left behind by earlier service-worker
      // versions that DID cache the app shell (this worker is network-
      // only and caches nothing). Without this, a device that once
      // installed a caching worker keeps serving stale bundles after a
      // deploy even though the new worker has taken over.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
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
