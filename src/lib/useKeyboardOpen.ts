import { useEffect, useState } from 'react';

// Returns true when the iPadOS / iOS soft keyboard is up. Detected
// via the visualViewport API: when the keyboard slides in the
// visual viewport shrinks below the layout viewport. A 150px
// threshold reliably separates the docked + split keyboards from
// noise (browser chrome variation, momentary resize). Falls back
// to false on platforms without visualViewport (no keyboard
// concern in those environments anyway).
//
// Centralised here so every fixed-bottom surface (BottomNav, the
// arrival ActionBar, anything else added later) reads the same
// signal and hides / repositions consistently.
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setOpen(window.innerHeight - vv.height > 150);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return open;
}
