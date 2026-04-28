import { useEffect, useState } from 'react';

// Returns true when viewport is narrower than the breakpoint (default 720).
// Updates on resize.

export function useIsMobile(maxWidth = 720): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < maxWidth : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobile(window.innerWidth < maxWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maxWidth]);

  return isMobile;
}

// True when the device is a desktop or laptop — viewport ≥ 1024px AND a
// fine pointer (mouse / trackpad). Samsung tabs and iPads report
// pointer:coarse so they read as not-desktop even in wide landscape.
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => computeIsDesktop());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setIsDesktop(computeIsDesktop());
    window.addEventListener('resize', update);
    const mql = window.matchMedia('(pointer: fine)');
    mql.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('resize', update);
      mql.removeEventListener?.('change', update);
    };
  }, []);

  return isDesktop;
}

function computeIsDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  const wideEnough = window.innerWidth >= 1024;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  return wideEnough && finePointer;
}
