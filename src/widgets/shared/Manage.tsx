import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Calendar, Check, MapPin, PoundSterling, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  cancelBooking,
  rescheduleBooking,
  useManagedBooking,
  type ManagedBooking,
} from './manage.ts';
import { formatCustomerServiceTitleLabel } from '../../lib/queries/appointments.ts';
import {
  forgetBookingToken,
  replaceBookingToken,
} from './rememberedBookings.ts';
import { SlotPicker } from './SlotPicker.tsx';

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

type View =
  | { kind: 'summary' }
  | { kind: 'reschedule' }
  | { kind: 'rescheduled'; newRef: string | null; newStartAt: string };

export function Manage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const lookup = useManagedBooking(token);
  const [view, setView] = useState<View>({ kind: 'summary' });

  // The "back to summary" affordance from inside the reschedule
  // view should land back on the booking card. We don't refresh
  // the lookup on back — only on a successful reschedule, which
  // re-binds to the new manage_token via setView({ kind: 'rescheduled' }).
  const wider = view.kind === 'reschedule';

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        color: theme.color.ink,
        fontFamily: theme.type.family,
      }}
    >
      <Header
        title={view.kind === 'reschedule' ? 'Pick a new time' : 'Manage your booking'}
        onBack={view.kind === 'reschedule' ? () => setView({ kind: 'summary' }) : undefined}
        wider={wider}
      />

      <main
        style={{
          maxWidth: wider ? 880 : 560,
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

        {lookup.data && view.kind === 'summary' ? (
          <BookingPanel
            booking={lookup.data}
            token={token!}
            onChanged={lookup.refresh}
            onAskReschedule={() => setView({ kind: 'reschedule' })}
          />
        ) : null}

        {lookup.data && view.kind === 'reschedule' ? (
          <ReschedulePanel
            booking={lookup.data}
            token={token!}
            onCancel={() => setView({ kind: 'summary' })}
            onSuccess={(res) =>
              setView({
                kind: 'rescheduled',
                newRef: res.newAppointmentRef,
                newStartAt: res.newStartAt,
              })
            }
          />
        ) : null}

        {lookup.data && view.kind === 'rescheduled' ? (
          <RescheduledPanel
            booking={lookup.data}
            newRef={view.newRef}
            newStartAt={view.newStartAt}
          />
        ) : null}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — minimal, not the booking-flow header
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  title,
  onBack,
  wider,
}: {
  title: string;
  onBack?: () => void;
  wider: boolean;
}) {
  return (
    <header
      style={{
        background: theme.color.bg,
        borderBottom: `1px solid ${theme.color.border}`,
      }}
    >
      <div
        style={{
          maxWidth: wider ? 880 : 560,
          margin: '0 auto',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
        }}
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              width: 36,
              height: 36,
              borderRadius: theme.radius.pill,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.color.ink,
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = theme.color.surface;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <ArrowLeft size={18} aria-hidden />
          </button>
        ) : null}
        <h1
          aria-live="polite"
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            flex: 1,
            minWidth: 0,
          }}
        >
          {title}
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
  onAskReschedule,
}: {
  booking: ManagedBooking;
  token: string;
  onChanged: () => void;
  onAskReschedule: () => void;
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
      // Drop the token from localStorage — a future visit's
      // welcome screen shouldn't list a cancelled booking.
      forgetBookingToken(token);
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
            {formatCustomerServiceTitleLabel({
              service_type: booking.serviceType,
              event_type_label: booking.eventTypeLabel,
              arch: booking.arch,
              product_key: booking.productKey,
            })}
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
        {/* Payment summary row. "Paid in full at booking" wins
            over the deposit copy when the patient picked the
            full-balance option, because the deposit_pence value
            on those rows is set to the full price (it's literally
            the amount charged) and rendering it as "Deposit
            paid · £249.00" would mislead the patient into
            thinking they still owe a balance in clinic. */}
        {booking.paidInFullAtBooking && booking.depositPence ? (
          <Row
            icon={<PoundSterling size={14} />}
            primary={`Paid in full at booking · ${formatPrice(booking.depositPence, booking.depositCurrency)}`}
            secondary="No balance to settle in clinic. Refunds handled per the clinic's cancellation policy."
          />
        ) : booking.depositStatus === 'paid' && booking.depositPence ? (
          <Row
            icon={<PoundSterling size={14} />}
            primary={`Deposit paid · ${formatPrice(booking.depositPence, booking.depositCurrency)}`}
            secondary="The remaining balance is settled in clinic. Refunds handled per the clinic's cancellation policy."
          />
        ) : null}
      </div>

      {/* Denture-repair table — per-arch summary of the lines the
          patient ticked at booking time, with prices right-aligned.
          Renders only when there ARE repair items (a same-day
          appliance booking with no repairs won't have any). */}
      {booking.repairItems.length > 0 ? (
        <RepairItemsCard items={booking.repairItems} />
      ) : null}

      {/* Upgrades table — selected add-ons captured at booking.
          Renders independently of the repair table so a same-day
          appliance booking with upgrades (e.g. scalloped retainers)
          shows them too. */}
      {booking.upgrades.length > 0 ? (
        <UpgradesCard upgrades={booking.upgrades} />
      ) : null}

      {booking.cancellable && !justCancelled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <button
            type="button"
            onClick={onAskReschedule}
            style={{
              appearance: 'none',
              height: 48,
              border: 'none',
              background: theme.color.ink,
              color: theme.color.surface,
              borderRadius: theme.radius.pill,
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              cursor: 'pointer',
            }}
          >
            Reschedule
          </button>
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
        </div>
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
// Reschedule panel — slot picker + confirm
// ─────────────────────────────────────────────────────────────────────────────

function ReschedulePanel({
  booking,
  token,
  onCancel,
  onSuccess,
}: {
  booking: ManagedBooking;
  token: string;
  onCancel: () => void;
  onSuccess: (res: { newAppointmentRef: string | null; newStartAt: string }) => void;
}) {
  const [pickedIso, setPickedIso] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Patient already booked this once. We keep the existing
  // duration as-is rather than re-resolving via the booking-type
  // resolver — the new slot is the same length as the old.
  const durationMinutes = useMemo(() => {
    if (!booking.startAt || !booking.endAt) return 30;
    const ms = new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime();
    return Math.max(15, Math.round(ms / 60_000));
  }, [booking.startAt, booking.endAt]);

  const onConfirm = async () => {
    if (!pickedIso) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await rescheduleBooking(token, pickedIso);
      // Swap the old token for the new one in localStorage so a
      // future visit's welcome screen lists the rescheduled
      // booking, not the now-stale parent row.
      replaceBookingToken(token, res.newManageToken);
      onSuccess({ newAppointmentRef: res.newAppointmentRef, newStartAt: pickedIso });
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'reschedule_failed';
      setError(messageForRescheduleCode(code));
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        Currently booked for{' '}
        <strong style={{ color: theme.color.ink }}>{formatSlotLong(booking.startAt)}</strong>.
        Pick a new time below.
      </p>

      <SlotPicker
        locationId={booking.locationId}
        serviceType={booking.serviceType}
        durationMinutes={durationMinutes}
        repairVariant={booking.repairVariant}
        productKey={booking.productKey}
        arch={booking.arch}
        selectedIso={pickedIso}
        onPick={(iso) => setPickedIso(iso)}
        showFirstAvailableBanner={false}
        excludeAppointmentId={booking.id || null}
      />

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

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: theme.color.bg,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingTop: theme.space[3],
          display: 'flex',
          gap: theme.space[3],
          borderTop: `1px solid ${theme.color.border}`,
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
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
            cursor: submitting ? 'default' : 'pointer',
            opacity: submitting ? 0.5 : 1,
          }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting || !pickedIso}
          style={{
            appearance: 'none',
            flex: 2,
            height: 48,
            border: 'none',
            background: theme.color.ink,
            color: theme.color.surface,
            borderRadius: theme.radius.pill,
            fontFamily: 'inherit',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            cursor: submitting || !pickedIso ? 'default' : 'pointer',
            opacity: submitting || !pickedIso ? 0.5 : 1,
          }}
        >
          {submitting
            ? 'Rescheduling…'
            : pickedIso
              ? `Confirm ${formatSlotShort(pickedIso)}`
              : 'Pick a slot to continue'}
        </button>
      </div>
    </div>
  );
}

function RescheduledPanel({
  booking,
  newRef,
  newStartAt,
}: {
  booking: ManagedBooking;
  newRef: string | null;
  newStartAt: string;
}) {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[6],
        boxShadow: theme.shadow.card,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: theme.color.accent,
          color: theme.color.surface,
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
          fontSize: theme.type.size.xl,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        You're rescheduled
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          color: theme.color.ink,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {formatCustomerServiceTitleLabel({
          service_type: booking.serviceType,
          event_type_label: booking.eventTypeLabel,
          arch: booking.arch,
          product_key: booking.productKey,
        })}{' '}at {booking.locationName}
      </p>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <Calendar size={14} aria-hidden />
        {formatSlotLong(newStartAt)}
      </p>
      {newRef ? (
        <p
          style={{
            margin: `${theme.space[3]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          New booking reference {newRef}
        </p>
      ) : null}
      <p
        style={{
          margin: `${theme.space[4]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.snug,
        }}
      >
        Your calendar invite has been updated. A fresh confirmation email is on its way.
      </p>
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
  // Single-line rows centre the icon vertically against the text
  // so the calendar / pound / etc. glyph sits exactly on the
  // text's midline. Two-line rows (location with address)
  // explicitly align the icon to the FIRST text line so it
  // doesn't drift down between the two lines — same pattern
  // Linear / Notion use on multi-line list items.
  const hasSecondary = !!secondary;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: hasSecondary ? 'flex-start' : 'center',
        gap: theme.space[3],
      }}
    >
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
          // Multi-line rows: the icon needs to anchor to the
          // first text line, not the visual middle of both lines.
          // A negative offset pulls it up to line up with the
          // ~18px line-height of the primary text.
          marginTop: hasSecondary ? -1 : 0,
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

// Per-arch denture-repair table. Same visual register as the booking
// card above — white surface, soft border, soft shadow — with a
// section heading per arch ("Your Upper Denture" / "Your Lower
// Denture" / "Your Upper and Lower Dentures") and one row per repair
// line with the price right-aligned. Mirrors the table the patient
// sees in the customer-facing widget Review card so the manage page
// reads as a faithful continuation of the booking flow.
function RepairItemsCard({ items }: { items: ManagedBooking['repairItems'] }) {
  const byArch = new Map<'upper' | 'lower' | 'both', ManagedBooking['repairItems']>();
  for (const r of items) {
    const list = byArch.get(r.arch) ?? [];
    list.push(r);
    byArch.set(r.arch, list);
  }
  const archOrder: Array<'upper' | 'lower' | 'both'> = ['upper', 'lower', 'both'];
  const archHeading: Record<'upper' | 'lower' | 'both', string> = {
    upper: 'Your Upper Denture',
    lower: 'Your Lower Denture',
    both: 'Your Upper and Lower Dentures',
  };
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
      }}
    >
      {archOrder.map((arch) => {
        const rows = byArch.get(arch);
        if (!rows || rows.length === 0) return null;
        return (
          <div key={arch}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
                marginBottom: theme.space[2],
              }}
            >
              {archHeading[arch]}
            </p>
            <table
              role="presentation"
              cellSpacing={0}
              cellPadding={0}
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                borderBottom: `1px solid ${theme.color.border}`,
              }}
            >
              <tbody>
                {rows.map((r, idx) => {
                  const qtySuffix =
                    r.unitLabel === 'per tooth' && r.quantity > 1
                      ? ` × ${r.quantity} teeth`
                      : '';
                  return (
                    <tr key={`${arch}-${idx}`}>
                      <td
                        style={{
                          padding: '12px 0',
                          borderTop: `1px solid ${theme.color.border}`,
                          fontSize: theme.type.size.sm,
                          color: theme.color.ink,
                        }}
                      >
                        {customerRepairLabel(r.name)}
                        {qtySuffix}
                      </td>
                      <td
                        style={{
                          padding: '12px 0',
                          borderTop: `1px solid ${theme.color.border}`,
                          fontSize: theme.type.size.sm,
                          color: theme.color.ink,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatPrice(r.linePricePence, 'GBP')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// Add-on upgrades table. Same chrome as the repair-items card so the
// two read as a coordinated pair under the booking summary. Renders
// independently — a same-day appliance booking with upgrades (e.g.
// scalloped retainers) shows this card even when there are no
// repair items.
function UpgradesCard({ upgrades }: { upgrades: ManagedBooking['upgrades'] }) {
  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
          marginBottom: theme.space[2],
        }}
      >
        Upgrades
      </p>
      <table
        role="presentation"
        cellSpacing={0}
        cellPadding={0}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          borderBottom: `1px solid ${theme.color.border}`,
        }}
      >
        <tbody>
          {upgrades.map((u, idx) => (
            <tr key={`${u.name}-${idx}`}>
              <td
                style={{
                  padding: '12px 0',
                  borderTop: `1px solid ${theme.color.border}`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.ink,
                }}
              >
                {u.name}
              </td>
              <td
                style={{
                  padding: '12px 0',
                  borderTop: `1px solid ${theme.color.border}`,
                  fontSize: theme.type.size.sm,
                  color: theme.color.ink,
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatPrice(u.pricePence, 'GBP')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Strip the redundant "denture" word from a Calendly repair-line
// answer so the customer-facing column reads cleanly under the
// "Your Lower Denture" heading. "Snapped Denture" → "Snapped",
// "Broken Tooth" → "Broken tooth" (first-letter cap only).
// Mirrors the helper in src/widgets/shared/state.ts —
// duplicated locally so Manage.tsx doesn't need to import state.ts
// (which would pull the entire booking-state machine into the
// manage bundle for one tiny string transform).
function customerRepairLabel(name: string): string {
  let out = name.trim();
  out = out.replace(/\s+(?:to\s+)?denture\b\.?$/i, '').trim();
  out = out.replace(/\bdenture\s+/i, '').trim();
  if (out.length > 0) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out.length > 0 ? out : name;
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

function formatSlotShort(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const display = hour <= 12 ? hour : hour - 12;
  return `${day}, ${display}:${String(minute).padStart(2, '0')} ${period}`;
}

function messageForRescheduleCode(code: string): string {
  switch (code) {
    case 'token_not_found':
      return 'This booking link is no longer valid.';
    case 'too_late_to_reschedule':
      return "It's too close to the appointment to reschedule online — please call the clinic.";
    case 'not_reschedulable':
      return "This booking can't be rescheduled from here. Please contact the clinic.";
    case 'calendly_source_not_supported':
      return 'This booking was made through a different system. Please contact the clinic to amend.';
    case 'slot_unavailable':
      return 'That slot was just taken — pick another time.';
    case 'invalid_token':
      return 'The booking link is invalid.';
    default:
      return "We couldn't reschedule the booking. Please refresh and try again.";
  }
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
