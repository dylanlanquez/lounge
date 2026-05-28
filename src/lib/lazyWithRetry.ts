import { lazy, type ComponentType } from 'react';

// Wraps React.lazy with three layers of resilience the bare lazy()
// doesn't give us:
//
//   1. Timeout — a dynamic import that just hangs (flaky Wi-Fi on a
//      kiosk iPad, partial deploy propagation where the chunk URL
//      stalls instead of 404-ing) never resolves, leaving the
//      Suspense boundary stuck on the Loading… fallback forever.
//      The bare lazy() has no timeout. We race the import against an
//      8s deadline so a hang becomes a recoverable rejection.
//
//   2. Retry — most chunk failures are transient: a momentary network
//      drop, a brief CDN edge miss. One retry catches them at near-
//      zero UX cost. The retry uses a cache-busting query so a bad
//      cached response in any layer (browser, CDN, proxy) doesn't
//      re-serve the same broken bytes.
//
//   3. Stale-chunk error wrapping — when both attempts fail, the
//      rejected promise's message is reshaped to match the pattern
//      ErrorBoundary.isStaleChunkError() looks for. That triggers the
//      existing auto-reload path: the boundary catches, stamps the
//      sessionStorage guard, and window.location.reload()s into the
//      fresh index.html / fresh chunk references.
//
// The previous bare React.lazy() left the app stuck on Loading… any
// time a chunk fetch hung, which on receptionist iPads happened every
// few days after a Vercel deploy + a momentary Wi-Fi blip. Wrapping
// the imports here turns those into a single automatic reload.

const IMPORT_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      // Use a message ErrorBoundary's stale-chunk detector matches so
      // a hang triggers the same auto-reload as a real chunk 404.
      reject(new Error(`Failed to fetch dynamically imported module (timeout): ${label}`));
    }, ms);
    promise.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
  label: string,
): ReturnType<typeof lazy<T>> {
  return lazy<T>(async () => {
    try {
      return await withTimeout(factory(), IMPORT_TIMEOUT_MS, label);
    } catch (firstErr) {
      // One retry. Browsers/CDNs occasionally hand us a transient
      // network error or a partial response; the retry usually
      // succeeds. We don't loop — if the second attempt fails too,
      // we let the rejection bubble so ErrorBoundary auto-reloads.
      console.warn(`[lazyWithRetry] first attempt failed for ${label}, retrying`, firstErr);
      try {
        return await withTimeout(factory(), IMPORT_TIMEOUT_MS, label);
      } catch (secondErr) {
        // Reshape the message so ErrorBoundary.isStaleChunkError()
        // matches and the auto-reload path takes over. Without this
        // reshape, a timeout error reads as "(timeout)" and a Safari
        // network-failed error reads as "Load failed" — neither
        // matches the existing detector and the user gets the manual
        // "Something broke" surface instead of a silent reload.
        const message = secondErr instanceof Error ? secondErr.message : String(secondErr);
        throw new Error(
          `Failed to fetch dynamically imported module: ${label} (${message})`,
        );
      }
    }
  });
}
