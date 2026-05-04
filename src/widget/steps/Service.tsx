import { ChevronRight, Phone } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { formatPrice, type BookingStateApi } from '../state.ts';
import { useWidgetBookingTypes } from '../data.ts';

// Step 2 — Service / Appointment Type.
//
// Lists every widget-visible booking type as a card. Reads live from
// the public.lng_widget_booking_types view (admins control which
// services show by toggling widget_visible per row in
// lng_booking_type_config). Price + deposit render right-aligned;
// description reads like the practice wrote it for the patient
// (lives in widget_description on the same row).
//
// Tapping a card sets the service in state, which can shorten or
// lengthen the rest of the flow — Dentist and Payment steps switch
// on / off based on the chosen service's flags.

export function ServiceStep({ api }: { api: BookingStateApi }) {
  const { data, loading, error } = useWidgetBookingTypes();

  if (loading) {
    return <ServiceSkeleton />;
  }
  if (error) {
    return <ServiceError message={error} />;
  }
  if (!data || data.length === 0) {
    return <ServiceEmpty />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {data.map((bt) => {
        const selected = api.state.service?.id === bt.id;
        return (
          <button
            key={bt.id}
            type="button"
            onClick={() => {
              api.setService(bt);
              api.goNext();
            }}
            style={{
              appearance: 'none',
              textAlign: 'left',
              fontFamily: 'inherit',
              cursor: 'pointer',
              padding: `${theme.space[4]}px ${theme.space[5]}px`,
              borderRadius: theme.radius.card,
              background: theme.color.surface,
              border: `1px solid ${selected ? theme.color.accent : theme.color.border}`,
              boxShadow: selected ? theme.shadow.card : 'none',
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              alignItems: 'center',
              gap: theme.space[4],
              transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
            onMouseEnter={(e) => {
              if (selected) return;
              e.currentTarget.style.borderColor = theme.color.ink;
            }}
            onMouseLeave={(e) => {
              if (selected) return;
              e.currentTarget.style.borderColor = theme.color.border;
            }}
          >
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.md,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                {/* dangerouslySetInnerHTML so the data.ts entries can
                    use HTML entities like &amp; without leaking. */}
                <span dangerouslySetInnerHTML={{ __html: bt.label }} />
              </p>
              <p
                style={{
                  margin: `${theme.space[1]}px 0 0`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  lineHeight: theme.type.leading.snug,
                }}
              >
                <span dangerouslySetInnerHTML={{ __html: bt.description }} />
              </p>
              {bt.depositPence > 0 ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    fontSize: theme.type.size.xs,
                    color: theme.color.accent,
                    fontWeight: theme.type.weight.semibold,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatPrice(bt.depositPence)} deposit secures the slot
                </p>
              ) : null}
            </div>
            <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / empty / error states
// ─────────────────────────────────────────────────────────────────────────────

function ServiceSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 96,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.card,
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  );
}

function ServiceEmpty() {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px dashed ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[6],
        textAlign: 'center',
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
          background: theme.color.bg,
          color: theme.color.inkMuted,
          marginBottom: theme.space[3],
        }}
      >
        <Phone size={20} aria-hidden />
      </span>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        Online booking is paused right now
      </p>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
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
        background: theme.color.surface,
        border: `1px solid ${theme.color.alert}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.alert,
        }}
      >
        Something went wrong loading our services
      </p>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
        }}
      >
        Refresh the page, or call us if it sticks. ({message})
      </p>
    </div>
  );
}
