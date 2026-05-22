import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Camera, Check, ChevronDown, Loader2, Trash2, Upload } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { PhotoLightbox, type LightboxPhoto } from '../PhotoLightbox/PhotoLightbox.tsx';
import { theme } from '../../theme/index.ts';
import {
  deleteIntakePhoto,
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
  // When true, empty slots render an "Upload" affordance so any
  // signed-in staff member (reception, floor, CS, admin) can attach
  // the photo on behalf of the patient if they didn't do it from
  // the booking-confirmation page. Defaults to true.
  allowStaffUpload?: boolean;
}

export function SmilePhotosCard({
  appointmentId,
  patientId,
  patientName,
  uploaderAccountId,
  onPromoted,
  allowStaffUpload = true,
}: SmilePhotosCardProps) {
  const { rows, loading, error, refresh } = useBookingIntakePhotos(appointmentId);
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

  // Sign every available intake photo URL up-front so the lightbox
  // can render the chosen one without a fresh round-trip on click,
  // and so each PhotoTile thumbnail shares the same signed URL the
  // lightbox uses (no double-signing). Refreshes whenever the rows
  // change. Dropped URLs revoke implicitly when the component
  // unmounts — Supabase signed URLs are stateless so there's no
  // cleanup to do.
  const [signedByKind, setSignedByKind] = useState<Map<Kind, string>>(
    () => new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    if (rows.length === 0) {
      setSignedByKind(new Map());
      return;
    }
    void Promise.all(
      rows.map(async (r) => ({
        kind: r.kind as Kind,
        url: await signIntakePhotoUrl(r.filePath),
      })),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<Kind, string>();
      for (const { kind, url } of results) {
        if (url) next.set(kind, url);
      }
      setSignedByKind(next);
    });
    return () => {
      cancelled = true;
    };
  }, [rows]);

  // Lightbox state — index into the lightboxPhotos array below
  // (NOT into SLOTS), or null when closed. Keeps navigation between
  // siblings working: tap Front, arrow-right walks to Left to
  // Right; Esc / X closes.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxPhotos = useMemo<LightboxPhoto[]>(() => {
    const out: LightboxPhoto[] = [];
    for (const slot of SLOTS) {
      const url = signedByKind.get(slot.kind);
      if (!url) continue;
      out.push({ url, label: slot.label });
    }
    return out;
  }, [signedByKind]);
  // Map from kind → index into lightboxPhotos so a tile click can
  // open the lightbox at the correct position. Recomputed alongside
  // lightboxPhotos so the indices always agree.
  const lightboxIndexByKind = useMemo(() => {
    const m = new Map<Kind, number>();
    lightboxPhotos.forEach((photo, i) => {
      const slot = SLOTS.find((s) => s.label === photo.label);
      if (slot) m.set(slot.kind, i);
    });
    return m;
  }, [lightboxPhotos]);

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
  const { scopedToAppointment, anyOnProfile } = useExistingSmilePhotoKinds(
    patientId,
    appointmentId,
  );
  useEffect(() => {
    if (scopedToAppointment.size === 0) return;
    setPromote((prev) => {
      const next = { ...prev };
      for (const k of ['front', 'left', 'right'] as const) {
        // Only seed 'done' on slots whose live state is still the
        // pristine idle placeholder; never overwrite a busy/error
        // state mid-promotion or roll back a freshly-completed one.
        if (scopedToAppointment.has(k) && next[k].state === 'idle') {
          next[k] = { state: 'done', message: 'Added to patients profile' };
        }
      }
      return next;
    });
  }, [scopedToAppointment]);

  const setKindState = (kind: Kind, next: PerTilePromoteState) => {
    setPromote((prev) => ({ ...prev, [kind]: next }));
  };

  // Confirmation flow lives in a BottomSheet (Dylan's preferred dialog
  // primitive — Dialog's centred card overflows on tablet). When the
  // user taps a tile that would overwrite a live profile photo, we
  // stash the kind + row here; the sheet renders below and either
  // runs the promote on confirm, or closes on cancel.
  const [replaceConfirm, setReplaceConfirm] = useState<
    { kind: Kind; row: IntakePhotoRow } | null
  >(null);

  const requestPromote = (kind: Kind, row: IntakePhotoRow) => {
    if (!patientId || !patientName) return;
    // Warn whenever the patient profile already carries a smile
    // photo for this slot, regardless of which appointment promoted
    // it. Two cases both warn:
    //   • This appointment already promoted (promote[kind].state ===
    //     'done') — re-promoting is rare but possible if the staff
    //     re-uploaded a fresh shot.
    //   • A PRIOR appointment, or a direct staff upload, left a row
    //     on the profile (anyOnProfile.has(kind)). Overwriting that
    //     should never be silent — it's the patient's canonical
    //     photo and the operator deserves a moment of "yes, swap it".
    // Either condition triggers the BottomSheet.
    const wouldOverwrite =
      promote[kind].state === 'done' || anyOnProfile.has(kind);
    if (wouldOverwrite) {
      setReplaceConfirm({ kind, row });
      return;
    }
    void runPromote(kind, row);
  };

  const runPromote = async (kind: Kind, row: IntakePhotoRow) => {
    if (!patientId || !patientName) return;
    setKindState(kind, { state: 'busy', message: null });
    try {
      const result = await promoteIntakePhotosToPatientProfile({
        patientId,
        patientName,
        uploaderAccountId: uploaderAccountId ?? null,
        sourceAppointmentId: appointmentId,
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

  // Per-tile upload state. Staff can fire one upload per slot at a
  // time; state is keyed by kind so an in-flight Front upload doesn't
  // grey out the Left or Right tiles.
  type UploadState =
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'error'; message: string };
  const [uploadByKind, setUploadByKind] = useState<Record<Kind, UploadState>>({
    front: { status: 'idle' },
    left: { status: 'idle' },
    right: { status: 'idle' },
  });

  const handleUpload = async (kind: Kind, file: File) => {
    setUploadByKind((prev) => ({ ...prev, [kind]: { status: 'busy' } }));
    try {
      const form = new FormData();
      form.append('appointment_id', appointmentId);
      form.append('kind', kind);
      form.append('file', file);
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean;
        error?: string;
        detail?: string;
      }>('staff-upload-intake-photo', { body: form });
      if (error) {
        // supabase.functions.invoke wraps non-2xx in FunctionsHttpError
        // whose .message is the unhelpful "Edge Function returned a
        // non-2xx status code". The real reason is in error.context
        // (the Response). Pull the JSON body so the staff member sees
        // the actual function-level error (service_not_supported,
        // unsupported_mime, invalid_size, etc) rather than a generic
        // gateway message.
        const detail = await readFunctionErrorBody(error);
        throw new Error(detail ?? error.message);
      }
      if (!data?.ok) {
        throw new Error(data?.error ?? 'Upload failed');
      }
      setUploadByKind((prev) => ({ ...prev, [kind]: { status: 'idle' } }));
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      setUploadByKind((prev) => ({ ...prev, [kind]: { status: 'error', message } }));
      await logFailure({
        source: 'smile_photo_staff_upload_failed',
        severity: 'error',
        message,
        context: { appointmentId, kind },
      });
    }
  };

  // Per-tile delete state. Mirrors uploadByKind so an in-flight delete
  // on Front doesn't grey out the Left/Right tiles. Confirmation lives
  // in a BottomSheet (consistent with the "Replace existing" sheet
  // above) — staff tap trash → sheet asks them to confirm → delete
  // runs; the slot empties back to the upload affordance.
  type DeleteState =
    | { status: 'idle' }
    | { status: 'busy' };
  const [deleteByKind, setDeleteByKind] = useState<Record<Kind, DeleteState>>({
    front: { status: 'idle' },
    left: { status: 'idle' },
    right: { status: 'idle' },
  });
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: Kind } | null>(null);

  const handleDelete = async (kind: Kind) => {
    setDeleteByKind((prev) => ({ ...prev, [kind]: { status: 'busy' } }));
    try {
      await deleteIntakePhoto({ appointmentId, kind });
      setDeleteByKind((prev) => ({ ...prev, [kind]: { status: 'idle' } }));
      // Clear any prior upload-error on this slot — the slot is now
      // empty so the affordance reverts to "Upload photo".
      setUploadByKind((prev) => ({ ...prev, [kind]: { status: 'idle' } }));
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Delete failed';
      setDeleteByKind((prev) => ({ ...prev, [kind]: { status: 'idle' } }));
      // Surface the failure on the upload-state error channel — the
      // tile already has a slot for an inline alert there.
      setUploadByKind((prev) => ({ ...prev, [kind]: { status: 'error', message } }));
      await logFailure({
        source: 'smile_photo_staff_delete_failed',
        severity: 'error',
        message,
        context: { appointmentId, kind },
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
                const signedUrl = signedByKind.get(s.kind) ?? null;
                const lightboxIdx = lightboxIndexByKind.get(s.kind) ?? null;
                return (
                  <PhotoTile
                    key={s.kind}
                    label={s.label}
                    loading={loading}
                    signedUrl={signedUrl}
                    onOpenLightbox={
                      lightboxIdx !== null
                        ? () => setLightboxIndex(lightboxIdx)
                        : null
                    }
                    canPromote={canPromote && !!row}
                    promoteState={promote[s.kind]}
                    onPromote={() => row && requestPromote(s.kind, row)}
                    existsOnProfile={anyOnProfile.has(s.kind)}
                    allowStaffUpload={allowStaffUpload}
                    uploadState={uploadByKind[s.kind]}
                    onPickFile={(file) => handleUpload(s.kind, file)}
                    onRequestDelete={row ? () => setDeleteConfirm({ kind: s.kind }) : null}
                    deleteBusy={deleteByKind[s.kind].status === 'busy'}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <PhotoLightbox
        photos={lightboxPhotos}
        index={lightboxIndex}
        onChange={setLightboxIndex}
      />
      {/* In-app confirmation when re-promoting a smile photo that's
          already on the patient profile. Replaces the previous
          window.confirm so the prompt is styled in-brand and works
          on tablet (where Dialog's centred card has historically
          overflowed). Confirm = run the promote; Cancel = close. */}
      <BottomSheet
        open={!!replaceConfirm}
        onClose={() => setReplaceConfirm(null)}
        title="Replace existing smile photo?"
        description={
          replaceConfirm
            ? `The patient's ${
                SLOTS.find((s) => s.kind === replaceConfirm.kind)?.label.toLowerCase() ?? replaceConfirm.kind
              } photo on the profile will be swapped for this one. The previous photo stays in their file history; the live smile photo on the profile becomes this one.`
            : ''
        }
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              onClick={() => setReplaceConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!replaceConfirm) return;
                const { kind, row } = replaceConfirm;
                setReplaceConfirm(null);
                void runPromote(kind, row);
              }}
            >
              Replace photo
            </Button>
          </div>
        }
      >
        {/* No body content beyond title + description; the footer
            carries the action. BottomSheet's chrome handles the
            close X + backdrop dismiss for us. */}
        <div style={{ height: 1 }} />
      </BottomSheet>
      {/* Per-tile delete confirmation. Tapping the trash overlay on a
          filled tile lands here; confirm fires handleDelete and the
          slot empties back to the upload affordance. */}
      <BottomSheet
        open={!!deleteConfirm}
        onClose={() => setDeleteConfirm(null)}
        title="Delete this smile photo?"
        description={
          deleteConfirm
            ? `The ${
                SLOTS.find((s) => s.kind === deleteConfirm.kind)?.label.toLowerCase() ?? deleteConfirm.kind
              } photo will be removed from this appointment. The patient's profile smile photo, if it was already added there, is not affected.`
            : ''
        }
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!deleteConfirm) return;
                const { kind } = deleteConfirm;
                setDeleteConfirm(null);
                void handleDelete(kind);
              }}
            >
              Delete photo
            </Button>
          </div>
        }
      >
        <div style={{ height: 1 }} />
      </BottomSheet>
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
  loading,
  signedUrl,
  onOpenLightbox,
  canPromote,
  promoteState,
  onPromote,
  existsOnProfile,
  allowStaffUpload,
  uploadState,
  onPickFile,
  onRequestDelete,
  deleteBusy,
}: {
  label: string;
  loading: boolean;
  /** Signed URL for the thumbnail. Pre-signed by the parent so the
   *  lightbox shares the same URL (no double round-trip on click).
   *  Null while signing or for empty slots. */
  signedUrl: string | null;
  /** Opens the in-app PhotoLightbox at this tile's position in the
   *  SmilePhotosCard's photo array. Null when there's no photo to
   *  show (empty slot). The app runs in iPad kiosk mode so we
   *  CAN'T open photos in a new tab — every tap must stay inside
   *  the React tree. */
  onOpenLightbox: (() => void) | null;
  canPromote: boolean;
  promoteState: PerTilePromoteState;
  onPromote: () => void;
  /** True when the patient profile already carries a photo for this
   *  slot, regardless of which appointment promoted it. Drives the
   *  per-tile button text — "Replace existing photo" instead of
   *  "Add to profile" — so the operator sees the consequence of the
   *  tap before they take it. */
  existsOnProfile: boolean;
  /** When true and the slot is empty, the tile becomes an upload
   *  affordance — tap opens the file picker, and the staff member
   *  attaches the photo on the patient's behalf. */
  allowStaffUpload: boolean;
  uploadState: { status: 'idle' } | { status: 'busy' } | { status: 'error'; message: string };
  onPickFile: (file: File) => void;
  /** Opens the delete confirmation BottomSheet. Null when the slot
   *  is empty or the parent hasn't wired a delete path. */
  onRequestDelete: (() => void) | null;
  /** True while the staff-delete-intake-photo function is in flight
   *  for this slot. Disables the trash overlay so a double-tap can't
   *  fire two requests; a Loader2 spinner replaces the trash icon. */
  deleteBusy: boolean;
}) {
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const showUploadAffordance =
    !signedUrl && allowStaffUpload && uploadState.status !== 'busy';
  // Click target priorities: filled tile = lightbox; empty + upload
  // enabled = file picker; empty + read-only = no-op (parent has
  // chosen to render in display-only mode).
  const handleTileClick = () => {
    if (signedUrl && onOpenLightbox) {
      onOpenLightbox();
      return;
    }
    if (showUploadAffordance) {
      inputRef.current?.click();
    }
  };
  const interactive = (signedUrl && onOpenLightbox) || showUploadAffordance;
  const showDeleteOverlay = !!signedUrl && !!onRequestDelete;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset the input so picking the same file again triggers
          // a fresh change event (after a failed upload retry).
          e.target.value = '';
          if (file) onPickFile(file);
        }}
      />
      <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={interactive ? handleTileClick : undefined}
        disabled={!interactive}
        aria-label={
          signedUrl
            ? `Open ${label} photo`
            : showUploadAffordance
              ? `Upload ${label} photo`
              : `${label} — not uploaded`
        }
        style={{
          appearance: 'none',
          fontFamily: 'inherit',
          padding: 0,
          margin: 0,
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
          cursor: interactive ? 'pointer' : 'default',
          boxSizing: 'border-box',
          WebkitTapHighlightColor: 'transparent',
          width: '100%',
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
        ) : uploadState.status === 'busy' ? (
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
              }}
            >
              <Loader2
                size={20}
                aria-hidden
                style={{ animation: 'lng-smile-promote-spin 0.9s linear infinite' }}
              />
            </span>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                textAlign: 'center',
                color: theme.color.accent,
              }}
            >
              Uploading…
            </span>
          </>
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
                background:
                  showUploadAffordance ? theme.color.accentBg : theme.color.bg,
                color: showUploadAffordance ? theme.color.accent : theme.color.inkMuted,
              }}
            >
              {showUploadAffordance ? (
                <Upload size={20} aria-hidden />
              ) : (
                <Camera size={20} aria-hidden />
              )}
            </span>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                textAlign: 'center',
                color: showUploadAffordance ? theme.color.accent : theme.color.inkMuted,
              }}
            >
              {loading
                ? 'Loading…'
                : showUploadAffordance
                  ? 'Upload photo'
                  : 'Not uploaded'}
            </span>
            {uploadState.status === 'error' ? (
              <span
                style={{
                  marginTop: 2,
                  paddingInline: 6,
                  fontSize: theme.type.size.xs,
                  color: theme.color.alert,
                  textAlign: 'center',
                  fontWeight: theme.type.weight.medium,
                  lineHeight: 1.3,
                }}
              >
                {uploadState.message}
              </span>
            ) : null}
          </>
        )}
      </button>
      {showDeleteOverlay ? (
        <button
          type="button"
          onClick={(e) => {
            // The tile button below this overlay otherwise catches
            // the click and opens the lightbox. Stop it so only the
            // delete path runs.
            e.stopPropagation();
            if (!deleteBusy) onRequestDelete?.();
          }}
          disabled={deleteBusy}
          aria-label={`Delete ${label} photo`}
          title={`Delete ${label} photo`}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            border: 'none',
            // Translucent dark wash so the trash icon stays legible
            // on top of any photo content underneath.
            background: 'rgba(17, 17, 17, 0.55)',
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: deleteBusy ? 'default' : 'pointer',
            padding: 0,
            margin: 0,
            WebkitTapHighlightColor: 'transparent',
            opacity: deleteBusy ? 0.7 : 1,
          }}
        >
          {deleteBusy ? (
            <Loader2
              size={14}
              aria-hidden
              style={{ animation: 'lng-smile-promote-spin 0.9s linear infinite' }}
            />
          ) : (
            <Trash2 size={14} aria-hidden />
          )}
        </button>
      ) : null}
      </div>
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
            existsOnProfile={existsOnProfile}
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
  existsOnProfile,
}: {
  state: PerTilePromoteState;
  disabled: boolean;
  onClick: () => void;
  /** When true, the patient profile already carries a photo for this
   *  slot (from this appointment OR a prior one OR a staff direct
   *  upload). Changes the idle-state label from "Add to profile" to
   *  "Replace existing photo" so the operator sees up-front that the
   *  action will swap an existing canonical photo. The actual replace
   *  guard still lives in the parent (BottomSheet confirmation). */
  existsOnProfile: boolean;
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
          : existsOnProfile
            ? 'Replace existing photo'
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
// TWO predicates over patient_files, returned as a single hook so
// the component does one round-trip:
//
//   • scopedToAppointment — kinds promoted from THIS specific
//     appointment. Drives the per-tile "Added to patients profile"
//     state, so the button text accurately reflects what this
//     booking did (not what some previous booking did).
//
//   • anyOnProfile        — kinds present on the patient profile
//     from ANY source (this appointment, a previous appointment,
//     a staff direct-upload, etc.). Drives the BottomSheet
//     replace-confirmation warning. If the live profile photo for
//     this slot exists, we warn before overwriting — regardless of
//     which appointment put it there.
//
// Without both, the button either lies ("Added" when this booking
// did nothing) or the warning silently skips ("just overwrote the
// previous appointment's smile photo without asking"). Both bugs
// reported by Dylan.
//
// Only the label key + source_appointment_id are fetched — no urls,
// sizes or mime types — so this stays cheaper than the full gallery
// query.
function useExistingSmilePhotoKinds(
  patientId: string | null | undefined,
  appointmentId: string | null | undefined,
): { scopedToAppointment: Set<Kind>; anyOnProfile: Set<Kind> } {
  const [state, setState] = useState<{
    scopedToAppointment: Set<Kind>;
    anyOnProfile: Set<Kind>;
  }>(() => ({ scopedToAppointment: new Set(), anyOnProfile: new Set() }));
  useEffect(() => {
    if (!patientId) {
      setState({ scopedToAppointment: new Set(), anyOnProfile: new Set() });
      return;
    }
    let cancelled = false;
    (async () => {
      // One query returns rows for any-source presence; we partition
      // client-side by source_appointment_id for the scoped set.
      const { data, error } = await supabase
        .from('patient_files')
        .select('source_appointment_id, file_labels:label_id(key)')
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
        setState({ scopedToAppointment: new Set(), anyOnProfile: new Set() });
        return;
      }
      const scopedToAppointment = new Set<Kind>();
      const anyOnProfile = new Set<Kind>();
      const rows = ((data ?? []) as unknown) as Array<{
        source_appointment_id: string | null;
        file_labels: { key?: string } | Array<{ key?: string }> | null;
      }>;
      for (const r of rows) {
        const lbl = Array.isArray(r.file_labels) ? r.file_labels[0] : r.file_labels;
        const k = lbl?.key;
        const kind: Kind | null =
          k === 'smile_photo_front'
            ? 'front'
            : k === 'smile_photo_left'
              ? 'left'
              : k === 'smile_photo_right'
                ? 'right'
                : null;
        if (!kind) continue;
        anyOnProfile.add(kind);
        if (appointmentId && r.source_appointment_id === appointmentId) {
          scopedToAppointment.add(kind);
        }
      }
      setState({ scopedToAppointment, anyOnProfile });
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, appointmentId]);
  return state;
}

// supabase.functions.invoke wraps non-2xx in FunctionsHttpError whose
// .message is the generic "Edge Function returned a non-2xx status
// code". The actual server-side error code lives in the response body
// at error.context (a Response). Read it and return a human string so
// the staff member sees the real reason (service_not_supported,
// unsupported_mime, etc) instead of the gateway boilerplate.
async function readFunctionErrorBody(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (!ctx || typeof (ctx as Response).json !== 'function') return null;
  try {
    const body = (await (ctx as Response).clone().json()) as {
      error?: string;
      detail?: string;
    };
    if (body?.detail) return `${body.error ?? 'upload_failed'}: ${body.detail}`;
    if (body?.error) return body.error;
    return null;
  } catch {
    try {
      const text = await (ctx as Response).clone().text();
      return text ? text.slice(0, 200) : null;
    } catch {
      return null;
    }
  }
}
