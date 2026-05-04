import { ChevronRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { ALL_BOOKING_TYPES, formatPrice, type BookingStateApi } from '../state.ts';

// Step 2 — Service / Appointment Type.
//
// Lists every public-visible booking type as a card. Description
// reads like the practice wrote it for the patient (it lives in
// data.ts and will move to lng_booking_type_config.widget_description
// in phase 2). Price renders right-aligned. Tapping a card sets the
// service in state, which can shorten or lengthen the rest of the
// flow (Dentist + Payment steps switch on / off based on the chosen
// service's flags).

export function ServiceStep({ api }: { api: BookingStateApi }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {ALL_BOOKING_TYPES.map((bt) => {
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
              gridTemplateColumns: '1fr auto auto',
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
            <span
              style={{
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: theme.type.tracking.tight,
                whiteSpace: 'nowrap',
              }}
            >
              {formatPrice(bt.pricePence)}
            </span>
            <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
          </button>
        );
      })}
    </div>
  );
}
