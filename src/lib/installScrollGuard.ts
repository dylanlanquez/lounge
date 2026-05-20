// installScrollGuard
//
// Blocks the iOS / iPadOS rubber-band gesture on pages that don't
// actually need to scroll. Without this, swiping vertically on a
// short page in Lounge (Admin row, an empty schedule, a settled
// visit) produces a tiny elastic bounce — the body is pinned by
// globalStyles, but #root has overflow-y: auto and WebKit happily
// treats any overflow-auto container as scroll-receptive, dragging
// it a few pixels before snapping back. overscroll-behavior-y:
// contain helps at the boundary, but doesn't kill the gesture on a
// container whose content already fits.
//
// The guard walks up from the touch target on every touchmove and
// asks: is there an ancestor that is BOTH overflow:auto/scroll AND
// actually overflowing? If yes — legitimate scroll, let it happen.
// If no — preventDefault, no bounce.
//
// passive: false is required. Modern browsers default touchmove
// listeners to passive: true (so preventDefault is silently ignored)
// for scroll-perf reasons. We need the active form here because the
// whole job is preventDefault under specific conditions.
//
// One global listener, installed once at app boot. Same algorithm
// IOS_SCROLL_FIXES_V2.md Fix 1 recommends for the Capacitor portal
// — proven there, applied here to the SPA.

export function installScrollGuard(): void {
  if (typeof document === 'undefined') return;
  // Idempotent — running boot twice (rare, but possible in hot reload)
  // must not stack two guards.
  if ((document as unknown as { __lngScrollGuardInstalled?: boolean }).__lngScrollGuardInstalled) {
    return;
  }
  (document as unknown as { __lngScrollGuardInstalled?: boolean }).__lngScrollGuardInstalled = true;

  document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      // Multi-touch (pinch / zoom) gestures aren't single-element
      // scrolls — leave them to the browser so a future pinch on a
      // photo lightbox still works.
      if (e.touches.length > 1) return;

      const startTarget = e.target as Element | null;
      if (!startTarget) return;

      let canScroll = false;
      let el: Element | null = startTarget;
      while (el && el !== document.body) {
        const node = el as HTMLElement;
        const overflowY = window.getComputedStyle(node).overflowY;
        const isScrollable = overflowY === 'auto' || overflowY === 'scroll';
        if (isScrollable && node.scrollHeight > node.clientHeight) {
          canScroll = true;
          break;
        }
        el = node.parentElement;
      }

      if (!canScroll && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}
