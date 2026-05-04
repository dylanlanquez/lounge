import { Calendar, ChevronRight, MapPin, Plus } from 'lucide-react';
import { theme } from '../theme/index.ts';
import type { RememberedBooking } from './rememberedBookings.ts';

// Welcome screen shown ahead of the booking step engine when the
// patient already has upcoming bookings on this device. Two paths:
//
//   • Manage an existing booking — deep-links to /widget/manage
//     with that booking's token. Same surface the email link
//     would land on.
//
//   • Book another appointment — drops into the normal step
//     engine.
//
// "On this device" is intentional: the patient's localStorage
// remembers tokens across browser sessions, but a fresh device or
// cleared storage won't see the panel. That's fine — the
// confirmation email's manage link is the canonical path back.

export function WelcomeBack({
  bookings,
  onStartNew,
  greetingName,
}: {
  bookings: RememberedBooking[];
  onStartNew: () => void;
  greetingName: string | null;
}) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        color: theme.color.ink,
        fontFamily: theme.type.family,
      }}
    >
      <header
        style={{
          background: theme.color.bg,
          borderBottom: `1px solid ${theme.color.border}`,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            margin: '0 auto',
            padding: `${theme.space[4]}px ${theme.space[5]}px`,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            {greetingName ? `Welcome back, ${greetingName}` : 'Welcome back'}
          </h1>
        </div>
      </header>

      <main
        style={{
          maxWidth: 560,
          margin: '0 auto',
          padding: `${theme.space[5]}px ${theme.space[5]}px ${theme.space[8]}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[5],
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              marginBottom: theme.space[2],
            }}
          >
            {bookings.length === 1 ? 'Your upcoming booking' : 'Your upcoming bookings'}
          </p>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
            }}
          >
            {bookings.map((b) => (
              <li key={b.token}>
                <BookingTile booking={b} />
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          onClick={onStartNew}
          style={{
            appearance: 'none',
            background: theme.color.surface,
            border: `1px dashed ${theme.color.border}`,
            borderRadius: theme.radius.card,
            padding: `${theme.space[5]}px ${theme.space[5]}px`,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            cursor: 'pointer',
            fontFamily: 'inherit',
            color: theme.color.ink,
            textAlign: 'left',
            transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = theme.color.ink;
            e.currentTarget.style.borderStyle = 'solid';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = theme.color.border;
            e.currentTarget.style.borderStyle = 'dashed';
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: theme.radius.pill,
              background: theme.color.bg,
              color: theme.color.inkMuted,
              flexShrink: 0,
            }}
          >
            <Plus size={16} />
          </span>
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
              Book another appointment
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              Pick a service and a time.
            </p>
          </div>
          <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
        </button>
      </main>
    </div>
  );
}

function BookingTile({ booking }: { booking: RememberedBooking }) {
  // The Manage page lives at /widget/manage?token=. We don't use
  // an `<a>` to avoid a full navigation that loses any session
  // state — but for the welcome screen we WANT a fresh manage
  // surface, so a hard link is fine here. Same-tab so the patient
  // can use the back button to return to this screen.
  const href = `/widget/manage?token=${encodeURIComponent(booking.token)}`;
  return (
    <a
      href={href}
      style={{
        textDecoration: 'none',
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        boxShadow: theme.shadow.card,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        color: theme.color.ink,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = theme.color.ink;
      }}
      onMouseLeave={(e) => {
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
          {booking.serviceLabel}
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
          <Calendar size={12} aria-hidden />
          {formatSlotLong(booking.startAt)}
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
          <MapPin size={12} aria-hidden />
          {booking.locationName}
        </p>
      </div>
      <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
    </a>
  );
}

function formatSlotLong(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' });
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour <= 12 ? hour : hour - 12;
  return `${day}, ${display}:${String(minute).padStart(2, '0')} ${period}`;
}
