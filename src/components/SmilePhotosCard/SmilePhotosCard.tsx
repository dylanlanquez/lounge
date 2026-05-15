import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, Check, ChevronDown, Loader2 } from 'lucide-react';
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
import { supabase } from '../../lib/supabase.ts';

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
//   • Each uploaded tile carries its OWN "Add to profile" link —
//     staff can promote one photo at a time rather than batching
//     all three. Independent state per tile (idle / busy / done /
//     error) so a failure on one doesn't block the others.

type Kind = 'front' | 'left' | 'right';
type PromoteState = 'idle' | 'busy' | 'done' | 'error';

interface PerTilePromoteState {
  state: PromoteState;
  message: string | null;
}

const SLOTS: Array<{ kind: Kind; label: string }> = [
  { kind: 'front', label: 'Front smile' },
  { kind: 'left', label: 'Left side' },
  { kind: 'right', label: 'Right side' },
];

const EMPTY_PROMOTE: PerTilePromoteState = { state: 'idle', message: null };

export interface SmilePhotosCardProps {
  appointmentId: string;
  // Optional promotion target. When all three are provided, each
  // uploaded tile renders an "Add to profile" link that copies that
  // single photo into the patient's matching canonical Smile Photo
  // slot (Front / Left / Right). Omit any field to render the card
  // read-only.
  patientId?: string;
  patientName?: string;
  uploaderAccountId?: string | null;
  // Called when promotion succeeds. Lets the parent refresh the
  // patient files grid (or any other dependent surface) so the new
  // smile-photo row appears without a manual reload.
  onPromoted?: () => void;
}

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

  // Per-tile promotion state. Each kind gets its own slot so a
  // failure (or success) on one tile doesn't reset the others —
  // staff can retry just the tile that failed without re-promoting
  // the ones that worked. Once a tile reaches 'done' it stays
  // there for the life of the page (no auto-revert) so staff can't
  // accidentally re-promote the same photo twice.
  const [promote, setPromote] = useState<Record<Kind, PerTilePromoteState>>({
    front: EMPTY_PROMOTE,
    left: EMPTY_PROMOTE,
    right: EMPTY_PROMOTE,
  });

  // Already-added detection. On mount (and whenever the patient
  // changes) check which smile-photo slots already exist on the
  // patient profile so the affordance reads "Added" from page
  // load, not just after the in-session promotion. Without this a
  // refresh would re-arm the button and staff could promote the
  // same photo twice.
  const existingKinds = useExistingSmilePhotoKinds(patientId);
  useEffect(() => {
    if (existingKinds.size === 0) return;
    setPromote((prev) => {
      const next = { ...prev };
      for (const k of ['front', 'left', 'right'] as const) {
        // Only seed 'done' on slots whose live state is still the
        // pristine idle placeholder; never overwrite a busy/error
        // state mid-promotion or roll back a freshly-completed one.
        if (existingKinds.has(k) && next[k].state === 'idle') {
          next[k] = { state: 'done', message: 'Added to patients profile' };
        }
      }
      return next;
    });
  }, [existingKinds]);

  const setKindState = (kind: Kind, next: PerTilePromoteState) => {
    setPromote((prev) => ({ ...prev, [kind]: next }));
  };

  const promoteOne = async (kind: Kind, row: IntakePhotoRow) => {
    if (!patientId || !patientName) return;
    // If the slot already carries a smile photo (either added in
    // this session or in a previous one), re-promotion overwrites
    // the existing canonical row on the patient profile. The
    // patient's earlier photo stays in patient_files history (the
    // version stamp keeps the trail), but the LIVE smile photo
    // becomes the one we're about to copy. Confirm before doing
    // that — staff opening a returning patient's new appointment
    // shouldn't accidentally swap the old smile photo with the
    // new one without a moment of "yes, that's what I want".
    if (promote[kind].state === 'done') {
      const slotLabel = SLOTS.find((s) => s.kind === kind)?.label.toLowerCase() ?? kind;
      const confirmed = typeof window !== 'undefined'
        ? window.confirm(
            `Replace the patient's existing ${slotLabel} photo with this one? The previous photo will stay in their file history but the live smile photo on the profile will become this one.`,
          )
        : true;
      if (!confirmed) return;
    }
    setKindState(kind, { state: 'busy', message: null });
    try {
      const result = await promoteIntakePhotosToPatientProfile({
        patientId,
        patientName,
        uploaderAccountId: uploaderAccountId ?? null,
        sources: [{
          kind: kind as IntakePhotoKindForPromotion,
          filePath: row.filePath,
          mimeType: row.mimeType,
        }],
      });
      const failure = result.errors[0];
      if (failure) {
        setKindState(kind, { state: 'error', message: failure.message });
        await logFailure({
          source: 'smile_photo_promote_failed',
          severity: 'error',
          message: failure.message,
          context: { appointmentId, patientId, kind },
        });
        return;
      }
      setKindState(kind, { state: 'done', message: 'Added to patients profile' });
      onPromoted?.();
      // No auto-revert — once promoted the tile stays "Added"
      // for the life of the page so staff can't accidentally
      // re-promote the same photo. The existingKinds query above
      // picks up this row on the next page load too.
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not add photo.';
      setKindState(kind, { state: 'error', message });
      await logFailure({
        source: 'smile_photo_promote_failed',
        severity: 'error',
        message,
        context: { appointmentId, patientId, kind },
      });
    }
  };

  const canPromote = !!patientId && !!patientName;

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
                    canPromote={canPromote && !!row}
                    promoteState={promote[s.kind]}
                    onPromote={() => row && promoteOne(s.kind, row)}
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
  canPromote,
  promoteState,
  onPromote,
}: {
  label: string;
  row: IntakePhotoRow | null;
  loading: boolean;
  canPromote: boolean;
  promoteState: PerTilePromoteState;
  onPromote: () => void;
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
      {/* Caption + per-tile promote affordance share one row so the
          two read as a single piece of metadata under the photo —
          "Front smile · Added ✓" — rather than the label sitting
          alone with the button stacked beneath it. Small inline
          gap, label first. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkMuted,
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        {canPromote || promoteState.state !== 'idle' ? (
          <PromoteTileLink
            state={promoteState}
            disabled={!canPromote || promoteState.state === 'busy'}
            onClick={onPromote}
          />
        ) : null}
      </div>
    </div>
  );
}

// Per-tile "Add to profile" affordance. Compact text link with a
// trailing arrow-in-pill — matches the visual pattern used on the
// PatientFilesGrid "View history" link. Sits under the slot
// caption, only renders when the tile has an uploaded photo AND
// the parent passed enough patient context to copy it across.
function PromoteTileLink({
  state,
  disabled,
  onClick,
}: {
  state: PerTilePromoteState;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Hover shift signals interactivity. Fires in any non-busy /
  // non-disabled state — including 'done', because re-clicking a
  // promoted tile is the documented "replace existing photo"
  // path (with a confirm prompt before commit).
  const showShift = hovered && !disabled && state.state !== 'busy';
  const labelColor =
    state.state === 'error'
      ? theme.color.alert
      : state.state === 'done'
        ? theme.color.accent
        : theme.color.ink;
  // No theme.color.alertBg token (yet) so use a tinted alert wash
  // for the error state. accentBg drives every other state — calm
  // green pill, white arrow.
  const trailingTint =
    state.state === 'error'
      ? { bg: 'rgba(184, 58, 42, 0.12)', fg: theme.color.alert }
      : { bg: theme.color.accentBg, fg: theme.color.accent };
  const labelText =
    state.state === 'busy'
      ? 'Adding…'
      : state.state === 'done'
        ? state.message ?? 'Added to patients profile'
        : state.state === 'error'
          ? state.message ?? "Couldn't add"
          : 'Add to profile';
  // The button stays clickable in the 'done' state — re-clicking
  // is the path to overwrite the existing smile photo with a new
  // one (e.g., a returning patient who uploaded fresh intake
  // photos for a follow-up appointment). The handler shows a
  // confirm prompt before actually replacing, so an accidental
  // tap doesn't silently swap the patient's canonical smile
  // photo. We only kill interactivity for the disabled and
  // in-flight states.
  const inactive = disabled || state.state === 'busy';
  return (
    <button
      type="button"
      onClick={inactive ? undefined : onClick}
      disabled={inactive}
      aria-label={labelText}
      title={state.state === 'done' ? 'Tap to replace with this photo' : undefined}
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
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: theme.type.tracking.tight,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        cursor: inactive ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        WebkitTapHighlightColor: 'transparent',
        textAlign: 'left',
        // Soft-fade the label between states so the text swap feels
        // intentional rather than abrupt. The icon spin (below)
        // carries the more dramatic motion.
        transition: `color ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}>{labelText}</span>
      <span
        aria-hidden
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: theme.radius.pill,
          background: trailingTint.bg,
          color: trailingTint.fg,
          transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.base}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
          transform: showShift ? 'translateX(2px)' : 'translateX(0)',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {/* key forces React to remount the inner icon on every state
            transition so the spin-in keyframe replays. The container
            stays mounted (so background colour transitions stay
            smooth); the swap of arrow ↔ check ↔ spinner happens
            inside it with a 360° rotate-in. */}
        <span
          key={state.state}
          style={{
            display: 'inline-flex',
            animation: `lng-smile-icon-swap ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
          }}
        >
          {state.state === 'busy' ? (
            <Loader2
              size={11}
              aria-hidden
              style={{
                animation: 'lng-smile-promote-spin 0.9s linear infinite',
              }}
            />
          ) : state.state === 'done' ? (
            <Check size={12} strokeWidth={3} aria-hidden />
          ) : (
            <ArrowRight size={11} aria-hidden />
          )}
        </span>
      </span>
      <style>{`
        @keyframes lng-smile-promote-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes lng-smile-icon-swap {
          0%   { transform: rotate(-180deg) scale(0.4); opacity: 0; }
          60%  { transform: rotate(20deg) scale(1.08); opacity: 1; }
          100% { transform: rotate(0deg) scale(1); opacity: 1; }
        }
      `}</style>
    </button>
  );
}

// Lightweight existence check — for a given patient, returns the
// set of smile-photo kinds (front / left / right) that already
// have an active patient_files row. Used by SmilePhotosCard to
// seed the per-tile promote state to 'done' on mount so the
// affordance reads "Added" from page load and can't be tapped to
// re-promote a photo that was already added in a previous session.
//
// Only the file_labels.key column is fetched (via the inner-join);
// no file urls or sizes — this is cheaper than usePatientProfileFiles
// and avoids re-rendering the whole card every time gallery files
// change.
function useExistingSmilePhotoKinds(
  patientId: string | null | undefined,
): Set<Kind> {
  const [kinds, setKinds] = useState<Set<Kind>>(() => new Set());
  useEffect(() => {
    if (!patientId) {
      setKinds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('patient_files')
        .select('file_labels:label_id(key)')
        .eq('patient_id', patientId)
        .eq('status', 'active');
      if (cancelled) return;
      if (error) {
        // Non-fatal — fall back to "no existing slots" so the
        // affordance stays interactive. The promote handler still
        // fires; the worst case is staff promoting a photo that
        // was already there (which is idempotent — Meridian's
        // version stamp keeps both rows + the latest wins).
        console.error('[useExistingSmilePhotoKinds]', error);
        setKinds(new Set());
        return;
      }
      const next = new Set<Kind>();
      // Supabase typings join the embedded select as an array even
      // when the relationship is one-to-one — flatten and read the
      // single key. Using `unknown` first because the inferred shape
      // doesn't match our narrower view of the row.
      const rows = ((data ?? []) as unknown) as Array<{
        file_labels: { key?: string } | Array<{ key?: string }> | null;
      }>;
      for (const r of rows) {
        const lbl = Array.isArray(r.file_labels) ? r.file_labels[0] : r.file_labels;
        const k = lbl?.key;
        if (k === 'smile_photo_front') next.add('front');
        else if (k === 'smile_photo_left') next.add('left');
        else if (k === 'smile_photo_right') next.add('right');
      }
      setKinds(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);
  return kinds;
}
