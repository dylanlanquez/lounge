import { Phone } from 'lucide-react';
import { formatPrice, type BookingStateApi } from '../state.ts';
import { useWidgetBookingTypes } from '../data.ts';
import { QUIZ } from '../quizTokens.ts';
import {
  OptionCard,
  OptionDescription,
  OptionGrid,
  OptionMeta,
  OptionTitle,
} from '../OptionCard.tsx';

// Service step — every widget-visible booking type as an option
// card. Reads live from public.lng_widget_booking_types.
//
// Selection updates state only; the footer Next button is the sole
// navigation control. Matches the retainer-cart quiz flow.

export function ServiceStep({
  api,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  accent?: string;
}) {
  const { data, loading, error } = useWidgetBookingTypes();

  if (loading) return <ServiceSkeleton />;
  if (error) return <ServiceError message={error} />;
  if (!data || data.length === 0) return <ServiceEmpty />;

  return (
    <div style={{ marginTop: 32 }}>
      <OptionGrid>
        {data.map((bt) => {
          const selected = api.state.service?.id === bt.id;
          return (
            <OptionCard
              key={bt.id}
              selected={selected}
              anySelected={!!api.state.service}
              onSelect={() => api.setService(bt)}
              accent={accent}
              ariaLabel={bt.label.replace(/<[^>]*>/g, '')}
            >
              <OptionTitle>
                <span dangerouslySetInnerHTML={{ __html: bt.label }} />
              </OptionTitle>
              <OptionDescription>
                <span dangerouslySetInnerHTML={{ __html: bt.description }} />
              </OptionDescription>
              {bt.depositPence > 0 ? (
                <OptionMeta>
                  {formatPrice(bt.depositPence)} deposit secures the slot
                </OptionMeta>
              ) : null}
            </OptionCard>
          );
        })}
      </OptionGrid>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / empty / error states
// ─────────────────────────────────────────────────────────────────────────────

function ServiceSkeleton() {
  return (
    <OptionGrid>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            width: '100%',
            maxWidth: '27rem',
            height: 130,
            background: QUIZ.SURFACE,
            border: `1px solid ${QUIZ.BORDER}`,
            borderRadius: QUIZ.R_CARD,
            opacity: 0.6,
            animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
          }}
        />
      ))}
    </OptionGrid>
  );
}

function ServiceEmpty() {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px dashed ${QUIZ.BORDER}`,
        borderRadius: QUIZ.R_CARD,
        padding: 32,
        textAlign: 'center',
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: QUIZ.BG,
          color: QUIZ.MUTED_2,
          marginBottom: 12,
        }}
      >
        <Phone size={20} aria-hidden />
      </span>
      <p
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
        }}
      >
        Online booking is paused right now
      </p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 14,
          color: QUIZ.MUTED_2,
          lineHeight: 1.5,
        }}
      >
        Give us a call and we'll find you a time. Sorry for the hop.
      </p>
    </div>
  );
}

function ServiceError({ message }: { message: string }) {
  return (
    <div
      style={{
        background: QUIZ.SURFACE,
        border: `1px solid ${QUIZ.ALERT}`,
        borderRadius: QUIZ.R_CARD,
        padding: 20,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 600,
          color: QUIZ.ALERT,
        }}
      >
        Something went wrong loading our services
      </p>
      <p
        style={{
          margin: '8px 0 0',
          fontSize: 14,
          color: QUIZ.MUTED_2,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </p>
    </div>
  );
}
