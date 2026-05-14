import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Camera, ChevronDown } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';
import {
  signIntakePhotoUrl,
  useBookingIntakePhotos,
  type IntakePhotoRow,
} from '../../lib/queries/bookingIntakePhotos.ts';

// SmilePhotosCard — collapsible card that surfaces the pre-visit
// smile photos the patient uploaded from the booking-confirmation
// screen. Lives on both AppointmentDetail (pre-arrival) and
// VisitDetail (post-arrival) so the clinical team sees the same
// reference shots wherever they're scanning a booking.
//
// Behaviour:
//   • Closed by default.
//   • Auto-opens once the live photos query resolves WITH at least
//     one upload, so a card with content surfaces itself rather
//     than hiding the only thing that matters. Staff can still
//     manually close — their toggle wins after that.
//   • Header carries a small accent-tinted counter pill when one
//     or more photos have landed (so staff can see "we have 2 of
//     3" at a glance without expanding).
//   • Body stays mounted across toggles (CSS grid 0fr/1fr trick)
//     so the signed-URL fetches don't restart every time the card
//     is opened.

export interface SmilePhotosCardProps {
  appointmentId: string;
}

const SLOTS: Array<{ kind: 'front' | 'left' | 'right'; label: string }> = [
  { kind: 'front', label: 'Front smile' },
  { kind: 'left', label: 'Left side' },
  { kind: 'right', label: 'Right side' },
];

export function SmilePhotosCard({ appointmentId }: SmilePhotosCardProps) {
  const { rows, loading, error } = useBookingIntakePhotos(appointmentId);
  const byKind = new Map(rows.map((r) => [r.kind, r] as const));
  const uploadedCount = rows.length;

  // Auto-open the FIRST time rows arrive with at least one upload.
  // After that, the user's manual toggle takes over (tracked by
  // userToggledRef). This means a fresh page load on a booking
  // that has photos lands with the card already open, while a
  // page with no photos stays compact.
  const [open, setOpen] = useState(false);
  const userToggledRef = useRef(false);
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (userToggledRef.current) return;
    if (autoOpenedRef.current) return;
    if (loading) return;
    if (uploadedCount > 0) {
      setOpen(true);
      autoOpenedRef.current = true;
    }
  }, [loading, uploadedCount]);

  const toggle = () => {
    userToggledRef.current = true;
    setOpen((o) => !o);
  };

  const panelId = `lng-smile-photos-${appointmentId}`;

  return (
    <Card padding="lg">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        style={{
          appearance: 'none',
          width: '100%',
          padding: 0,
          margin: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          color: 'inherit',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <SectionHeader
          icon={<Camera size={15} aria-hidden />}
          title="Pre-visit smile photos"
          trailing={
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[2],
              }}
            >
              {uploadedCount > 0 ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 9px',
                    minWidth: 22,
                    height: 22,
                    borderRadius: theme.radius.pill,
                    background: theme.color.accentBg,
                    color: theme.color.accent,
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.semibold,
                    letterSpacing: theme.type.tracking.tight,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1,
                  }}
                  aria-label={`${uploadedCount} of ${SLOTS.length} uploaded`}
                >
                  {uploadedCount}
                </span>
              ) : null}
              <ChevronDown
                size={18}
                color={theme.color.inkSubtle}
                aria-hidden
                style={{
                  transition: `transform ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
                  transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            </span>
          }
        />
      </button>
      <div
        id={panelId}
        role="region"
        style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          <div style={{ paddingTop: theme.space[4] }}>
            {error ? (
              <p
                style={{
                  margin: '8px 0 0',
                  fontSize: theme.type.size.sm,
                  color: theme.color.alert,
                }}
              >
                Couldn't load photos: {error}
              </p>
            ) : null}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
                marginTop: 4,
              }}
            >
              {SLOTS.map((s) => {
                const row = byKind.get(s.kind) ?? null;
                return (
                  <PhotoTile
                    key={s.kind}
                    label={s.label}
                    row={row}
                    loading={loading}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// Local minimal section header in the same visual style as
// AppointmentDetail's DetailSectionHeader. Inlined here so the
// shared component doesn't depend on a header extracted from
// AppointmentDetail.tsx — keeps the file standalone.
function SectionHeader({
  icon,
  title,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[3],
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h3>
      </span>
      {trailing ? <span style={{ flexShrink: 0 }}>{trailing}</span> : null}
    </div>
  );
}

function PhotoTile({
  label,
  row,
  loading,
}: {
  label: string;
  row: IntakePhotoRow | null;
  loading: boolean;
}) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!row) {
      setSignedUrl(null);
      return;
    }
    let cancelled = false;
    void signIntakePhotoUrl(row.filePath).then((url) => {
      if (!cancelled) setSignedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [row]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <a
        href={signedUrl ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          borderRadius: 10,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: signedUrl ? 'zoom-in' : 'default',
          textDecoration: 'none',
        }}
      >
        {signedUrl ? (
          <img
            src={signedUrl}
            alt={`${label} photo`}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              textAlign: 'center',
              padding: 8,
            }}
          >
            {loading ? 'Loading…' : 'Not uploaded'}
          </span>
        )}
      </a>
      <span
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkMuted,
        }}
      >
        {label}
      </span>
    </div>
  );
}
