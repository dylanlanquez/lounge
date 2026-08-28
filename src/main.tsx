import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { applyGlobalStyles } from './theme/globalStyles.ts';
import { installScrollGuard } from './lib/installScrollGuard.ts';
import { ErrorBoundary, initTelemetry } from './lib/telemetry/index.js';

// ── Telemetry ────────────────────────────────────────────────────────────────
// Cross-app error monitoring with breadcrumbs. Particularly worth having here:
// Lounge runs on kiosk tablets that nobody is watching, so a failure has no one
// present to report it.
//
// Lounge already has its own ErrorBoundary at src/components/ErrorBoundary; this
// adds a reporting boundary ABOVE it. The existing one keeps handling in-app
// recovery, this one guarantees the failure is recorded even if the app shell
// itself is what broke.
initTelemetry({
  app: 'lounge',
  ingestUrl: import.meta.env.VITE_TELEMETRY_URL,
  anonKey: import.meta.env.VITE_TELEMETRY_KEY,
  release: import.meta.env.VITE_RELEASE,
  resolveRoute: (path: string) =>
    path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:n'),
});

applyGlobalStyles();
// Block iPad rubber-band on pages whose content already fits. The
// body is pinned (globalStyles) but #root accepts touch as scroll
// regardless of content; without this guard a short Schedule day
// or a settled visit still has a millimetre of elastic give that
// reads as "the page is wobbly" on a kiosk. See
// src/lib/installScrollGuard.ts for the why.
installScrollGuard();

// Register the service worker so Chrome recognises Lounge as installable.
// Network-only strategy — see public/sw.js. Skip in dev to avoid Vite HMR
// confusion.
//
// Auto-update on deploy. Lounge runs on kiosk tablets that stay open for
// hours, and an installed Home-Screen PWA keeps its own isolated storage,
// so without this a deploy never reaches the device until someone wipes
// site data by hand. When a freshly-installed worker takes control we
// reload once (guarded against the reload loop controllerchange can
// otherwise cause) so the tab swaps onto the new bundle, and we poll for
// a newer worker on load + every time the tablet is brought back to the
// foreground (the browser's own 24h check is far too slow for a kiosk).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
        // A kiosk that sits on one page all day and is never locked,
        // backgrounded, or reloaded never fires visibilitychange, so
        // load-time + foreground checks alone leave it stranded on the
        // bundle it booted with — a deploy silently never reaches it.
        // Poll for a newer worker on a fixed cadence so an untouched
        // tablet converges on the latest bundle within a minute without
        // anyone having to walk over and touch it. sw.js is served
        // no-store, so each check is a cheap conditional GET (304 when
        // unchanged); the reload only fires via controllerchange above
        // when the bytes actually differ.
        setInterval(() => reg.update().catch(() => {}), 60_000);
      })
      .catch((err) => {
        console.warn('[lounge] service worker registration failed', err);
      });
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary name="root">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
