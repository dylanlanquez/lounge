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
