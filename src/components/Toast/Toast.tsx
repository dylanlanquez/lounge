import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../BottomNav/BottomNav.tsx';

// Toast renders as a fixed overlay anchored above the bottom nav, no
// matter where in the tree the <Toast> element is mounted. Previously
// the component was a plain styled div and every caller had to wrap
// it in their own position:fixed container; in practice almost none
// of them did, and the toast ended up inline — pushing the rest of
// the page up and down on appear/dismiss (see the No-attendance toast
// on AppointmentDetail). Centralising the positioning here fixes all
// 30-odd existing call sites without touching any of them.
//
// Implementation notes:
//   • createPortal to document.body so a Toast rendered inside a
//     transformed ancestor (BottomSheet uses translate3d for the
//     enter animation) still positions relative to the viewport
//     rather than the transformed parent — CSS position:fixed
//     becomes relative to a transformed ancestor instead of the
//     viewport, which would otherwise put the toast in the wrong
//     place inside an open sheet.
//   • zIndex 1100 keeps it above BottomSheet (1000) and the
//     lightbox (1000) — when a sheet is open and a toast fires the
//     toast still surfaces. Above BottomNav (50) and KioskStatusBar
//     (49) too.
//   • Bottom offset accounts for BOTTOM_NAV_HEIGHT, the iOS safe
//     area, and a small breathing-room gap.

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  tone?: ToastTone;
  title: string;
  description?: ReactNode;
  duration?: number; // ms, 0 = sticky
  onDismiss?: () => void;
}

const ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertCircle,
  info: Info,
};

const ICON_COLOR: Record<ToastTone, string> = {
  success: theme.color.accent,
  error: theme.color.alert,
  warning: theme.color.ink,
  info: theme.color.ink,
};

export function Toast({ tone = 'info', title, description, duration = 4000, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  if (!visible) return null;
  // SSR / pre-hydration guard. document is undefined during a
  // server render; in practice the app is client-only but the
  // explicit check keeps the component safe to import from any
  // entry point.
  if (typeof document === 'undefined') return null;

  const Icon = ICONS[tone];

  const overlay: CSSProperties = {
    position: 'fixed',
    left: '50%',
    bottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${theme.space[5]}px + env(safe-area-inset-bottom, 0px))`,
    transform: 'translateX(-50%)',
    zIndex: 1100,
    // Don't intercept page clicks behind the toast — the dismiss
    // button + card itself remain interactive via pointer-events on
    // the card.
    pointerEvents: 'none',
    width: 'auto',
    maxWidth: `calc(100vw - ${theme.space[6]}px)`,
    display: 'flex',
    justifyContent: 'center',
  };

  const card: CSSProperties = {
    background: theme.color.surface,
    borderRadius: theme.radius.card,
    boxShadow: theme.shadow.overlay,
    padding: theme.space[4],
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.space[3],
    minWidth: 280,
    maxWidth: 420,
    width: '100%',
    pointerEvents: 'auto',
  };

  return createPortal(
    <div style={overlay}>
      <div role="status" aria-live="polite" style={card}>
        <Icon size={22} style={{ color: ICON_COLOR[tone], flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {title}
          </p>
          {description ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setVisible(false);
            onDismiss?.();
          }}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: theme.color.inkMuted,
            cursor: 'pointer',
            padding: 0,
            lineHeight: 0,
            flexShrink: 0,
          }}
        >
          <X size={18} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
