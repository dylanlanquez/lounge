import { type ReactNode, type RefObject, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../BottomNav/BottomNav.tsx';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  // If false, no close button shown and clicking the backdrop does not dismiss.
  // Used for "must answer" sheets like the BNPL helper pre-flight.
  dismissable?: boolean;
  // When provided, renders a chevron-left icon button on the left of the
  // header. Used when the sheet has internal navigation — e.g. drilling
  // from a cluster list into one of its rows — so the receptionist can
  // pop back without dismissing the sheet entirely.
  onBack?: () => void;
  // When true, the inner scroll container has zero padding so the
  // caller can fully control its own layout (sticky elements, custom
  // padding, etc.). Used by sheets that follow iOS's large-title /
  // collapsing-header pattern, where the title scrolls away and a
  // search field pins via `position: sticky`.
  bareContent?: boolean;
  // Forwarded ref to the inner scroll container. Lets the caller
  // observe scroll state — e.g. driving an IntersectionObserver-based
  // "stuck" signal for a sticky header.
  contentRef?: RefObject<HTMLDivElement | null>;
}

export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissable = true,
  onBack,
  bareContent = false,
  contentRef,
}: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={() => dismissable && onClose()}
        style={{
          position: 'absolute',
          inset: 0,
          background: theme.color.overlay,
          animation: 'lng-fade 200ms ease-out',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 720,
          background: theme.color.surface,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          maxHeight: '92dvh',
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: `env(safe-area-inset-bottom, 0px)`,
          animation: 'lng-sheet-up 280ms cubic-bezier(0.25, 1, 0.3, 1)',
          boxShadow: theme.shadow.overlay,
        }}
      >
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: theme.space[3] }}>
          <span
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: theme.color.border,
            }}
          />
        </div>

        {(title || description || dismissable || onBack) && (
          <header
            style={{
              padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[3]}px`,
              display: 'flex',
              alignItems: 'flex-start',
              gap: theme.space[3],
            }}
          >
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: 'transparent',
                  color: theme.color.ink,
                  cursor: 'pointer',
                  padding: theme.space[2],
                  marginLeft: -theme.space[2],
                  // Centre the chevron icon on the H2 title's first-line
                  // optical centre. Title is xl (28px) at default leading
                  // ≈ 34px; subtracting the icon height (22px) and the
                  // button's vertical padding (16px) leaves 4px of nudge
                  // to bring the icon centre down onto the title centre.
                  marginTop: 4,
                  borderRadius: theme.radius.pill,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ChevronLeft size={22} />
              </button>
            ) : null}
            <div style={{ flex: 1, minWidth: 0 }}>
              {title ? (
                <h2
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xl,
                    fontWeight: theme.type.weight.semibold,
                    letterSpacing: theme.type.tracking.tight,
                    color: theme.color.ink,
                  }}
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    color: theme.color.inkMuted,
                    fontSize: theme.type.size.base,
                  }}
                >
                  {description}
                </p>
              ) : null}
            </div>
            {dismissable ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  appearance: 'none',
                  border: 'none',
                  background: 'transparent',
                  color: theme.color.ink,
                  cursor: 'pointer',
                  padding: theme.space[2],
                  marginTop: -theme.space[2],
                  borderRadius: theme.radius.pill,
                  flexShrink: 0,
                }}
              >
                <X size={22} />
              </button>
            ) : null}
          </header>
        )}

        <div
          ref={contentRef}
          style={{
            padding: bareContent
              ? 0
              : `${theme.space[3]}px ${theme.space[6]}px ${theme.space[6]}px`,
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {children}
        </div>

        {footer ? (
          // Footer height locks to the BottomNav height so the sheet's
          // top-of-footer hairline lines up with the nav's top hairline
          // across the dimmed margins — the bottom band of the page reads
          // as one continuous strip whether you're looking at the nav or
          // an open sheet's actions.
          <footer
            style={{
              // flexShrink:0 keeps the footer at exactly BOTTOM_NAV_HEIGHT
              // so the top hairline lines up with BottomNav's top hairline.
              // Without it the column flex would let the footer compress
              // when the sheet hits its 92dvh cap, leaving a visible
              // mismatch with the nav behind the dimmed overlay.
              height: BOTTOM_NAV_HEIGHT,
              flexShrink: 0,
              padding: `0 ${theme.space[5]}px`,
              borderTop: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <div style={{ width: '100%' }}>{footer}</div>
          </footer>
        ) : null}
      </div>

      <SheetKeyframes />
    </div>,
    document.body
  );
}

function SheetKeyframes() {
  return (
    <style>{`
      @keyframes lng-fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes lng-sheet-up {
        from { transform: translateY(100%); }
        to { transform: translateY(0); }
      }
    `}</style>
  );
}
