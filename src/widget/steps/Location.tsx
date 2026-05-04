import { ChevronRight, Home, MapPin } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import { clearRememberedIdentity, loadRememberedIdentity } from '../state.ts';
import type { WidgetLocation } from '../data.ts';

// Step 1 — Location.
//
// Auto-skipped when there's exactly one location (the default for
// most clinics; the engine in state.ts boots straight onto Service).
// Shown when there are multiple — the patient taps the clinic
// they're booking with.
//
// "Welcome back" line appears when the widget has a remembered
// identity (a previous booking from this device) and offers a
// "Not you?" reset that wipes it and re-renders Step 1 fresh.

export function LocationStep({
  api,
  locations,
}: {
  api: BookingStateApi;
  locations: WidgetLocation[];
}) {
  const remembered = loadRememberedIdentity();
  const greeting =
    remembered?.firstName && remembered?.lastName
      ? `Welcome back, ${remembered.firstName} ${remembered.lastName}.`
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      {greeting ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            flexWrap: 'wrap',
          }}
        >
          <Home size={14} aria-hidden /> {greeting}{' '}
          <button
            type="button"
            onClick={() => {
              clearRememberedIdentity();
              // No state to reset here — the booking state just
              // re-reads loadRememberedIdentity on next mount. For
              // the current session we surface the change by
              // dispatching a re-render via the api hook owner.
              api.setState((prev) => ({
                ...prev,
                details: { ...prev.details, firstName: '', lastName: '', email: '', phoneNumber: '' },
              }));
            }}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              color: theme.color.accent,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            Not you?
          </button>
        </p>
      ) : null}

      {locations.map((loc) => {
        const selected = api.state.location?.id === loc.id;
        return (
          <button
            key={loc.id}
            type="button"
            onClick={() => {
              api.setState((prev) => ({ ...prev, location: loc }));
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
              boxShadow: theme.shadow.card,
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[4],
              transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.md,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                {loc.name}
              </p>
              <p
                style={{
                  margin: `${theme.space[1]}px 0 0`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: theme.space[1],
                }}
              >
                <MapPin size={12} aria-hidden /> {loc.addressLine}
              </p>
            </div>
            <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
          </button>
        );
      })}
    </div>
  );
}
