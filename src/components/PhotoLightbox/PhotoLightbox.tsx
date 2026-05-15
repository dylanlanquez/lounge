import { useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// PhotoLightbox — shared in-app fullscreen image viewer.
//
// Lounge runs in iPad kiosk mode where new tabs / windows aren't
// available, so every photo display surface in the app has to keep
// the patient + the operator inside the same React tree. This is
// the canonical "tap a thumbnail to enlarge" component for those
// surfaces.
//
// API: feed it a list of pre-signed URLs + an index. The component
// owns the fullscreen chrome (dim backdrop, X to close, optional
// prev/next arrows, esc + arrow keys), the parent owns which photo
// is open (controlled). Set index to null to close.
//
// Pre-signing is the parent's job — that way the lightbox can be
// reused across surfaces with different storage buckets (intake
// photos, patient files, marketing assets, before/after) without
// pulling every signing helper into one file.

export interface LightboxPhoto {
  /** Signed URL the lightbox will render. */
  url: string;
  /** Optional aria-label / fallback alt — usually the slot name
   *  ("Front smile" / "Before, 12 May") so screen readers and
   *  vision-low operators get context. */
  label?: string | null;
  /** Optional caption rendered under the image (small muted line).
   *  Useful for upload date, kind, uploader name. */
  caption?: string | null;
}

export interface PhotoLightboxProps {
  photos: ReadonlyArray<LightboxPhoto>;
  /** Currently visible photo. Null = closed. */
  index: number | null;
  /** Called with the new index OR null to close. The parent stores
   *  the open index so the lightbox stays controlled and can be
   *  driven from anywhere (a thumbnail click, a keyboard shortcut,
   *  a programmatic walkthrough). */
  onChange: (next: number | null) => void;
}

export function PhotoLightbox({ photos, index, onChange }: PhotoLightboxProps) {
  const open = index !== null && index >= 0 && index < photos.length;
  const current = open ? photos[index!] ?? null : null;

  // Keyboard nav: Esc closes, arrows step. Same handling pattern as
  // PhotoGallery's existing lightbox so the muscle-memory matches
  // across the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onChange(null);
        return;
      }
      if (photos.length <= 1) return;
      if (e.key === 'ArrowLeft' && index! > 0) onChange(index! - 1);
      if (e.key === 'ArrowRight' && index! < photos.length - 1) onChange(index! + 1);
    };
    document.addEventListener('keydown', onKey);
    // Lock #root scroll while open. body is pinned by globalStyles
    // for iOS rubber-band reasons; the real page scroller is #root.
    const root = document.getElementById('root');
    const prev = root?.style.overflow ?? '';
    if (root) root.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      if (root) root.style.overflow = prev;
    };
  }, [open, index, photos.length, onChange]);

  if (!open || !current) return null;

  const hasPrev = photos.length > 1 && index! > 0;
  const hasNext = photos.length > 1 && index! < photos.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.label ?? 'Photo'}
      onClick={() => onChange(null)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0, 0, 0, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[5],
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange(null);
        }}
        aria-label="Close photo"
        style={{
          position: 'absolute',
          top: theme.space[5],
          right: theme.space[5],
          width: 44,
          height: 44,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(255, 255, 255, 0.14)',
          color: '#fff',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={22} aria-hidden />
      </button>

      {hasPrev ? (
        <NavButton side="left" onClick={() => onChange(index! - 1)} />
      ) : null}
      {hasNext ? (
        <NavButton side="right" onClick={() => onChange(index! + 1)} />
      ) : null}

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        <img
          src={current.url}
          alt={current.label ?? ''}
          style={{
            maxWidth: '92vw',
            maxHeight: '78vh',
            objectFit: 'contain',
            borderRadius: theme.radius.card,
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
          }}
        />
        {(current.label || current.caption || photos.length > 1) ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[2],
              color: 'rgba(255, 255, 255, 0.85)',
              fontSize: theme.type.size.sm,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {current.label ? (
              <span style={{ fontWeight: theme.type.weight.semibold }}>
                {current.label}
              </span>
            ) : null}
            {current.caption ? <span>· {current.caption}</span> : null}
            {photos.length > 1 ? (
              <span>
                · {index! + 1} of {photos.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NavButton({
  side,
  onClick,
}: {
  side: 'left' | 'right';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={side === 'left' ? 'Previous photo' : 'Next photo'}
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        [side]: theme.space[5],
        width: 48,
        height: 48,
        borderRadius: '50%',
        border: 'none',
        background: 'rgba(255, 255, 255, 0.14)',
        color: '#fff',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {side === 'left' ? (
        <ChevronLeft size={26} aria-hidden />
      ) : (
        <ChevronRight size={26} aria-hidden />
      )}
    </button>
  );
}
