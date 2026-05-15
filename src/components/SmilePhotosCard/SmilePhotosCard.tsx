import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, ChevronDown, Loader2 } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';
import {
  signIntakePhotoUrl,
  useBookingIntakePhotos,
  type IntakePhotoRow,
} from '../../lib/queries/bookingIntakePhotos.ts';
import {
  promoteIntakePhotosToPatientProfile,
  type IntakePhotoKindForPromotion,
} from '../../lib/queries/promoteIntakePhotos.ts';
import { logFailure } from '../../lib/failureLog.ts';

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
  // Optional promotion target. When all three are provided AND at least
  // one intake photo has been uploaded, the card surfaces an "Add to
  // patient profile as smile photos" link that copies the intake images
  // into the patient's canonical Smile Photo slots (Front / Left /
  // Right) on the patient profile. Omit to render the card read-only.
  patientId?: string;
  patientName?: string;
  uploaderAccountId?: string | null;
  // Called when promotion succeeds. Lets the parent refresh the patient
  // files grid (or any other dependent surface) so the new smile-photo
  // rows appear without a manual reload.
  onPromoted?: () => void;
}

const SLOTS: Array<{ kind: 'front' | 'left' | 'right'; label: string }> = [
  { kind: 'front', label: 'Front smile' },
  { kind: 'left', label: 'Left side' },
  { kind: 'right', label: 'Right side' },
];

export function SmilePhotosCard({
  appointmentId,
  patientId,
  patientName,
  uploaderAccountId,
  onPromoted,
}: SmilePhotosCardProps) {
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

  // Promotion state for the "Add to patient profile as smile photos"
  // link. Idle until the user clicks; busy while photos are downloading
  // + uploading; done shows a 3s confirmation; error surfaces a loud
  // message (no silent fallbacks per CLAUDE.md). The link is gated
  // behind: patient context provided, at least one intake photo
  // uploaded, and not already in flight.
  const [promoteState, setPromoteState] =
    useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);
  const canPromote =
    !!patientId &&
    !!patientName &&
    uploadedCount > 0 &&
    promoteState !== 'busy';

  const handlePromote = async () => {
    if (!patientId || !patientName) return;
    setPromoteState('busy');
    setPromoteMessage(null);
    const sources = rows.map((r) => ({
      kind: r.kind as IntakePhotoKindForPromotion,
      filePath: r.filePath,
      mimeType: r.mimeType,
    }));
    try {
      const result = await promoteIntakePhotosToPatientProfile({
        patientId,
        patientName,
        uploaderAccountId: uploaderAccountId ?? null,
        sources,
      });
      if (result.errors.length > 0) {
        const which = result.errors.map((e) => e.kind).join(', ');
        const detail = result.errors[0]!.message;
        setPromoteState('error');
        setPromoteMessage(
          `Couldn't copy ${which}: ${detail}. ${result.promoted.length > 0 ? `${result.promoted.length} added.` : ''}`,
        );
        await logFailure({
          source: 'smile_photo_promote_partial',
          severity: 'warning',
          message: detail,
          context: {
            appointmentId,
            patientId,
            promoted: result.promoted,
            errors: result.errors,
          },
        });
        return;
      }
      setPromoteState('done');
      setPromoteMessage(
        result.promoted.length === 1
          ? 'Added 1 photo to patient profile.'
          : `Added ${result.promoted.length} photos to patient profile.`,
      );
      onPromoted?.();
      // Auto-revert to idle after 3s so the link reads as "ready to
      // re-run" again. The 3s tracks Toast's standard dwell time
      // elsewhere in the app.
      setTimeout(() => {
        setPromoteState('idle');
        setPromoteMessage(null);
      }, 3000);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not add photos.';
      setPromoteState('error');
      setPromoteMessage(message);
      await logFailure({
        source: 'smile_photo_promote_failed',
        severity: 'error',
        message,
        context: { appointmentId, patientId },
      });
    }
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
            {canPromote || promoteState !== 'idle' ? (
              <PromoteToProfileLink
                state={promoteState}
                message={promoteMessage}
                disabled={!canPromote}
                onClick={handlePromote}
              />
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

// Plain text link with a trailing arrow-in-pill, matching the Patient
// Files Grid "View history" affordance — no background, no pill chrome
// on the label itself, just bold ink type plus a 22px accent-tinted
// circle holding a Lucide ArrowRight. Surfaced beneath the photo grid
// when the parent passed enough patient context to copy the photos
// across. Empty state (no patient context, no upload yet) hides the
// link entirely so the read-only render is unchanged.
function PromoteToProfileLink({
  state,
  message,
  disabled,
  onClick,
}: {
  state: 'idle' | 'busy' | 'done' | 'error';
  message: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const showShift = hovered && !disabled && state === 'idle';
  const labelColor =
    state === 'error'
      ? theme.color.alert
      : state === 'done'
        ? theme.color.accent
        : theme.color.ink;
  // No theme.color.alertBg token (yet) so use a tinted alert wash for
  // the error state. accentBg drives every other state — calm green
  // pill, white arrow.
  const trailingTint =
    state === 'error'
      ? { bg: 'rgba(184, 58, 42, 0.12)', fg: theme.color.alert }
      : { bg: theme.color.accentBg, fg: theme.color.accent };
  const labelText =
    state === 'busy'
      ? 'Adding to patient profile…'
      : state === 'done'
        ? message ?? 'Added to patient profile'
        : state === 'error'
          ? message ?? "Couldn't add to patient profile"
          : 'Add to patient profile as smile photos';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-start',
        marginTop: theme.space[5],
      }}
    >
      <button
        type="button"
        onClick={disabled || state === 'busy' ? undefined : onClick}
        disabled={disabled || state === 'busy'}
        aria-label={labelText}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          fontFamily: 'inherit',
          color: labelColor,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[3],
          cursor: disabled || state === 'busy' ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span>{labelText}</span>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: theme.radius.pill,
            background: trailingTint.bg,
            color: trailingTint.fg,
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            transform: showShift ? 'translateX(3px)' : 'translateX(0)',
            flexShrink: 0,
          }}
        >
          {state === 'busy' ? (
            <Loader2
              size={14}
              aria-hidden
              style={{
                animation: 'lng-smile-promote-spin 0.9s linear infinite',
              }}
            />
          ) : (
            <ArrowRight size={14} aria-hidden />
          )}
        </span>
      </button>
      <style>{`
        @keyframes lng-smile-promote-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
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

  // Tile chrome matches PhotoGallery.tsx's UploadTile precisely:
  // square aspect, theme.radius.card corners, 1.5px dashed border in
  // theme.color.border, theme.color.surface fill. The empty state
  // mirrors the Add-before / Add-after layout: a 44x44 pill-radius
  // icon well on theme.color.bg with a 20px Camera glyph, then a
  // semibold sm label under it. Only difference, since this card is
  // read-only (uploads happen on the customer success screen), is
  // the inside label says "Not uploaded" instead of "Add …".
  //
  // Slot identification (Front smile / Left side / Right side)
  // stays as a caption below the tile — Before & After cards don't
  // need this because the bold inside-label IS the affordance text;
  // here the inside text is a state ("Not uploaded"), so the
  // outside caption answers "which view is this".
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <a
        href={signedUrl ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={signedUrl ? `Open ${label} photo` : `${label} — not uploaded`}
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          borderRadius: theme.radius.card,
          background: theme.color.surface,
          border: signedUrl
            ? `1px solid ${theme.color.border}`
            : `1.5px dashed ${theme.color.border}`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[2],
          color: theme.color.inkMuted,
          cursor: signedUrl ? 'zoom-in' : 'default',
          textDecoration: 'none',
          boxSizing: 'border-box',
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
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: theme.radius.pill,
                background: theme.color.bg,
              }}
            >
              <Camera size={20} aria-hidden />
            </span>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                textAlign: 'center',
              }}
            >
              {loading ? 'Loading…' : 'Not uploaded'}
            </span>
          </>
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
