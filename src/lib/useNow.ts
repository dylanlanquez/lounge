import { useEffect, useState } from 'react';

// Returns a Date that re-renders the caller every `intervalMs` (default 60s).
// Used for derived state like "minutes past appointment start_at" so the
// late / no-show nudge surfaces without a manual refresh.
export function useNow(intervalMs: number = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
