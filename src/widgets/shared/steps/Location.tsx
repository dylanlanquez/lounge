import { Home } from 'lucide-react';
import type { BookingStateApi } from '../state.ts';
import { clearRememberedIdentity, loadRememberedIdentity } from '../state.ts';
import type { WidgetLocation } from '../data.ts';
import { QUIZ } from '../quizTokens.ts';
import {
  OptionCard,
  OptionDescription,
  OptionGrid,
  OptionTitle,
} from '../OptionCard.tsx';

// Location step — auto-skipped when there's exactly one location.
// Shown when multiple — the patient taps the clinic.
//
// "Welcome back" line appears when the widget has a remembered
// identity (a previous booking from this device) and offers a
// "Not you?" reset.
//
// Selection updates state only — the footer Next button is the sole
// navigation control (no auto-advance).

export function LocationStep({
  api,
  locations,
  accent = QUIZ.ACCENT,
}: {
  api: BookingStateApi;
  locations: WidgetLocation[];
  accent?: string;
}) {
  const remembered = loadRememberedIdentity();
  const greeting =
    remembered?.firstName && remembered?.lastName
      ? `Welcome back, ${remembered.firstName} ${remembered.lastName}.`
      : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {greeting ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: QUIZ.MUTED_2,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            justifyContent: 'center',
            textAlign: 'center',
          }}
        >
          <Home size={14} aria-hidden /> {greeting}{' '}
          <button
            type="button"
            onClick={() => {
              clearRememberedIdentity();
              api.setState((prev) => ({
                ...prev,
                details: {
                  ...prev.details,
                  firstName: '',
                  lastName: '',
                  email: '',
                  phoneNumber: '',
                },
              }));
            }}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 14,
              color: accent,
              fontWeight: 600,
            }}
          >
            Not you?
          </button>
        </p>
      ) : null}

      <OptionGrid>
        {locations.map((loc) => {
          const selected = api.state.location?.id === loc.id;
          return (
            <OptionCard
              key={loc.id}
              selected={selected}
              anySelected={!!api.state.location}
              onSelect={() =>
                api.setState((prev) => ({ ...prev, location: loc }))
              }
              accent={accent}
              ariaLabel={loc.name}
            >
              <OptionTitle>{loc.name}</OptionTitle>
              <OptionDescription>{loc.addressLine}</OptionDescription>
            </OptionCard>
          );
        })}
      </OptionGrid>
    </div>
  );
}
