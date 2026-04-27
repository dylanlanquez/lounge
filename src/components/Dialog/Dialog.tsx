import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
}

// Centred dialog for desktop. Tablet/mobile flows use BottomSheet instead.

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
  dismissable = true,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
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
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
      }}
    >
      <div
        onClick={() => dismissable && onClose()}
        style={{
          position: 'absolute',
          inset: 0,
          background: theme.color.overlay,
          animation: 'lng-fade 180ms ease-out',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: width,
          background: theme.color.surface,
          borderRadius: theme.radius.card,
          boxShadow: theme.shadow.overlay,
          maxHeight: '92dvh',
          display: 'flex',
          flexDirection: 'column',
          animation: 'lng-dialog-in 200ms cubic-bezier(0.25, 1, 0.3, 1)',
        }}
      >
        {(title || description || dismissable) && (
          <header
            style={{
              padding: `${theme.space[6]}px ${theme.space[6]}px ${theme.space[3]}px`,
              display: 'flex',
              gap: theme.space[4],
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              {title ? (
                <h2
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.lg,
                    fontWeight: theme.type.weight.semibold,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted }}>{description}</p>
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
                  cursor: 'pointer',
                  padding: theme.space[2],
                  marginTop: -theme.space[2],
                }}
              >
                <X size={20} />
              </button>
            ) : null}
          </header>
        )}

        <div
          style={{
            padding: `${theme.space[3]}px ${theme.space[6]}px ${theme.space[6]}px`,
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {children}
        </div>

        {footer ? (
          <footer
            style={{
              padding: theme.space[5],
              borderTop: `1px solid ${theme.color.border}`,
            }}
          >
            {footer}
          </footer>
        ) : null}
      </div>

      <DialogKeyframes />
    </div>,
    document.body
  );
}

function DialogKeyframes() {
  return (
    <style>{`
      @keyframes lng-dialog-in {
        from { opacity: 0; transform: scale(0.96); }
        to   { opacity: 1; transform: scale(1); }
      }
    `}</style>
  );
}
