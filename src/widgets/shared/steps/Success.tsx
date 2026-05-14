import { useId, useRef, useState } from 'react';
import { Calendar, Check, Upload, ImageIcon, Loader2 } from 'lucide-react';
import type { WidgetState } from '../state.ts';
import type { WidgetBrand } from '../Widget.tsx';
import { QUIZ } from '../quizTokens.ts';
import { env } from '../../../lib/env.ts';

// Confirmation screen — shown after a successful submission.
// Lives outside the chrome (replaces the whole shell when booking
// completes). White card on the modal's #f4f4f4 surface, brand logo
// on top, navy check tick, appointment summary lines.
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
  const slotLabel = slot
    ? slot.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }) +
      ', ' +
      formatHourMinute(slot)
    : '—';
  const accent = brand?.accent ?? QUIZ.ACCENT;
  const showPhotoIntake =
    state.service?.serviceType === 'click_in_veneers' &&
    !!appointmentId &&
    !!manageToken;

  return (
    <div
      style={{
        minHeight: '100%',
        height: '100%',
        background: QUIZ.BG,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: showPhotoIntake ? 640 : 480,
          width: '100%',
          margin: 'auto 0',
        }}
      >
        <div
          style={{
            background: QUIZ.SURFACE,
            border: `2px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            padding: 32,
            textAlign: 'center',
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        >
          {brand ? (
            <img
              src={brand.logoSrc}
              alt={brand.logoAlt}
              style={{
                height: 28,
                width: 'auto',
                display: 'block',
                margin: '0 auto 20px',
              }}
            />
          ) : null}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: accent,
              color: '#fff',
              margin: '0 auto 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Check size={28} strokeWidth={2.5} aria-hidden />
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 700,
              color: QUIZ.INK,
              letterSpacing: '-0.01em',
            }}
          >
            You're booked in
          </h2>
          <p
            style={{
              margin: '12px 0 0',
              fontSize: 16,
              color: QUIZ.INK,
              lineHeight: 1.45,
            }}
          >
            <span
              dangerouslySetInnerHTML={{ __html: state.service?.label ?? '' }}
            />{' '}
            at {state.location?.name}
          </p>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 16,
              color: QUIZ.MUTED_2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Calendar size={14} aria-hidden />
            {slotLabel}
          </p>
          {appointmentRef ? (
            <p
              style={{
                margin: '20px 0 0',
                fontSize: 11,
                color: QUIZ.MUTED_2,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              Booking reference {appointmentRef}
            </p>
          ) : null}
          <p
            style={{
              margin: '24px 0 0',
              fontSize: 14,
              color: QUIZ.MUTED_2,
              lineHeight: 1.45,
            }}
          >
            A confirmation has gone to{' '}
            <strong style={{ color: QUIZ.INK }}>
              {state.details.email || 'your inbox'}
            </strong>{' '}
            with a calendar invite. We'll send a reminder a day before.
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 12,
          marginTop: 20,
        }}
      >
        {PHOTO_KINDS.map((p) => (
          <PhotoSlot
            key={p.kind}
            kind={p.kind}
            label={p.label}
            helper={p.helper}
            appointmentId={appointmentId}
            manageToken={manageToken}
            accent={accent}
          />
        ))}
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
}: {
  kind: PhotoKind;
  label: string;
  helper: string;
  appointmentId: string;
  manageToken: string;
  accent: string;
}) {
  const [slot, setSlot] = useState<SlotState>({ stage: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  const openPicker = () => {
    if (slot.stage === 'uploading') return;
    inputRef.current?.click();
  };

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

  return (
    <label
      htmlFor={inputId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        cursor: isUploading ? 'default' : 'pointer',
      }}
    >
      <div
        onClick={openPicker}
        style={{
          position: 'relative',
          aspectRatio: '4 / 5',
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
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          // Reset so picking the same file again still fires onChange.
          if (inputRef.current) inputRef.current.value = '';
        }}
        style={{
          position: 'absolute',
          opacity: 0,
          pointerEvents: 'none',
          width: 1,
          height: 1,
        }}
      />
      {!isUploading && !isDone ? (
        <button
          type="button"
          onClick={openPicker}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: accent,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
          }}
        >
          <Upload size={13} aria-hidden /> Upload
        </button>
      ) : null}
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
