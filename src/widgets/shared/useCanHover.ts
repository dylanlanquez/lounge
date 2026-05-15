import { useEffect, useState } from 'react';

// useCanHover — returns TRUE on devices whose primary pointer can
// hover (mouse, trackpad), FALSE on touch-only devices (phones,
// most tablets). Used to gate the JS-driven "hovered" state on
// interactive cards so a tap on a phone can never paint a card
// with an accent border that reads as "selected".
//
// Why we need this: iOS Safari has "sticky hover" — once a touch
// tap lands on an element, the browser keeps it in the :hover /
// onMouseEnter state until the user taps somewhere else. The
// modal's option cards use that hover state to draw an accent
// border + soft lift shadow, which on a phone reads identically
// to the "selected" state. Net effect: the customer taps a card,
// it looks selected, they think they've picked it, but the
// underlying state never actually flipped to selected. Disabling
// hover state on touch devices eliminates the ambiguity entirely.
//
// The hook also tracks media-query changes, so a Surface-style
// device that switches between touch and trackpad input mid-
// session sees the hover behaviour appear/disappear correctly.
//
// SSR safe: returns FALSE during server render (no window) so the
// first client paint matches whatever the device actually supports.
export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState<boolean>(() => readCanHover());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(hover: hover)');
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches);
    // Safari < 14 used addListener; modern Safari + every other
    // browser is on addEventListener. Both are no-ops if the env
    // doesn't support the corresponding API.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return canHover;
}

function readCanHover(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(hover: hover)').matches;
}
