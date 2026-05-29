import { useEffect, useState } from 'react';

// Returns { open, height } for the iPadOS / iOS / Android soft keyboard.
// Computed from the visualViewport API: when the keyboard slides in,
// visualViewport.height shrinks below window.innerHeight by the
// keyboard's height. A 150px floor matches useKeyboardOpen's existing
// threshold, separating the docked + split keyboards from URL-bar /
// browser-chrome variation.
//
// Why this exists alongside useKeyboardOpen: the boolean form is what
// BottomNav and the arrival ActionBar already use to decide whether to
// render. The Arrival page additionally needs the numeric height so it
// can size its scroll padding to clear the keyboard — without it, the
// patient can't scroll the bottom fields above the keyboard, because
// the document body is position:fixed and #root's scroll range tops
// out at the layout viewport's bottom (i.e. below the keyboard).
//
// height is reported as 0 when the keyboard is closed (or when there's
// no visualViewport API, e.g. desktop or older browsers), so callers
// can always sum it into a calc() without a branch.
export interface KeyboardInsets {
  open: boolean;
  height: number;
}

export function useKeyboardInsets(): KeyboardInsets {
  const [insets, setInsets] = useState<KeyboardInsets>({ open: false, height: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const diff = window.innerHeight - vv.height;
      const open = diff > 150;
      setInsets({ open, height: open ? diff : 0 });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return insets;
}
