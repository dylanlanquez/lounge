import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calendar, Check, MapPin, PoundSterling, X } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { cancelBooking, useManagedBooking, type ManagedBooking } from './manage.ts';

// Customer self-serve manage page — /widget/manage?token=<uuid>.
//
// Shipped with the booking confirmation email; the patient taps
// the "Manage your booking" link, lands here, sees only their
// booking, and can cancel. NO internal app chrome (the existing
// /widget/* path family already excludes the bottom nav and the
// kiosk status bar disappears for unauth'd users — see
// components/BottomNav.tsx and KioskStatusBar.tsx).
//
// Information shown is the safe shape only — service, location,
// time, status, deposit, first-name greeting. The lookup RPC
// (lng_widget_lookup_booking, SECURITY DEFINER) never returns
// email, phone, notes, staff assignments, or any other patient's
// data, even if the calling client is malicious.

export function Manage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const lookup = useManagedBooking(token);

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        color: theme.color.ink,
        fontFamily: theme.type.family,
      }}
    >
      <Header />

      <main
        style={{
          maxWidth: 560,
          margin: '0 auto',
          padding: `${theme.space[5]}px ${theme.space[5]}px ${theme.space[8]}px`,
        }}
      >
        {lookup.loading ? <BodyMessage>Loading your booking…</BodyMessage> : null}

        {lookup.notFound ? (
          <BodyMessage tone="alert">
            We couldn't find that booking. The link might have expired or be incorrect — check
            your most recent confirmation email and try again, or contact the clinic.
          </BodyMessage>
        ) : null}

        {lookup.error ? (
          <BodyMessage tone="alert">
            Something went wrong loading this booking. Please refresh and try again.
          </BodyMessage>
        ) : null}

        {lookup.data ? (
          <BookingPanel booking={lookup.data} token={token!} onChanged={lookup.refresh} />
        ) : null}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — minimal, not the booking-flow header
// ─────────────────────────────────────────────────────────────────────────────

function Header() {
  return (
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
          Manage your booking
        </h1>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking panel — summary + actions
// ─────────────────────────────────────────────────────────────────────────────

function BookingPanel({
  booking,
  token,
  onChanged,
}: {
  booking: ManagedBooking;
  token: string;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCancelled, setJustCancelled] = useState(false);

  const onCancel = async () => {
    setError(null);
    setCancelling(true);
    try {
      await cancelBooking(token);
      setJustCancelled(true);
      // Re-pull the booking so any subsequent reload renders the
      // cancelled state without stale data.
      onChanged();
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'cancel_failed';
      setError(messageForCancelCode(code));
    } finally {
      setCancelling(false);
      setConfirming(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      {booking.patientFirstName ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            color: theme.color.ink,
          }}
        >
          {justCancelled
            ? `Your booking has been cancelled, ${booking.patientFirstName}.`
            : `Hi ${booking.patientFirstName},`}
        </p>
      ) : null}

      <div
        style={{
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[5],
          boxShadow: theme.shadow.card,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        <StatusBadge status={booking.status} />

        <div>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {booking.serviceLabel}
          </p>
          {booking.appointmentRef ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.semibold,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              Booking reference {booking.appointmentRef}
            </p>
          ) : null}
        </div>

        <Row icon={<Calendar size={14} />} primary={formatSlotLong(booking.startAt)} />
        <Row
          icon={<MapPin size={14} />}
          primary={booking.locationName}
          secondary={booking.locationAddress || undefined}
        />
        {booking.depositStatus === 'paid' && booking.depositPence ? (
          <Row
            icon={<PoundSterling size={14} />}
            primary={`Deposit paid: ${formatPrice(booking.depositPence, booking.depositCurrency)}`}
            secondary="Refunds are handled by the clinic per their cancellation policy."
          />
        ) : null}
      </div>

      {booking.cancellable && !justCancelled ? (
        <CancelControls
          confirming={confirming}
          cancelling={cancelling}
          error={error}
          onAsk={() => setConfirming(true)}
          onConfirm={onCancel}
          onAbort={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : null}

      {!booking.cancellable && booking.status === 'booked' ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Cancellations close once the appointment time has passed. If you need to amend
          this booking, please call the clinic.
        </p>
      ) : null}

      {justCancelled || booking.status === 'cancelled' ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          A cancellation note has been sent to your inbox. You can close this page.
        </p>
      ) : null}
    </div>
  );
}

function CancelControls({
  confirming,
  cancelling,
  error,
  onAsk,
  onConfirm,
  onAbort,
}: {
  confirming: boolean;
  cancelling: boolean;
  error: string | null;
  onAsk: () => void;
  onConfirm: () => void;
  onAbort: () => void;
}) {
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={onAsk}
        style={{
          appearance: 'none',
          height: 48,
          border: `1px solid ${theme.color.alert}`,
          background: 'transparent',
          color: theme.color.alert,
          borderRadius: theme.radius.pill,
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          cursor: 'pointer',
        }}
      >
        Cancel this booking
      </button>
    );
  }

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.alert}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        Cancel this booking?
      </p>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        Your slot will be released and we'll email a confirmation. Refunds for any deposit
        paid are handled by the clinic.
      </p>
      {error ? (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.alert,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: theme.space[3] }}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={cancelling}
          style={{
            appearance: 'none',
            flex: 1,
            height: 48,
            border: 'none',
            background: theme.color.alert,
            color: theme.color.surface,
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            cursor: cancelling ? 'default' : 'pointer',
            opacity: cancelling ? 0.5 : 1,
          }}
        >
          {cancelling ? 'Cancelling…' : 'Yes, cancel'}
        </button>
        <button
          type="button"
          onClick={onAbort}
          disabled={cancelling}
          style={{
            appearance: 'none',
            flex: 1,
            height: 48,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            cursor: cancelling ? 'default' : 'pointer',
            opacity: cancelling ? 0.5 : 1,
          }}
        >
          Keep booking
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const visual = useMemo(() => {
    switch (status) {
      case 'cancelled':
        return { label: 'Cancelled', bg: 'rgba(184, 58, 42, 0.08)', fg: theme.color.alert, icon: <X size={12} aria-hidden /> };
      case 'arrived':
      case 'in_progress':
        return { label: 'In progress', bg: theme.color.accentBg, fg: theme.color.accent, icon: <Check size={12} aria-hidden /> };
      case 'complete':
        return { label: 'Completed', bg: theme.color.bg, fg: theme.color.inkMuted, icon: <Check size={12} aria-hidden /> };
      case 'no_show':
        return { label: 'Missed', bg: theme.color.bg, fg: theme.color.inkMuted, icon: null };
      case 'rescheduled':
        return { label: 'Rescheduled', bg: theme.color.bg, fg: theme.color.inkMuted, icon: null };
      case 'booked':
      default:
        return { label: 'Confirmed', bg: theme.color.accentBg, fg: theme.color.accent, icon: <Check size={12} aria-hidden /> };
    }
  }, [status]);
  return (
    <span
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        padding: `4px ${theme.space[3]}px`,
        background: visual.bg,
        color: visual.fg,
        fontSize: 11,
        fontWeight: theme.type.weight.semibold,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
        borderRadius: theme.radius.pill,
      }}
    >
      {visual.icon}
      {visual.label}
    </span>
  );
}

function Row({
  icon,
  primary,
  secondary,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: theme.radius.pill,
          background: theme.color.bg,
          color: theme.color.inkMuted,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {primary}
        </p>
        {secondary ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            {secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BodyMessage({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'alert';
}) {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${tone === 'alert' ? theme.color.alert : theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
        textAlign: 'center',
        color: tone === 'alert' ? theme.color.alert : theme.color.inkMuted,
        fontSize: theme.type.size.sm,
        fontWeight: tone === 'alert' ? theme.type.weight.semibold : theme.type.weight.regular,
        lineHeight: theme.type.leading.snug,
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatSlotLong(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour <= 12 ? hour : hour - 12;
  return `${day}, ${display}:${String(minute).padStart(2, '0')} ${period}`;
}

function formatPrice(pence: number, currency: string | null): string {
  const symbol = (currency ?? 'GBP').toUpperCase() === 'GBP' ? '£' : '';
  if (pence === 0) return 'Free';
  if (pence % 100 === 0) return `${symbol}${pence / 100}`;
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

function messageForCancelCode(code: string): string {
  switch (code) {
    case 'token_not_found':
      return 'This booking link is no longer valid.';
    case 'too_late_to_cancel':
      return "It's too close to the appointment to cancel online — please call the clinic.";
    case 'not_cancellable':
      return "This booking can't be cancelled from here. Please contact the clinic.";
    case 'invalid_token':
      return 'The booking link is invalid.';
    default:
      return "We couldn't cancel the booking. Please refresh and try again.";
  }
}
