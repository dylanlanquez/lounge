import { Calendar, Check } from 'lucide-react';
import type { WidgetState } from '../state.ts';
import type { WidgetBrand } from '../Widget.tsx';
import { QUIZ } from '../quizTokens.ts';

// Confirmation screen — shown after a successful submission.
// Lives outside the chrome (replaces the whole shell when booking
// completes). White card on the modal's #f4f4f4 surface, brand logo
// on top, navy check tick, appointment summary lines.

export function SuccessScreen({
  state,
  appointmentRef,
  brand,
}: {
  state: WidgetState;
  appointmentRef: string | null;
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

  return (
    <div
      style={{
        minHeight: '100%',
        height: '100%',
        background: QUIZ.BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
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
          <span dangerouslySetInnerHTML={{ __html: state.service?.label ?? '' }} /> at{' '}
          {state.location?.name}
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
    </div>
  );
}

function formatHourMinute(d: Date): string {
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour === 0 ? 12 : hour <= 12 ? hour : hour - 12;
  return `${display}:${String(minute).padStart(2, '0')} ${period}`;
}
