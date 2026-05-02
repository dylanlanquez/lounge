import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  CircleSlash,
  CreditCard,
  Mail,
  MapPin,
  Pencil,
  RotateCcw,
  StickyNote,
  User as UserIcon,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  AppointmentTimeline,
  Avatar,
  BottomSheet,
  Breadcrumb,
  Button,
  Card,
  Dialog,
  EmptyState,
  RescheduleSheet,
  EditBookingSheet,
  Skeleton,
  StatusPill,
  type StatusTone,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { logFailure } from '../lib/failureLog.ts';
import {
  patientFullDisplayName,
  properCase,
} from '../lib/queries/appointments.ts';
import type { AppointmentStatus } from '../components/AppointmentCard/AppointmentCard.tsx';
import { humaniseEventTypeLabel } from '../lib/queries/patientProfile.ts';
import { formatPence } from '../lib/queries/carts.ts';
import { markNoShow, NO_SHOW_REASONS, reverseNoShow } from '../lib/queries/visits.ts';
import { cancelAppointment, reverseCancellation } from '../lib/queries/cancelAppointment.ts';
import { sendAppointmentConfirmation } from '../lib/queries/sendAppointmentConfirmation.ts';
import {
  availableActions,
  useAppointmentDetail,
  type AppointmentAction,
  type AppointmentDetailRow,
} from '../lib/queries/appointmentDetail.ts';
import { humaniseLedgerSource } from '../lib/queries/ledger.ts';

// AppointmentDetail — full-page surface for appointments that don't
// have a visit yet (Booked future, Cancelled, No-show, Rescheduled).
// When a visit DOES exist we redirect to /visit/:id immediately so
// the receptionist never sees two pages claiming to represent the
// same booking.
//
// Visual chrome mirrors VisitDetail: kiosk-bar padding, breadcrumb
// across the top, hero card with avatar + identity + status pill,
// stacked info cards for booking facts, then a quick-actions list.
//
// Action gating runs through availableActions() so the rules are
// audited in one place — see appointmentDetail.test.ts.

interface EntryState {
  // Where the receptionist came from. Drives the breadcrumb shape.
  // Falls back to the Ledger trail when missing — direct URL pastes
  // and tab restorations land somewhere sensible instead of
  // shimmering forever.
  from?: 'ledger' | 'patient' | 'schedule';
  patientId?: string;
  patientName?: string;
}

export function AppointmentDetail() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const isMobile = useIsMobile(640);
  const { result, refresh } = useAppointmentDetail(params.id);

  const entry = (location.state as EntryState | null) ?? {};

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const outerPaddingX = isMobile ? theme.space[4] : theme.space[6];
  const innerMaxWidth = theme.layout.pageMaxWidth;

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: `0 ${outerPaddingX}px`,
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px) + ${theme.space[5]}px)`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: innerMaxWidth, margin: '0 auto' }}>
        <Breadcrumbs entry={entry} appt={result.data} />
        {result.state === 'loading' ? (
          <SkeletonView />
        ) : result.state === 'not_found' ? (
          <NotFound onBack={() => navigate('/ledger')} />
        ) : result.state === 'error' ? (
          <ErrorPanel message={result.error} onRetry={refresh} />
        ) : result.data.visit ? (
          // Visit exists — defer to VisitDetail so we never render two
          // surfaces for the same booking.
          <Navigate
            to={`/visit/${result.data.visit.id}`}
            replace
            state={{
              from: entry.from === 'ledger' ? 'ledger' : 'schedule',
              patientId: result.data.patient_id,
              patientName: patientFullDisplayName({
                patient_first_name: result.data.patient.first_name,
                patient_last_name: result.data.patient.last_name,
              } as never),
              visitOpenedAt: result.data.visit.opened_at,
            }}
          />
        ) : (
          <Loaded appt={result.data} onChanged={refresh} />
        )}
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumbs — same shape contract as VisitDetail's. Two paths:
//   • from Ledger: "Ledger › Patient name › Appt 9 May"
//   • from anywhere else (direct URL paste, refresh): default to the
//     Ledger trail since this surface has no other natural origin.
// ─────────────────────────────────────────────────────────────────────────────

function Breadcrumbs({
  entry,
  appt,
}: {
  entry: EntryState;
  appt: AppointmentDetailRow | null;
}) {
  const navigate = useNavigate();
  const liveName = appt
    ? patientFullDisplayName({
        patient_first_name: appt.patient.first_name,
        patient_last_name: appt.patient.last_name,
      } as never)
    : '';
  const previewName = entry.patientName?.trim() ?? '';
  const nameLabel: ReactNode = liveName || previewName || <NameSkeleton />;
  // Two crumb shapes for the appt cell:
  //   includeName=true  → "Sarah's Appt. 9 May"   used when there's
  //                       no separate patient crumb, so the trail
  //                       still reads who it belongs to.
  //   includeName=false → "Appt. 9 May"           used when a name
  //                       crumb already sits to its left.
  const apptCrumbInline = (includeName: boolean): ReactNode =>
    appt ? (
      formatApptCrumb(appt.start_at, includeName ? liveName || previewName : null)
    ) : (
      <DateSkeleton />
    );

  const items = (() => {
    const baseLedger = { label: 'Ledger', onClick: () => navigate('/ledger') };
    if (entry.from === 'patient' && entry.patientId) {
      // Patients › Sarah › Appt. 9 May — the name has its own crumb
      // so the visit crumb stays compact.
      return [
        { label: 'Patients', onClick: () => navigate('/patients') },
        {
          label: nameLabel,
          onClick: () =>
            navigate(`/patient/${entry.patientId}`, {
              state: { patientName: liveName },
            }),
        },
        { label: apptCrumbInline(false) },
      ];
    }
    if (entry.from === 'schedule') {
      // Schedule › Sarah's Appt. 9 May — name baked into the visit
      // crumb, since Schedule rows already show patient + service +
      // date before the click.
      return [
        { label: 'Schedule', onClick: () => navigate('/schedule') },
        { label: apptCrumbInline(true) },
      ];
    }
    // Default + 'ledger' branch: same shape as Schedule. Ledger rows
    // already surface the patient name + service + date inline, so
    // a separate name crumb between Ledger and the visit crumb is
    // clutter — and clicking the patient profile mid-trail wasn't a
    // path the user actually wanted.
    return [baseLedger, { label: apptCrumbInline(true) }];
  })();

  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb items={items} />
    </div>
  );
}

function formatApptCrumb(iso: string, name: string | null): string {
  const d = new Date(iso);
  const date = Number.isNaN(d.getTime())
    ? 'Appt.'
    : `Appt. ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  const trimmed = name?.trim();
  if (trimmed) return `${trimmed}'s ${date}`;
  return date;
}

function NameSkeleton() {
  return <Skeleton width={96} height={14} radius={4} />;
}
function DateSkeleton() {
  return <Skeleton width={84} height={14} radius={4} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaded body — hero + info sections + actions.
// ─────────────────────────────────────────────────────────────────────────────

function Loaded({
  appt,
  onChanged,
}: {
  appt: AppointmentDetailRow;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reversingCancellation, setReversingCancellation] = useState(false);
  const [reversingNoShow, setReversingNoShow] = useState(false);
  const [confirmNoShowOpen, setConfirmNoShowOpen] = useState(false);
  const [confirmReverseCancelOpen, setConfirmReverseCancelOpen] = useState(false);
  const [confirmReverseNoShowOpen, setConfirmReverseNoShowOpen] = useState(false);
  const [resending, setResending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fullName = patientFullDisplayName({
    patient_first_name: appt.patient.first_name,
    patient_last_name: appt.patient.last_name,
  } as never);
  const tone = STATUS_TONE[appt.status];
  const actions = useMemo(
    () =>
      availableActions({
        status: appt.status,
        source: appt.source,
        hasPatientEmail: !!appt.patient.email,
        hasVisit: !!appt.visit,
        hasRescheduleTarget: !!appt.reschedule_to_id,
      }),
    [
      appt.status,
      appt.source,
      appt.patient.email,
      appt.visit,
      appt.reschedule_to_id,
    ],
  );

  // "Mark patient as arrived" hands off to the four-step arrival
  // wizard at /arrival/appointment/:id. The wizard is responsible
  // for intake answers, waiver capture, JB assignment, then it
  // creates the visit and bounces to /visit/:id at the end. Marking
  // arrived from this surface MUST go through that flow — short-
  // circuiting straight to a visit row would skip the intake / waiver
  // capture every booked appointment requires before chair time.
  const handleArrived = () => {
    navigate(`/arrival/appointment/${appt.id}`);
  };

  const handleResendConfirmation = async () => {
    if (resending) return;
    setActionError(null);
    setResending(true);
    try {
      const result = await sendAppointmentConfirmation({ appointmentId: appt.id });
      if (!result.ok) {
        setActionError(result.reason ?? result.error ?? 'Could not send confirmation');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not send confirmation';
      await logFailure({
        source: 'AppointmentDetail.resendConfirmation',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setActionError(message);
    } finally {
      setResending(false);
    }
  };

  const handleReverseCancellation = async () => {
    if (reversingCancellation) return;
    setActionError(null);
    setReversingCancellation(true);
    try {
      await reverseCancellation({ appointmentId: appt.id });
      setConfirmReverseCancelOpen(false);
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not reverse cancellation';
      await logFailure({
        source: 'AppointmentDetail.reverseCancellation',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setActionError(message);
    } finally {
      setReversingCancellation(false);
    }
  };

  const handleReverseNoShow = async () => {
    if (reversingNoShow) return;
    setActionError(null);
    setReversingNoShow(true);
    try {
      await reverseNoShow(appt.id);
      setConfirmReverseNoShowOpen(false);
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not reverse no-show';
      await logFailure({
        source: 'AppointmentDetail.reverseNoShow',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setActionError(message);
    } finally {
      setReversingNoShow(false);
    }
  };

  return (
    <>
      <Hero appt={appt} fullName={fullName} tone={tone} />

      <section
        style={{
          display: 'grid',
          gap: theme.space[3],
          gridTemplateColumns: 'minmax(0, 1fr)',
          marginTop: theme.space[5],
        }}
      >
        <BookingFactsCard appt={appt} />
        {appt.intake && appt.intake.length > 0 ? <IntakeCard intake={appt.intake} /> : null}
        {appt.deposit_pence != null && appt.deposit_pence > 0 ? <DepositCard appt={appt} /> : null}
        {appt.notes?.trim() ? <NotesCard notes={appt.notes} /> : null}
        {appt.status === 'cancelled' && appt.cancel_reason ? (
          <ReasonCard
            tone="cancelled"
            label="Cancellation reason"
            text={appt.cancel_reason}
          />
        ) : null}
        {appt.status === 'no_show' && appt.cancel_reason ? (
          <ReasonCard
            tone="no_show"
            label="No-show reason"
            text={humaniseNoShowReason(appt.cancel_reason)}
          />
        ) : null}
        {appt.status === 'rescheduled' && appt.reschedule_to_id ? (
          <RescheduledTo apptId={appt.reschedule_to_id} />
        ) : null}
      </section>

      {actionError ? (
        <div
          role="alert"
          style={{
            marginTop: theme.space[4],
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            background: '#FFF1F1',
            border: `1px solid #F5C2C2`,
            color: theme.color.alert,
            fontSize: theme.type.size.sm,
          }}
        >
          <AlertTriangle size={14} aria-hidden style={{ marginRight: theme.space[2], verticalAlign: 'middle' }} />
          {actionError}
        </div>
      ) : null}

      <Actions
        appt={appt}
        actions={actions}
        resending={resending}
        onPatientProfile={() =>
          navigate(`/patient/${appt.patient_id}`, {
            state: { from: 'ledger', patientName: fullName },
          })
        }
        onMarkArrived={handleArrived}
        onMarkNoShow={() => setConfirmNoShowOpen(true)}
        onEdit={() => setEditing(true)}
        onReschedule={() => setRescheduling(true)}
        onCancel={() => setCancelling(true)}
        onResendConfirmation={handleResendConfirmation}
        onReverseCancellation={() => setConfirmReverseCancelOpen(true)}
        onReverseNoShow={() => setConfirmReverseNoShowOpen(true)}
        onViewRescheduledTo={() =>
          appt.reschedule_to_id ? navigate(`/appointment/${appt.reschedule_to_id}`) : undefined
        }
      />

      <section style={{ marginTop: theme.space[5] }}>
        <AppointmentTimeline appointmentId={appt.id} />
      </section>

      {editing ? (
        <EditBookingSheet
          open
          appointment={{
            id: appt.id,
            patient_id: appt.patient_id,
            location_id: appt.location_id,
            source: appt.source,
            start_at: appt.start_at,
            end_at: appt.end_at,
            notes: appt.notes,
            staff_account_id: appt.staff_account_id,
            patient_first_name: appt.patient.first_name,
            patient_last_name: appt.patient.last_name,
          }}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}

      {rescheduling ? (
        <RescheduleSheet
          open
          appointment={{
            id: appt.id,
            patient_id: appt.patient_id,
            location_id: appt.location_id,
            // service_type lives on lng_appointments via the conflict-
            // check migration. Fall back to null when not present so
            // RescheduleSheet seeds the picker fresh.
            service_type: null,
            source: appt.source,
            start_at: appt.start_at,
            end_at: appt.end_at,
            patient_first_name: appt.patient.first_name,
            patient_last_name: appt.patient.last_name,
          }}
          onClose={() => setRescheduling(false)}
          onRescheduled={(newId) => {
            setRescheduling(false);
            // Hop to the freshly-created booking so the receptionist
            // sees the new state immediately. The old row is now
            // status=rescheduled with reschedule_to_id pointing here.
            navigate(`/appointment/${newId}`, { replace: true, state: { from: 'ledger' } });
          }}
        />
      ) : null}

      {cancelling ? (
        <CancelDialog
          appt={appt}
          onClose={() => setCancelling(false)}
          onCancelled={() => {
            setCancelling(false);
            onChanged();
          }}
        />
      ) : null}

      {confirmNoShowOpen ? (
        <NoShowSheet
          appt={appt}
          onClose={() => setConfirmNoShowOpen(false)}
          onMarked={() => {
            setConfirmNoShowOpen(false);
            onChanged();
          }}
        />
      ) : null}

      {confirmReverseCancelOpen ? (
        <ConfirmDialog
          title="Reverse this cancellation?"
          description="The booking will return to its scheduled time as if the cancellation never happened. The patient is not notified by default."
          confirmLabel="Reverse cancellation"
          confirming={reversingCancellation}
          onConfirm={handleReverseCancellation}
          onClose={() => setConfirmReverseCancelOpen(false)}
        />
      ) : null}

      {confirmReverseNoShowOpen ? (
        <ConfirmDialog
          title="Reverse this no-show?"
          description="The booking will return to its scheduled state. From there, you can mark the patient as arrived if they came late."
          confirmLabel="Reverse no-show"
          confirming={reversingNoShow}
          onConfirm={handleReverseNoShow}
          onClose={() => setConfirmReverseNoShowOpen(false)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero card — avatar, name, status pill, ref + source line.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<AppointmentStatus, StatusTone> = {
  booked: 'pending',
  arrived: 'arrived',
  in_progress: 'in_progress',
  complete: 'complete',
  no_show: 'no_show',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

function Hero({
  appt,
  fullName,
  tone,
}: {
  appt: AppointmentDetailRow;
  fullName: string;
  tone: StatusTone;
}) {
  const sourceLabel = humaniseLedgerSource(appt.source);
  const refLine = [sourceLabel, appt.appointment_ref ?? null].filter(Boolean).join(' · ');
  return (
    <Card padding="md" elevation="raised">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], minWidth: 0 }}>
        <Avatar name={fullName} src={appt.patient.avatar_data} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], flexWrap: 'wrap' }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {fullName}
            </p>
            <StatusPill tone={tone} size="sm">
              {humaniseAppointmentStatus(appt.status)}
            </StatusPill>
          </div>
          {refLine ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {refLine}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function humaniseAppointmentStatus(status: AppointmentStatus): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
    case 'complete':
      return 'Complete';
    case 'no_show':
      return 'No-show';
    case 'cancelled':
      return 'Cancelled';
    case 'rescheduled':
      return 'Rescheduled';
    default:
      return status;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Info cards — booking facts, intake, deposit, notes, reasons.
// ─────────────────────────────────────────────────────────────────────────────

function BookingFactsCard({ appt }: { appt: AppointmentDetailRow }) {
  const service = humaniseEventTypeLabel(appt.event_type_label) ?? 'Appointment';
  const start = new Date(appt.start_at);
  const end = new Date(appt.end_at);
  const dateLabel = Number.isNaN(start.getTime())
    ? appt.start_at
    : start.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
  const timeLabel =
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
      ? ''
      : `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const locationLine = appt.location?.name
    ? [appt.location.name, appt.location.city].filter(Boolean).join(', ')
    : null;
  const staffLine = appt.staff
    ? [properCase(appt.staff.first_name), properCase(appt.staff.last_name)].filter(Boolean).join(' ').trim()
    : null;

  return (
    <Card padding="md">
      <SectionLabel>Booking</SectionLabel>
      <Row icon={<CalendarCheck size={14} aria-hidden />} label="Service" value={service} />
      <Row
        icon={<CalendarClock size={14} aria-hidden />}
        label="When"
        value={
          <span>
            {dateLabel}
            {timeLabel ? (
              <span style={{ color: theme.color.inkMuted, marginLeft: theme.space[2] }}>{timeLabel}</span>
            ) : null}
          </span>
        }
      />
      {locationLine ? (
        <Row icon={<MapPin size={14} aria-hidden />} label="Location" value={locationLine} />
      ) : null}
      {staffLine ? (
        <Row icon={<UserCheck size={14} aria-hidden />} label="Staff" value={staffLine} />
      ) : null}
      {appt.patient.email ? (
        <Row icon={<Mail size={14} aria-hidden />} label="Email" value={appt.patient.email} />
      ) : null}
    </Card>
  );
}

function IntakeCard({
  intake,
}: {
  intake: ReadonlyArray<{ question: string; answer: string }>;
}) {
  return (
    <Card padding="md">
      <SectionLabel>Intake answers</SectionLabel>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        {intake.map((item, i) => (
          <li key={`${item.question}|${i}`}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              {item.question}
            </p>
            <p
              style={{
                margin: '2px 0 0',
                fontSize: theme.type.size.sm,
                color: theme.color.ink,
                lineHeight: theme.type.leading.relaxed,
                whiteSpace: 'pre-wrap',
              }}
            >
              {item.answer}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DepositCard({ appt }: { appt: AppointmentDetailRow }) {
  if (appt.deposit_pence == null) return null;
  const amount = formatPence(appt.deposit_pence);
  const provider =
    appt.deposit_provider === 'paypal' ? 'PayPal' : appt.deposit_provider === 'stripe' ? 'Stripe' : 'Unknown';
  const status = appt.deposit_status === 'paid' ? 'Paid' : appt.deposit_status === 'failed' ? 'Failed' : 'Unknown';
  const failed = appt.deposit_status === 'failed';
  return (
    <Card padding="md">
      <SectionLabel>Deposit</SectionLabel>
      <Row icon={<CreditCard size={14} aria-hidden />} label="Amount" value={amount} />
      <Row icon={<CreditCard size={14} aria-hidden />} label="Provider" value={provider} />
      <Row
        icon={<CreditCard size={14} aria-hidden />}
        label="Status"
        value={
          <span style={{ color: failed ? theme.color.alert : theme.color.ink, fontWeight: theme.type.weight.semibold }}>
            {status}
          </span>
        }
      />
      {failed ? (
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Deposit attempt failed. Do not credit at checkout. Chase the patient before the slot.
        </p>
      ) : null}
    </Card>
  );
}

function NotesCard({ notes }: { notes: string }) {
  return (
    <Card padding="md">
      <SectionLabel icon={<StickyNote size={14} aria-hidden />}>Notes</SectionLabel>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.relaxed,
          whiteSpace: 'pre-wrap',
        }}
      >
        {notes}
      </p>
    </Card>
  );
}

function ReasonCard({
  tone,
  label,
  text,
}: {
  tone: 'cancelled' | 'no_show';
  label: string;
  text: string;
}) {
  const accent = tone === 'cancelled' ? theme.color.alert : theme.color.warn;
  return (
    <Card padding="md" style={{ borderLeft: `3px solid ${accent}` }}>
      <SectionLabel>{label}</SectionLabel>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.relaxed,
        }}
      >
        {text}
      </p>
    </Card>
  );
}

function humaniseNoShowReason(reason: string): string {
  const match = NO_SHOW_REASONS.find((r) => r.value === reason);
  return match?.label ?? reason;
}

function RescheduledTo({ apptId }: { apptId: string }) {
  const navigate = useNavigate();
  return (
    <Card padding="md">
      <SectionLabel>Rescheduled to</SectionLabel>
      <button
        type="button"
        onClick={() => navigate(`/appointment/${apptId}`)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontWeight: theme.type.weight.semibold,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        Open replacement booking
        <ArrowRight size={14} aria-hidden />
      </button>
    </Card>
  );
}

function SectionLabel({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <p
      style={{
        margin: `0 0 ${theme.space[3]}px`,
        fontSize: 11,
        color: theme.color.inkMuted,
        fontWeight: theme.type.weight.semibold,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
      }}
    >
      {icon}
      {children}
    </p>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 90px) minmax(0, 1fr)',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[2]}px 0`,
        borderTop: `1px solid ${theme.color.border}`,
      }}
    >
      <span style={{ color: theme.color.inkSubtle, display: 'inline-flex' }}>{icon}</span>
      <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}>
        {label}
      </span>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-action list — single source of truth driven by availableActions().
// ─────────────────────────────────────────────────────────────────────────────

function Actions({
  appt,
  actions,
  resending,
  onPatientProfile,
  onMarkArrived,
  onMarkNoShow,
  onEdit,
  onReschedule,
  onCancel,
  onResendConfirmation,
  onReverseCancellation,
  onReverseNoShow,
  onViewRescheduledTo,
}: {
  appt: AppointmentDetailRow;
  actions: AppointmentAction[];
  resending: boolean;
  onPatientProfile: () => void;
  onMarkArrived: () => void;
  onMarkNoShow: () => void;
  onEdit: () => void;
  onReschedule: () => void;
  onCancel: () => void;
  onResendConfirmation: () => void;
  onReverseCancellation: () => void;
  onReverseNoShow: () => void;
  onViewRescheduledTo: () => void;
}) {
  const has = (a: AppointmentAction) => actions.includes(a);
  return (
    <section
      aria-label="Actions"
      style={{
        marginTop: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        overflow: 'hidden',
      }}
    >
      {has('mark_arrived') ? (
        <ActionRow
          first
          icon={<UserCheck size={16} aria-hidden />}
          label="Mark patient as arrived"
          description="Opens the arrival form (intake, waivers, JB assignment)"
          onClick={onMarkArrived}
          accent
        />
      ) : null}
      <ActionRow
        icon={<UserIcon size={16} aria-hidden />}
        label="Patient profile"
        onClick={onPatientProfile}
        first={!has('mark_arrived')}
      />
      {has('mark_no_show') ? (
        <ActionRow
          icon={<CircleSlash size={16} aria-hidden />}
          label="Mark as no-show"
          onClick={onMarkNoShow}
        />
      ) : null}
      {has('edit') ? (
        <ActionRow icon={<Pencil size={16} aria-hidden />} label="Edit appointment" onClick={onEdit} />
      ) : null}
      {has('reschedule') ? (
        <ActionRow icon={<CalendarClock size={16} aria-hidden />} label="Reschedule" onClick={onReschedule} />
      ) : null}
      {has('resend_confirmation') ? (
        <ActionRow
          icon={<Mail size={16} aria-hidden />}
          label={resending ? 'Sending…' : 'Resend confirmation'}
          description={appt.patient.email ?? undefined}
          onClick={resending ? () => undefined : onResendConfirmation}
          disabled={resending}
        />
      ) : null}
      {has('cancel') ? (
        <ActionRow
          icon={<XCircle size={16} aria-hidden />}
          label="Cancel appointment"
          onClick={onCancel}
          danger
        />
      ) : null}
      {has('reverse_cancellation') ? (
        <ActionRow
          icon={<RotateCcw size={16} aria-hidden />}
          label="Reverse cancellation"
          description="Restore the booking to its scheduled time"
          onClick={onReverseCancellation}
        />
      ) : null}
      {has('reverse_no_show') ? (
        <ActionRow
          icon={<RotateCcw size={16} aria-hidden />}
          label="Reverse no-show"
          description="Patient turned up late"
          onClick={onReverseNoShow}
        />
      ) : null}
      {has('view_rescheduled_to') ? (
        <ActionRow
          icon={<CalendarCheck size={16} aria-hidden />}
          label="Open replacement booking"
          onClick={onViewRescheduledTo}
        />
      ) : null}
    </section>
  );
}

function ActionRow({
  icon,
  label,
  description,
  onClick,
  disabled,
  first,
  accent,
  danger,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  onClick: () => void;
  disabled?: boolean;
  first?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const color = danger ? theme.color.alert : accent ? theme.color.accent : theme.color.ink;
  const styles: CSSProperties = {
    appearance: 'none',
    background: hover && !disabled ? theme.color.bg : 'transparent',
    border: 'none',
    borderTop: first ? 'none' : `1px solid ${theme.color.border}`,
    padding: `${theme.space[3]}px ${theme.space[4]}px`,
    display: 'flex',
    alignItems: 'center',
    gap: theme.space[3],
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
    color: theme.color.ink,
    opacity: disabled ? 0.6 : 1,
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    WebkitTapHighlightColor: 'transparent',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={styles}
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
          border: `1px solid ${theme.color.border}`,
          color,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        {description ? (
          <span
            style={{
              display: 'block',
              marginTop: 2,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {description}
          </span>
        ) : null}
      </span>
      <ChevronRight size={16} aria-hidden style={{ color: theme.color.inkSubtle, flexShrink: 0 }} />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel + No-show + Reverse confirmation dialogs
// ─────────────────────────────────────────────────────────────────────────────

function CancelDialog({
  appt,
  onClose,
  onCancelled,
}: {
  appt: AppointmentDetailRow;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await cancelAppointment({ appointmentId: appt.id, reason, notifyPatient: notify });
      onCancelled();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not cancel appointment';
      await logFailure({
        source: 'AppointmentDetail.cancel',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={submitting ? () => undefined : onClose}
      width={460}
      title="Cancel this appointment?"
      description="The booking will be marked as cancelled. The slot becomes free for another patient."
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onClose} disabled={submitting}>
            Keep booking
          </Button>
          <Button variant="primary" onClick={submit} loading={submitting} disabled={submitting}>
            {submitting ? 'Cancelling…' : 'Cancel appointment'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[1],
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            fontFamily: 'inherit',
          }}
        >
          <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.xs }}>
            Reason (optional, surfaces in the timeline)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={submitting}
            style={{
              fontFamily: 'inherit',
              fontSize: theme.type.size.sm,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[3],
              color: theme.color.ink,
              background: theme.color.surface,
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            disabled={submitting || !appt.patient.email}
          />
          <span>
            Email the patient
            {appt.patient.email ? (
              <span style={{ color: theme.color.inkMuted }}> ({appt.patient.email})</span>
            ) : (
              <span style={{ color: theme.color.inkMuted }}> (no email on file)</span>
            )}
          </span>
        </label>
        {error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// Mirrors Schedule's no-show flow: a bottom sheet sliding up with the
// "Why was this a no-show?" copy and four reasons rendered as
// tappable rows. One tap commits — no separate Confirm button. Same
// component shape and behaviour staff already use on Schedule, so
// they don't relearn the gesture coming from the appointment detail.
function NoShowSheet({
  appt,
  onClose,
  onMarked,
}: {
  appt: AppointmentDetailRow;
  onClose: () => void;
  onMarked: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reason: typeof NO_SHOW_REASONS[number]['value']) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await markNoShow(appt.id, reason, {
        patientId: appt.patient_id,
        wasVirtual: !!appt.join_url,
        joinedBeforeNoShow: false,
      });
      onMarked();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not mark no-show';
      await logFailure({
        source: 'AppointmentDetail.markNoShow',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open
      onClose={submitting ? () => undefined : onClose}
      onBack={submitting ? undefined : onClose}
      title="Why was this a no-show?"
      description="Pick the reason. We log it against the appointment so reports show no-show causes."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {NO_SHOW_REASONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={submitting}
            onClick={() => submit(opt.value)}
            style={{
              appearance: 'none',
              width: '100%',
              textAlign: 'left',
              padding: `${theme.space[4]}px ${theme.space[5]}px`,
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
              borderRadius: 14,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.medium,
              color: theme.color.ink,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[3],
              minHeight: theme.layout.minTouchTarget,
              transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
            onMouseEnter={(e) => {
              if (submitting) return;
              (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
            }}
          >
            <span>{opt.label}</span>
            <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
          </button>
        ))}
        {error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirming,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  confirming: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={confirming ? () => undefined : onClose}
      width={460}
      title={title}
      description={description}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onClose} disabled={confirming}>
            Keep current
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={confirming} disabled={confirming}>
            {confirming ? 'Working…' : confirmLabel}
          </Button>
        </div>
      }
    >
      <span />
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading + empty states
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonView() {
  return (
    <>
      <Card padding="md" elevation="raised">
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4] }}>
          <Skeleton width={56} height={56} radius={999} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <Skeleton width="40%" height={20} radius={4} />
            <Skeleton width="60%" height={14} radius={4} />
          </div>
        </div>
      </Card>
      <div style={{ display: 'grid', gap: theme.space[3], marginTop: theme.space[5] }}>
        <Card padding="md">
          <Skeleton width="30%" height={12} radius={4} />
          <div style={{ marginTop: theme.space[3] }}>
            <Skeleton width="100%" height={36} radius={4} />
          </div>
        </Card>
        <Card padding="md">
          <Skeleton width="30%" height={12} radius={4} />
          <div style={{ marginTop: theme.space[3] }}>
            <Skeleton width="100%" height={64} radius={4} />
          </div>
        </Card>
      </div>
    </>
  );
}

function NotFound({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ paddingTop: theme.space[6] }}>
      <EmptyState
        icon={<Ban size={28} aria-hidden />}
        title="Appointment not found"
        description="The booking might have been removed, or you don't have access to view it. Head back to the Ledger to find it again."
        action={
          <Button variant="primary" onClick={onBack}>
            Back to Ledger
          </Button>
        }
      />
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card padding="md" style={{ borderColor: theme.color.alert }}>
      <p style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.alert }}>
        Could not load this appointment
      </p>
      <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
        {message}
      </p>
      <div style={{ marginTop: theme.space[4], display: 'flex', gap: theme.space[2] }}>
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </Card>
  );
}
