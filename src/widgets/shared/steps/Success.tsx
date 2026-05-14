import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, Check, CheckCircle2, Copy, Hash, ImageIcon, Loader2, MapPin } from 'lucide-react';
import { formatBookingSuccessTitle, type WidgetState } from '../state.ts';
import type { WidgetBrand } from '../Widget.tsx';
import { QUIZ } from '../quizTokens.ts';
import { env } from '../../../lib/env.ts';

// Confirmation screen — shown after a successful submission.
// Lives outside the chrome (replaces the whole shell when booking
// completes). White card on the modal's #f4f4f4 surface with a
// thin animated accent ring + check (see SuccessGlyph), a centred
// "You're booked in" heading, the service label as a subhead, and a
// divider-separated detail block listing date/time and the clinic
// name + address. Booking reference + confirmation-email line sit
// at the foot.
//
// Click-in veneers bookings ALSO render a PhotoIntakeCard below
// the confirmation block. The patient can upload up to three
// photos (front smile / left / right) so the clinical team can
// pre-assess shade match + arch shape before the visit. Upload
// is fully optional; copy emphasises that the deposit is
// refundable if we determine they're not a suitable candidate.

export function SuccessScreen({
  state,
  appointmentRef,
  appointmentId,
  manageToken,
  brand,
}: {
  state: WidgetState;
  appointmentRef: string | null;
  appointmentId: string | null;
  manageToken: string | null;
  brand?: WidgetBrand;
}) {
  const slot = state.slotIso ? new Date(state.slotIso) : null;
  const dateLabel = slot
    ? slot.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;
  const timeLabel = slot ? formatHourMinute(slot) : null;
  const accent = brand?.accent ?? QUIZ.ACCENT;
  const showPhotoIntake =
    state.service?.serviceType === 'click_in_veneers' &&
    !!appointmentId &&
    !!manageToken;
  const locationName = state.location?.name?.trim() || null;
  const locationAddress = state.location?.addressLine?.trim() || null;

  // Top-aligned scrollable column. The previous layout used
  // `alignItems: flex-start` + `margin: 'auto 0'` on the inner card
  // which tried to vertically-center via flex auto-margins; when the
  // content grew (photo intake card visible) the auto margins +
  // scroll container interacted badly and clipped the bottom of the
  // card. Plain top-aligned scrolling is predictable on every host
  // (standalone /book route + Shopify embed modal + iOS Safari).
  return (
    <div
      className="vlounge-scroll"
      style={{
        height: '100%',
        background: QUIZ.BG,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div
        style={{
          maxWidth: showPhotoIntake ? 620 : 480,
          width: '100%',
          margin: '0 auto',
          padding: '32px 20px 40px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            background: QUIZ.SURFACE,
            border: `1px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            padding: '32px 28px 28px',
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        >
          <SuccessGlyph accent={accent} />

          <h2
            style={{
              margin: '20px 0 0',
              fontSize: 24,
              fontWeight: 700,
              color: QUIZ.INK,
              letterSpacing: '-0.015em',
              textAlign: 'center',
              lineHeight: 1.2,
            }}
          >
            You're booked in
          </h2>

          {state.service ? (
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 15,
                color: QUIZ.MUTED_2,
                textAlign: 'center',
                lineHeight: 1.45,
              }}
            >
              {formatBookingSuccessTitle(state)}
            </p>
          ) : null}

          <div
            style={{
              marginTop: 24,
              padding: '16px 0 4px',
              borderTop: `1px solid ${QUIZ.BORDER_SOFT}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            {dateLabel || timeLabel ? (
              <DetailRow
                icon={<Calendar size={16} strokeWidth={1.75} aria-hidden />}
                primary={dateLabel ?? ''}
                secondary={timeLabel ?? undefined}
              />
            ) : null}
            {locationName ? (
              <DetailRow
                icon={<MapPin size={16} strokeWidth={1.75} aria-hidden />}
                primary={locationName}
                secondary={locationAddress ?? undefined}
              />
            ) : null}
          </div>

          {appointmentRef ? (
            <div
              style={{
                marginTop: 24,
                paddingTop: 20,
                paddingBottom: 24,
                borderTop: `1px solid ${QUIZ.BORDER_SOFT}`,
                borderBottom: `1px solid ${QUIZ.BORDER_SOFT}`,
              }}
            >
              <BookingReferenceRow value={appointmentRef} accent={accent} />
            </div>
          ) : null}

          <p
            style={{
              margin: '24px 0 0',
              fontSize: 13.5,
              color: QUIZ.MUTED_2,
              lineHeight: 1.5,
              textAlign: 'center',
            }}
          >
            Confirmation sent to{' '}
            <strong style={{ color: QUIZ.INK, fontWeight: 600 }}>
              {state.details.email || 'your inbox'}
            </strong>
            . We'll send a reminder a day before.
          </p>
        </div>

        {showPhotoIntake ? (
          <PhotoIntakeCard
            appointmentId={appointmentId!}
            manageToken={manageToken!}
            accent={accent}
          />
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Visual primitives
// ─────────────────────────────────────────────────────────────────

// Animated success glyph — thin accent ring + drawn-in check.
// Stroke-dashoffset draws each path from a hidden state to its full
// length; the ring fires first, the tick follows after a 0.4s delay
// so the eye reads ring → check rather than both at once. Total
// motion ~0.85s. Replaces the previous heavy filled navy circle.
function SuccessGlyph({ accent }: { accent: string }) {
  const SIZE = 64;
  const RING_DASH = 188; // 2π × 30 (radius)
  const TICK_DASH = 42;
  return (
    <div
      style={{
        width: SIZE,
        height: SIZE,
        margin: '0 auto',
        position: 'relative',
      }}
      aria-hidden
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox="0 0 64 64"
        fill="none"
        style={{ display: 'block', transform: 'rotate(-90deg)' }}
      >
        <circle
          cx="32"
          cy="32"
          r="30"
          stroke={accent}
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
          style={{
            strokeDasharray: RING_DASH,
            strokeDashoffset: RING_DASH,
            animation: `vlounge-success-ring 0.55s ${QUIZ.EASE_CARD} forwards`,
          }}
        />
        <path
          d="M20 32 L28.5 40.5 L44 25"
          stroke={accent}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          // The parent svg is rotated -90deg so the ring draws from
          // the top; counter-rotate the tick so it reads upright.
          style={{
            transform: 'rotate(90deg)',
            transformOrigin: '32px 32px',
            strokeDasharray: TICK_DASH,
            strokeDashoffset: TICK_DASH,
            animation: `vlounge-success-tick 0.35s ${QUIZ.EASE_CARD} 0.4s forwards`,
          }}
        />
      </svg>
    </div>
  );
}

// Booking-reference row — shares the leading icon column with the
// DetailRow above (Hash glyph in the same 20px column the Calendar
// and MapPin icons sit in) so the row aligns visually with the
// date and location entries. The value + copy state are wrapped in
// a brand-accent-tinted bordered pill that the customer reads as
// "tappable to copy"; tap flips it to "Copied" for ~2.2s.
function BookingReferenceRow({
  value,
  accent,
}: {
  value: string;
  accent: string;
}) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older Safari / WebViews — same textarea+execCommand
      // fallback the staff-app MeetingLinkCard uses.
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        // ignore — last-resort; the value is still visible on
        // screen for the patient to read off manually.
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: QUIZ.MUTED_2,
        }}
      >
        <Hash size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <button
        type="button"
        onClick={handleCopy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={copied ? 'Booking reference copied' : 'Copy booking reference'}
        style={{
          appearance: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          background: hovered
            ? hexWithAlpha(accent, 0.1)
            : hexWithAlpha(accent, 0.06),
          border: `1px solid ${hexWithAlpha(accent, hovered ? 0.28 : 0.14)}`,
          borderRadius: 10,
          padding: '8px 12px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'background 0.15s ease, border-color 0.15s ease',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: 14,
            color: accent,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </span>
        <span
          aria-hidden
          style={{
            width: 1,
            height: 14,
            background: hexWithAlpha(accent, 0.18),
            flexShrink: 0,
          }}
        />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            fontWeight: 600,
            color: accent,
            flexShrink: 0,
            transition: 'color 0.15s ease',
          }}
        >
          {copied ? (
            <>
              <CheckCircle2 size={13} aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy size={13} aria-hidden /> Copy
            </>
          )}
        </span>
      </button>
    </div>
  );
}

// Convert a hex colour (#RRGGBB or #RGB) to an rgba() string with
// the supplied alpha. Used by BookingReferenceRow so the brand
// accent tints the tile background + border without baking per-
// brand rgba constants into QUIZ. Returns the original hex
// unchanged on parse failure — defensive, since accent values
// arrive from per-brand bundles.
function hexWithAlpha(hex: string, alpha: number): string {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function DetailRow({
  icon,
  primary,
  secondary,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: QUIZ.MUTED_2,
          paddingTop: 2,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          fontSize: 14,
          lineHeight: 1.4,
          minWidth: 0,
        }}
      >
        <span style={{ color: QUIZ.INK, fontWeight: 500 }}>{primary}</span>
        {secondary ? (
          <span style={{ color: QUIZ.MUTED_2, fontSize: 13 }}>{secondary}</span>
        ) : null}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Photo intake — click-in veneers only
// ─────────────────────────────────────────────────────────────────

type PhotoKind = 'front' | 'left' | 'right';

const PHOTO_KINDS: Array<{
  kind: PhotoKind;
  label: string;
  helper: string;
}> = [
  {
    kind: 'front',
    label: 'Front smile',
    helper: 'Looking straight at the camera, full smile',
  },
  {
    kind: 'left',
    label: 'Left side',
    helper: 'Turn slightly left, smiling',
  },
  {
    kind: 'right',
    label: 'Right side',
    helper: 'Turn slightly right, smiling',
  },
];

function PhotoIntakeCard({
  appointmentId,
  manageToken,
  accent,
}: {
  appointmentId: string;
  manageToken: string;
  accent: string;
}) {
  // Lift the per-tile done state up so the Submit button at the
  // bottom can disable itself when nothing is uploaded yet. Each
  // PhotoSlot reports its own kind into/out of the doneKinds set
  // via the onDoneChange callback below.
  const [doneKinds, setDoneKinds] = useState<Set<PhotoKind>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  // useCallback so PhotoSlot's onDoneChange effect dep doesn't fire
  // every render. Children call it on transitions; an unstable
  // identity would loop forever.
  const handleDoneChange = useCallback((kind: PhotoKind, done: boolean) => {
    setDoneKinds((prev) => {
      const next = new Set(prev);
      if (done) next.add(kind);
      else next.delete(kind);
      return next;
    });
  }, []);
  const uploadedCount = doneKinds.size;
  const canSubmit = uploadedCount > 0 && !submitted;

  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `2px solid ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 28,
        animation: `vlounge-fadeInUp 0.35s ${QUIZ.EASE_BOUNCE} backwards`,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 18,
          fontWeight: 700,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
        }}
      >
        Send us your smile photos
      </h3>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 14,
          color: QUIZ.MUTED_2,
          lineHeight: 1.5,
        }}
      >
        Optional but highly recommended. These let our clinical team check
        shade match and arch shape before you come in, so the visit goes as
        smoothly as possible.
      </p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 13,
          color: QUIZ.MUTED_2,
          lineHeight: 1.5,
        }}
      >
        If we look at your photos and decide click-in veneers aren't the right
        fit for you, your deposit is refunded in full, no questions.
      </p>

      {/* Grid → 3 columns on desktop, smooth horizontal-snap row on
          ≤520px. Class + media query live in quizTokens.ts so the
          breakpoint sits next to the other widget breakpoints. */}
      <div className="vlounge-photo-grid" style={{ marginTop: 20 }}>
        {PHOTO_KINDS.map((p) => (
          <PhotoSlot
            key={p.kind}
            kind={p.kind}
            label={p.label}
            helper={p.helper}
            appointmentId={appointmentId}
            manageToken={manageToken}
            accent={accent}
            onDoneChange={handleDoneChange}
          />
        ))}
      </div>

      {/* Submit affordance — photos auto-upload to storage as the
          patient picks them, so the backend has them either way.
          This button gives the patient a clear "I'm done" moment
          and surfaces a confirmation state so they don't sit
          wondering whether the team got them. Disabled until at
          least one tile has uploaded. */}
      <div
        style={{
          marginTop: 24,
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (!canSubmit) return;
            setSubmitted(true);
          }}
          disabled={!canSubmit}
          style={{
            appearance: 'none',
            border: 'none',
            padding: '12px 22px',
            borderRadius: QUIZ.R_PILL,
            background: submitted
              ? 'rgba(34, 139, 34, 0.10)'
              : canSubmit
                ? accent
                : 'rgba(0, 0, 0, 0.06)',
            color: submitted
              ? '#2F7D32'
              : canSubmit
                ? '#fff'
                : QUIZ.SUBTLE,
            cursor: canSubmit ? 'pointer' : 'default',
            fontSize: 14,
            fontWeight: 600,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            transition:
              'background 0.15s ease, color 0.15s ease, transform 0.15s ease',
          }}
          onMouseEnter={(e) => {
            if (!canSubmit) return;
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={(e) => {
            if (!canSubmit) return;
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          {submitted ? (
            <>
              <Check size={14} strokeWidth={2.5} aria-hidden /> Photos sent
            </>
          ) : (
            <>Send photos{uploadedCount > 0 ? ` (${uploadedCount})` : ''}</>
          )}
        </button>
      </div>
    </div>
  );
}

type SlotState =
  | { stage: 'idle' }
  | { stage: 'uploading'; previewUrl: string; fileName: string }
  | { stage: 'done'; previewUrl: string; fileName: string }
  | { stage: 'error'; message: string };

function PhotoSlot({
  kind,
  label,
  helper,
  appointmentId,
  manageToken,
  accent,
  onDoneChange,
}: {
  kind: PhotoKind;
  label: string;
  helper: string;
  appointmentId: string;
  manageToken: string;
  accent: string;
  /** Reports the slot's done-state to PhotoIntakeCard so the Send-
   *  photos button can enable when at least one upload has landed
   *  and disable again if the slot transitions out of done (error,
   *  reset). Called only on transitions, not every render. */
  onDoneChange: (kind: PhotoKind, done: boolean) => void;
}) {
  const [slot, setSlot] = useState<SlotState>({ stage: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Surface done/undone transitions to the parent. We watch the
  // stage rather than calling onDoneChange directly from the upload
  // handler so the contract stays declarative — the parent's
  // doneKinds set always matches what's actually rendered.
  const isDoneStage = slot.stage === 'done';
  useEffect(() => {
    onDoneChange(kind, isDoneStage);
  }, [kind, isDoneStage, onDoneChange]);

  const onFile = async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setSlot({ stage: 'uploading', previewUrl, fileName: file.name });

    const url = `${env.SUPABASE_URL}/functions/v1/widget-upload-intake-photo`;
    const form = new FormData();
    form.append('appointment_id', appointmentId);
    form.append('manage_token', manageToken);
    form.append('kind', kind);
    form.append('file', file);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errCode = (body as { error?: string }).error ?? 'upload_failed';
        throw new Error(messageFor(errCode));
      }
      setSlot({ stage: 'done', previewUrl, fileName: file.name });
    } catch (e) {
      setSlot({
        stage: 'error',
        message: e instanceof Error ? e.message : 'Upload failed. Try again.',
      });
    }
  };

  const isUploading = slot.stage === 'uploading';
  const isDone = slot.stage === 'done';
  const preview =
    (slot.stage === 'uploading' || slot.stage === 'done') ? slot.previewUrl : null;

  // Whole tile is the file-picker affordance — a single <label>
  // wrapping a nested <input type="file"> is enough for native
  // click→picker forwarding. The previous version ALSO set
  // `htmlFor` on the label AND an extra `onClick={openPicker}` on
  // the inner div that called `inputRef.click()`. That stack fired
  // the picker twice in some browsers (first via the label's
  // native forwarding, then via the manual click). Just nesting +
  // no manual onClick gives a single, reliable trigger.
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: isUploading ? 'default' : 'pointer',
      }}
    >
      <div
        style={{
          position: 'relative',
          // Square tiles match the staff-app patient-files grid
          // pattern Dylan called out as the visual reference. On
          // mobile the parent .vlounge-photo-grid switches to a
          // horizontal scroll so the square tile stays generous
          // (~70vw wide) instead of squishing into three columns.
          aspectRatio: '1 / 1',
          borderRadius: 12,
          background: preview ? 'transparent' : QUIZ.SOFT_BG,
          border: `2px ${isDone ? 'solid' : 'dashed'} ${
            isDone ? accent : 'rgba(0, 0, 0, 0.12)'
          }`,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'border-color 0.15s ease',
        }}
        onMouseEnter={(e) => {
          if (isUploading || isDone) return;
          e.currentTarget.style.borderColor = accent;
        }}
        onMouseLeave={(e) => {
          if (isUploading || isDone) return;
          e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.12)';
        }}
      >
        {/* File input lives INSIDE the photo tile pinned to its
            top-left corner, not at the bottom of the label. When
            the click fires the input, the browser's scroll-into-
            view behaviour on the focused element would otherwise
            scroll the modal so the input (at the end of the label
            flow) sits at the bottom of the viewport, which cropped
            the rest of the photo grid below the fold. Pinning the
            input to top:0/left:0 of the tile means any auto-scroll
            brings the TOP of the tile into view, keeping the rest
            of the grid below it on screen. */}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          disabled={isUploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
            // Reset so picking the same file again still fires onChange.
            if (inputRef.current) inputRef.current.value = '';
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
        {preview ? (
          <img
            src={preview}
            alt={`${label} preview`}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              color: QUIZ.MUTED_2,
            }}
          >
            <ImageIcon size={28} strokeWidth={1.6} aria-hidden />
            <span style={{ fontSize: 12 }}>Tap to upload</span>
          </div>
        )}
        {isUploading ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(255, 255, 255, 0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: accent,
            }}
          >
            <Loader2
              size={28}
              style={{ animation: 'vlounge-spin 1s linear infinite' }}
              aria-label="Uploading"
            />
            <style>{`@keyframes vlounge-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : null}
        {isDone ? (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              background: accent,
              color: '#fff',
              width: 24,
              height: 24,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
            }}
          >
            <Check size={14} strokeWidth={3} aria-hidden />
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: QUIZ.INK,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {label}
          {isDone ? (
            <Check size={12} strokeWidth={3} style={{ color: accent }} aria-hidden />
          ) : null}
        </span>
        <span style={{ fontSize: 12, color: QUIZ.MUTED_2, lineHeight: 1.35 }}>
          {slot.stage === 'error' ? (
            <span style={{ color: QUIZ.ALERT }}>{slot.message}</span>
          ) : isDone ? (
            <span>Uploaded. Tap to replace.</span>
          ) : (
            helper
          )}
        </span>
      </div>
    </label>
  );
}

function messageFor(code: string): string {
  switch (code) {
    case 'unsupported_mime':
      return "We can't read that file type. Try a JPG or PNG.";
    case 'invalid_size':
      return 'Photo is too large. Max 12 MB.';
    case 'service_not_supported':
      return 'Photo uploads are only available for click-in veneers.';
    case 'token_mismatch':
      return "We couldn't verify this booking. Refresh and try again.";
    case 'appointment_cancelled':
      return "This booking has been cancelled — photos can't be uploaded.";
    default:
      return 'Upload failed. Please try again.';
  }
}

function formatHourMinute(d: Date): string {
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour === 0 ? 12 : hour <= 12 ? hour : hour - 12;
  return `${display}:${String(minute).padStart(2, '0')} ${period}`;
}
