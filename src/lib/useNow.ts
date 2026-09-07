import { useEffect, useState } from 'react';

// Returns a Date that re-renders the caller every `intervalMs` (default 60s).
// Used for derived state like "minutes past appointment start_at" so the
// late / no-show nudge surfaces without a manual refresh.
//
// Also re-reads the clock when the tab comes back into view. Browsers
// throttle or pause timers in background tabs and on a sleeping iPad,
// so without this a kiosk woken after lunch could keep a stale "now"
// until the next tick, and anything derived from it (the now-line, the
// free-time rows) would sit in the past for a moment.
export function useNow(intervalMs: number = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(new Date());
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [intervalMs]);
  return now;
}
