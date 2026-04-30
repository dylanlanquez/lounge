import { useCallback, useRef, useState } from 'react';

// Stale-while-revalidate loading semantics for every data hook in
// the app.
//
// The naïve pattern below is what every hook used to do, and what
// caused the visible flicker on every refresh, every signed waiver,
// every cart item add — anything that bumped a tick:
//
//   useEffect(() => {
//     setLoading(true);            // ← flips the UI back to a skeleton
//     const result = await fetch();
//     setData(result);
//     setLoading(false);
//   }, [id, tick]);
//
// Stale-while-revalidate (the same pattern react-query / SWR ship by
// default) inverts that: existing data stays on screen while the next
// fetch runs, and only the *first* fetch — or a fetch for a brand-
// new resource — flips loading true. Three rules govern the loading
// flag this hook returns:
//
//   • Initial render (before any settle()): loading = true.
//
//   • Key transition (route param flips, parent flips id from null
//     to a real id, etc.): loading flips true synchronously during
//     the render that sees the new key, so consumers never paint
//     stale data alongside the new key. This is the case the
//     waiver hook used to guard against by manually re-asserting
//     setLoading(true) inside its effect — that hand-rolled guard
//     lives here now and is uniform across every hook.
//
//   • Refresh tick (same key, hook's `refresh()` was called): stays
//     false. Existing data remains on screen while the next fetch
//     runs; the UI does not flicker.
//
// Usage:
//
//   const [tick, setTick] = useState(0);
//   const refresh = useCallback(() => setTick((t) => t + 1), []);
//   const { loading, settle } = useStaleQueryLoading(patientId);
//   useEffect(() => {
//     if (!patientId) { settle(); return; }
//     let cancelled = false;
//     (async () => {
//       const result = await fetch(patientId);
//       if (cancelled) return;
//       setData(result);
//       settle();
//     })();
//     return () => { cancelled = true; };
//   }, [patientId, tick]);
//
// Pass null/undefined when the hook has no resource to fetch (id
// missing, debounce-throttled term too short, etc). The helper
// holds the previous loading value and the owner's effect calls
// settle() in its no-key branch the same way it always did.

export interface StaleQuery {
  loading: boolean;
  settle: () => void;
}

export function useStaleQueryLoading(
  key: string | null | undefined,
): StaleQuery {
  const [loading, setLoading] = useState(true);
  // `undefined` is the sentinel meaning "no key has been observed
  // yet" — distinct from a deliberate `null` key (no resource right
  // now). It lets us tell the first render apart from a transition
  // INTO the no-resource state, so the first render uses the
  // useState default (true) without an extra render churn.
  const lastKeyRef = useRef<string | null | undefined>(undefined);

  if (lastKeyRef.current !== key) {
    const wasFirstObservation = lastKeyRef.current === undefined;
    lastKeyRef.current = key;
    // Force loading=true on a real key transition. Skipped on:
    //   • the very first render (useState default already true)
    //   • a transition into the no-resource state (key falsy) —
    //     the owner's effect calls settle() in its null branch,
    //     which is the right outcome there
    if (!wasFirstObservation && key) {
      setLoading(true);
    }
  }

  // Stable identity across renders so callers can pass `settle`
  // through to nested hooks without extra useCallback wrapping.
  const settle = useCallback(() => setLoading(false), []);
  return { loading, settle };
}
