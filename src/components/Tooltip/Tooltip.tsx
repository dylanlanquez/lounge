import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { theme } from '../../theme/index.ts';

// Themed inline tooltip primitive.
//
// Tap-driven by default — the kiosk is a touch surface and hover does
// not exist there. Tap the trigger wrapper to toggle, tap outside or
// press Escape to dismiss. The panel is anchored beneath (or above)
// the trigger and animates in with a 4px translate + opacity.
//
// Usage: wrap any inline element. The wrapper itself does not render
// a button, so the trigger keeps its own semantics (icon-button,
// link, etc.) and consumers control the touch target size.
//
//   <Tooltip content="Explanation">
//     <button aria-label="Why?"><Info size={14} /></button>
//   </Tooltip>

export interface TooltipProps {
  content: ReactNode;
  // 'auto' (default) measures available space at open time and picks
  // the side with more room — keeps the panel from getting clipped
  // when the trigger is near the bottom of a BottomSheet or the top
  // of the viewport.
  side?: 'top' | 'bottom' | 'auto';
  align?: 'start' | 'center' | 'end';
  maxWidth?: number;
  // 'dark' (default) renders a black panel with surface-coloured text
  // for inline annotations. 'light' uses the same white-card treatment
  // we use for hover cards elsewhere in the app — soft shadow,
  // hairline border, ink text — for help / explanation content.
  variant?: 'dark' | 'light';
  children: ReactNode;
}

export function Tooltip({
  content,
  side = 'auto',
  align = 'start',
  maxWidth = 320,
  variant = 'dark',
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [resolvedSide, setResolvedSide] = useState<'top' | 'bottom'>(
    side === 'top' ? 'top' : 'bottom',
  );
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipId = useId();

  // When side='auto', flip on open if there isn't enough room below.
  // Approximated panel height — the actual content varies, but a
  // 200px buffer covers the typical 2 to 3-line tooltip without
  // measuring the rendered panel (which would need a second pass).
  useLayoutEffect(() => {
    if (!open) return;
    if (side === 'top' || side === 'bottom') {
      setResolvedSide(side);
      return;
    }
    if (!wrapperRef.current) return;
    const APPROX_HEIGHT = 200;
    const VIEWPORT_PAD = 16;
    const r = wrapperRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_PAD;
    const spaceAbove = r.top - VIEWPORT_PAD;
    setResolvedSide(
      spaceBelow >= APPROX_HEIGHT || spaceBelow >= spaceAbove ? 'bottom' : 'top',
    );
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const horizontal =
    align === 'center'
      ? { left: '50%', transform: 'translateX(-50%)' }
      : align === 'end'
        ? { right: 0 }
        : { left: 0 };

  const vertical =
    resolvedSide === 'top' ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' };

  return (
    <span
      ref={wrapperRef}
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      <span
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        aria-describedby={open ? tooltipId : undefined}
        style={{ display: 'inline-flex', cursor: 'pointer' }}
      >
        {children}
      </span>
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'absolute',
            ...horizontal,
            ...vertical,
            zIndex: 100,
            background: variant === 'light' ? theme.color.surface : theme.color.ink,
            color: variant === 'light' ? theme.color.ink : theme.color.surface,
            border: variant === 'light' ? `1px solid ${theme.color.border}` : 'none',
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.regular,
            lineHeight: theme.type.leading.snug,
            letterSpacing: 0,
            maxWidth,
            width: 'max-content',
            boxShadow: theme.shadow.overlay,
            animation: `lng-tooltip-${resolvedSide}-enter ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
            pointerEvents: 'auto',
          }}
        >
          {content}
        </span>
      ) : null}
      <style>{`
        @keyframes lng-tooltip-bottom-enter {
          from { opacity: 0; transform: ${align === 'center' ? 'translateX(-50%) ' : ''}translateY(-4px); }
          to   { opacity: 1; transform: ${align === 'center' ? 'translateX(-50%) ' : ''}translateY(0); }
        }
        @keyframes lng-tooltip-top-enter {
          from { opacity: 0; transform: ${align === 'center' ? 'translateX(-50%) ' : ''}translateY(4px); }
          to   { opacity: 1; transform: ${align === 'center' ? 'translateX(-50%) ' : ''}translateY(0); }
        }
      `}</style>
    </span>
  );
}
