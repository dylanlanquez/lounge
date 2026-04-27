import { type ReactNode, useEffect, useRef } from 'react';
import { theme } from '../../theme/index.ts';

export interface KeyboardAwareScrollProps {
  children: ReactNode;
  // Extra padding below the focused field, so it does not sit flush against
  // the on-screen keyboard top edge.
  bottomPadding?: number;
}

// Tablet helper: when an input gains focus, scroll the page so the input is
// comfortably above the on-screen keyboard. iOS does this natively but Android
// (Galaxy Tab S10 FE) is inconsistent. visualViewport API gives us the keyboard
// height; we adjust scrollTop and add bottom padding so the user sees what they
// are typing.

export function KeyboardAwareScroll({ children, bottomPadding = 24 }: KeyboardAwareScrollProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!isTextInput(target)) return;

      // Wait one frame so the keyboard has time to start opening.
      requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const vv = window.visualViewport!;
        const visibleBottom = vv.offsetTop + vv.height;
        const overlap = rect.bottom + bottomPadding - visibleBottom;
        if (overlap > 0) window.scrollBy({ top: overlap, behavior: 'smooth' });
      });
    };

    root.addEventListener('focusin', onFocusIn);
    return () => root.removeEventListener('focusin', onFocusIn);
  }, [bottomPadding]);

  return (
    <div
      ref={ref}
      style={{
        paddingBottom: `calc(${bottomPadding}px + env(safe-area-inset-bottom, 0px))`,
        background: theme.color.bg,
        minHeight: '100dvh',
      }}
    >
      {children}
    </div>
  );
}

function isTextInput(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return ['text', 'email', 'tel', 'number', 'search', 'url', 'password'].includes(type);
}
