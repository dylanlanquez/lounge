import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarCheck,
  CalendarClock,
  ChevronRight,
  CircleSlash,
  ClipboardList,
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
  AppointmentHero,
  type AppointmentHeroTone,
  AppointmentTimeline,
  BottomSheet,
  Breadcrumb,
  Button,
  Card,
  Dialog,
  EmptyState,
  RescheduleSheet,
  Skeleton,
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
import {
  formatDateLongOrdinal,
  formatTimeRange,
  relativeDay,
} from '../lib/dateFormat.ts';
import { formatPence } from '../lib/queries/carts.ts';
import { markNoShow, NO_SHOW_REASONS, reverseNoShow } from '../lib/queries/visits.ts';
import { cancelAppointment, reverseCancellation } from '../lib/queries/cancelAppointment.ts';
import { editAppointment } from '../lib/queries/editAppointment.ts';
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
  // YYYY-MM-DD of the day the receptionist was viewing on Schedule
  // when they tapped into this appointment. Used by the breadcrumb
  // back-link so they return to the same day, not today.
  scheduleDate?: string;
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
              // Forward the originating Schedule date so VisitDetail's
              // breadcrumb back-link returns to the same day.
              scheduleDate: entry.scheduleDate,
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
      const scheduleHref = entry.scheduleDate
        ? `/schedule?date=${encodeURIComponent(entry.scheduleDate)}`
        : '/schedule';
      return [
        { label: 'Schedule', onClick: () => navigate(scheduleHref) },
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
        <NotesCard appt={appt} onChanged={onChanged} />
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
            // cancel_reason is either one of the enum strings or the
            // free-text note picked under "Other". humaniseNoShowReason
            // returns the friendly label for known enums; non-enums
            // are returned verbatim by its default branch.
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
          // Forward `from: 'appointment'` so the patient profile's
          // breadcrumb reads "Ledger › <Name>'s Appt N May › <Name>"
          // and clicking the appt crumb returns here. Without this
          // the chain falls back to "Ledger › <Name>" and the page
          // we just came from disappears from the trail.
          navigate(`/patient/${appt.patient_id}`, {
            state: {
              from: 'appointment',
              appointmentId: appt.id,
              appointmentStartAt: appt.start_at,
              patientName: fullName,
            },
          })
        }
        onMarkArrived={handleArrived}
        onMarkNoShow={() => setConfirmNoShowOpen(true)}
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
  const service = humaniseEventTypeLabel(appt.event_type_label) ?? 'Appointment';
  const dateLong = formatDateLongOrdinal(appt.start_at);
  const timeRange = formatTimeRange(appt.start_at, appt.end_at);
  const relative = appt.status === 'booked' ? relativeDay(appt.start_at) : null;

  // Tone routes:
  //   booked-future  → accent (upcoming, lean in)
  //   booked-past    → neutral (overdue but not terminated)
  //   cancelled      → alert
  //   no_show / rescheduled → warn
  //   anything else  → neutral fallback
  const upcoming = appt.status === 'booked' && new Date(appt.start_at).getTime() > Date.now();
  const heroTone: AppointmentHeroTone = upcoming
    ? 'accent'
    : appt.status === 'cancelled'
      ? 'alert'
      : appt.status === 'no_show' || appt.status === 'rescheduled'
        ? 'warn'
        : 'neutral';

  return (
    <AppointmentHero
      patient={{ name: fullName, avatarSrc: appt.patient.avatar_data }}
      pills={[{ tone, label: humaniseAppointmentStatus(appt.status) }]}
      subtitle={refLine}
      when={{
        dateLong,
        timeLine: timeRange,
        relative,
        service,
        tone: heroTone,
      }}
    />
  );
}

// Date helpers live in src/lib/dateFormat.ts so VisitDetail's "When"
// ribbon and this page's hero produce identical strings — one source
// of truth for "Friday 1st May 2026" / "09:00 — 09:45" / relative
// phrasing across both pages.

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
  const locationLine = appt.location?.name
    ? [appt.location.name, appt.location.city].filter(Boolean).join(', ')
    : null;
  const staffLine = appt.staff
    ? [properCase(appt.staff.first_name), properCase(appt.staff.last_name)].filter(Boolean).join(' ').trim()
    : null;

  const hasContent = !!locationLine || !!staffLine || !!appt.patient.email;
  if (!hasContent) return null;

  const rows: Array<{ icon: ReactNode; label: string; value: ReactNode }> = [];
  if (locationLine) {
    rows.push({ icon: <MapPin size={13} aria-hidden />, label: 'Location', value: locationLine });
  }
  if (staffLine) {
    rows.push({ icon: <UserCheck size={13} aria-hidden />, label: 'Staff', value: staffLine });
  }
  if (appt.patient.email) {
    rows.push({ icon: <Mail size={13} aria-hidden />, label: 'Email', value: appt.patient.email });
  }

  return (
    <Card padding="lg">
      <DetailSectionHeader icon={<CalendarCheck size={15} aria-hidden />} title="Booking details" />
      <div>
        {rows.map((r, i) => (
          <KeyValueRow
            key={r.label}
            icon={r.icon}
            label={r.label}
            value={r.value}
            isFirst={i === 0}
          />
        ))}
      </div>
    </Card>
  );
}

function IntakeCard({
  intake,
}: {
  intake: ReadonlyArray<{ question: string; answer: string }>;
}) {
  return (
    <Card padding="lg">
      <DetailSectionHeader icon={<ClipboardList size={15} aria-hidden />} title="Intake answers" />
      <div>
        {intake.map((item, i) => {
          const label = humaniseIntakeQuestion(item.question);
          const value = humaniseIntakeAnswer(label, item.answer);
          return (
            <KeyValueRow
              key={`${item.question}|${i}`}
              label={label}
              value={value}
              isFirst={i === 0}
              wrapValue
              // Intake questions vary from "Arch" to "What product is
              // the impression for". Per-row content sizing keeps the
              // label-to-answer gap tight on every row, instead of
              // every row inheriting the widest label's lane.
              labelMaxWidth="fit"
            />
          );
        })}
      </div>
    </Card>
  );
}

// Calendly intake questions arrive as raw strings exactly as the
// admin typed them in Calendly's question editor. Most are already
// human-readable, so the default is to pass through. The cases below
// rewrite the few questions whose Calendly form-builder phrasing
// reads worse than what staff would naturally say. Keep this small —
// every rewrite is a place where Calendly-side and Lounge-side copy
// can drift.
function humaniseIntakeQuestion(question: string): string {
  const trimmed = question.trim().replace(/[?:]+$/, '');
  if (!trimmed) return '';
  // Common phrasings we shorten so the upper-case label stays
  // scannable. Match case-insensitively; other questions pass through
  // verbatim. Mirror this list in src/lib/queries/visitTimeline.ts and
  // src/lib/queries/appointmentTimeline.ts when adding rewrites — the
  // three surfaces share the same Calendly questions and need
  // identical labels.
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'what is the type of repair you would like done':
    case 'what type of repair would you like done':
    case 'type of repair':
      return 'Repair type';
    case 'contact number':
    case 'phone number':
    case "what's your contact number":
      return 'Contact number';
    case 'what is the name of the dentures':
    case 'what is the brand of the dentures':
      return 'Denture brand';
    case 'where did you buy the dentures':
      return 'Where the dentures were bought';
    case 'how old are the dentures':
      return 'Age of the dentures';
    case 'which arch':
    case 'what arch':
    case 'arch':
    case 'which arch is affected':
      return 'Arch';
    case 'shade':
    case 'tooth shade':
    case 'desired shade':
      return 'Shade';
    default:
      return trimmed;
  }
}

// Same answer-normaliser the timelines use, so colloquial Calendly
// values ("Top" / "Bottom" for arches, "y"/"n" for booleans) read
// consistently across the IntakeCard, the appointment timeline and
// the visit timeline.
function humaniseIntakeAnswer(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (label === 'Arch') {
    switch (lower) {
      case 'top':
      case 'upper':
        return 'Upper';
      case 'bottom':
      case 'lower':
        return 'Lower';
      case 'both':
      case 'both arches':
      case 'top and bottom':
      case 'upper and lower':
        return 'Upper and lower';
      default:
        return trimmed;
    }
  }
  if (lower === 'yes' || lower === 'y' || lower === 'true') return 'Yes';
  if (lower === 'no' || lower === 'n' || lower === 'false') return 'No';
  return trimmed;
}

function DepositCard({ appt }: { appt: AppointmentDetailRow }) {
  if (appt.deposit_pence == null) return null;
  const amount = formatPence(appt.deposit_pence);
  const provider =
    appt.deposit_provider === 'paypal' ? 'PayPal' : appt.deposit_provider === 'stripe' ? 'Stripe' : 'Unknown';
  const paid = appt.deposit_status === 'paid';
  const failed = appt.deposit_status === 'failed';
  const statusLabel = paid ? 'Paid' : failed ? 'Failed' : 'Unknown';
  const statusPill = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        padding: '4px 10px',
        borderRadius: theme.radius.pill,
        background: paid
          ? theme.color.accentBg
          : failed
            ? 'rgba(184, 58, 42, 0.10)'
            : 'rgba(14, 20, 20, 0.05)',
        color: paid ? theme.color.accent : failed ? theme.color.alert : theme.color.inkMuted,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: theme.type.tracking.tight,
      }}
    >
      {statusLabel}
    </span>
  );

  return (
    <Card padding="lg">
      <DetailSectionHeader
        icon={<CreditCard size={15} aria-hidden />}
        title="Deposit"
        trailing={statusPill}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: theme.space[3],
          marginTop: theme.space[1],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 32,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {amount}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          via {provider}
        </span>
      </div>
      {failed ? (
        <div
          style={{
            marginTop: theme.space[4],
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            background: 'rgba(184, 58, 42, 0.08)',
            border: '1px solid rgba(184, 58, 42, 0.18)',
            display: 'flex',
            gap: theme.space[3],
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle
            size={15}
            aria-hidden
            style={{ color: theme.color.alert, flexShrink: 0, marginTop: 2 }}
          />
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              lineHeight: theme.type.leading.relaxed,
            }}
          >
            <span style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
              Deposit attempt failed.
            </span>{' '}
            Do not credit at checkout. Chase the patient before the slot.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// Notes card with inline edit. Replaces the old "Edit appointment"
// action (which was only ever used to change notes anyway). Shows
// the pencil affordance when:
//   • status allows edits (booked / arrived) AND
//   • source isn't Calendly (Calendly is the source of truth for
//     those bookings — editing here would silently diverge).
//
// On click the body swaps to a textarea + Save / Cancel buttons. Save
// pipes through editAppointment, which already audits to
// patient_events so the timeline picks the change up automatically.
function NotesCard({
  appt,
  onChanged,
}: {
  appt: AppointmentDetailRow;
  onChanged: () => void;
}) {
  const canEdit =
    appt.source !== 'calendly' && (appt.status === 'booked' || appt.status === 'arrived');
  const trimmed = appt.notes?.trim() ?? '';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trimmed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft when the underlying notes change (e.g. another
  // tab edited the row). Only when not actively editing — clobbering
  // a half-typed edit would be worse than ignoring the upstream change.
  useEffect(() => {
    if (!editing) setDraft(trimmed);
  }, [editing, trimmed]);

  // Hide the card entirely when there's nothing to show AND nothing
  // editable. Keeping a placeholder card in that case would just be
  // visual noise.
  if (!canEdit && trimmed.length === 0) return null;

  const handleSave = async () => {
    if (saving) return;
    setError(null);
    const next = draft.trim();
    if (next === trimmed) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editAppointment({ appointmentId: appt.id, notes: next.length > 0 ? next : null });
      setEditing(false);
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save notes';
      await logFailure({
        source: 'AppointmentDetail.editNotes',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(trimmed);
    setError(null);
    setEditing(false);
  };

  const editButton =
    canEdit && !editing ? (
      <button
        type="button"
        aria-label={trimmed.length > 0 ? 'Edit notes' : 'Add notes'}
        title={trimmed.length > 0 ? 'Edit notes' : 'Add notes'}
        onClick={() => setEditing(true)}
        style={{
          appearance: 'none',
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
          color: theme.color.inkMuted,
          cursor: 'pointer',
          padding: 0,
          width: 30,
          height: 30,
          borderRadius: theme.radius.pill,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = theme.color.ink;
          e.currentTarget.style.color = theme.color.ink;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = theme.color.border;
          e.currentTarget.style.color = theme.color.inkMuted;
        }}
      >
        <Pencil size={13} aria-hidden />
      </button>
    ) : null;

  return (
    <Card padding="lg">
      <DetailSectionHeader
        icon={<StickyNote size={15} aria-hidden />}
        title="Notes"
        trailing={editButton}
      />

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            autoFocus
            rows={4}
            placeholder="Add notes the next receptionist will see when they open this booking."
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
              lineHeight: theme.type.leading.relaxed,
            }}
          />
          {error ? (
            <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.alert }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
            <Button variant="tertiary" size="sm" onClick={handleCancel} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              loading={saving}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save notes'}
            </Button>
          </div>
        </div>
      ) : trimmed.length > 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.relaxed,
            whiteSpace: 'pre-wrap',
          }}
        >
          {trimmed}
        </p>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontStyle: 'italic',
          }}
        >
          No notes yet. Tap the pencil to add some.
        </p>
      )}
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
  const iconBg =
    tone === 'cancelled' ? 'rgba(184, 58, 42, 0.10)' : 'rgba(179, 104, 21, 0.10)';
  const Icon = tone === 'cancelled' ? XCircle : CircleSlash;
  return (
    <Card padding="lg" style={{ borderLeft: `3px solid ${accent}` }}>
      <DetailSectionHeader
        icon={<Icon size={15} aria-hidden />}
        title={label}
        iconBg={iconBg}
        iconFg={accent}
      />
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.relaxed,
          whiteSpace: 'pre-wrap',
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
    <Card padding="lg">
      <DetailSectionHeader icon={<CalendarClock size={15} aria-hidden />} title="Rescheduled to" />
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

// Card section header used by every info card on this page. The icon
// sits in a softly tinted pill, paired with a sentence-case h3 title;
// optional trailing slot carries a status pill or an inline edit
// affordance. Mirrors the visual language of the AppointmentHero so
// the cards underneath read as part of the same surface, not a
// looser collage.
function DetailSectionHeader({
  icon,
  title,
  trailing,
  iconBg,
  iconFg,
}: {
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
  iconBg?: string;
  iconFg?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginBottom: theme.space[4],
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[3],
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: iconBg ?? theme.color.accentBg,
            color: iconFg ?? theme.color.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h3>
      </span>
      {trailing ? <span style={{ flexShrink: 0 }}>{trailing}</span> : null}
    </div>
  );
}

// Two-column key/value row shared by Booking and Intake cards. Label
// reads as a quiet caption, value as the answer in ink semibold.
// `wrapValue` switches the value from single-line ellipsed (good for
// emails / addresses) to wrapping prose (good for free-text intake
// answers). `icon` is optional — when supplied it sits left of the
// label as a quiet visual anchor.
function KeyValueRow({
  icon,
  label,
  value,
  isFirst,
  wrapValue,
  labelMaxWidth,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  isFirst?: boolean;
  wrapValue?: boolean;
  /**
   * Sizing for the label column.
   *
   *   undefined  default cap — 140px without an icon, 130px with one.
   *              Right for short, predictable labels (Location, Email).
   *   number     fixed cap in px. Use when intermediate-length labels
   *              need a slightly wider lane but still consistent
   *              alignment across rows.
   *   'fit'      label sizes to its natural content width per row.
   *              Best for variable-length labels (intake questions
   *              from "Arch" to "What product is the impression for")
   *              where a fixed cap forces every row to inherit the
   *              widest label's gap.
   */
  labelMaxWidth?: number | 'fit';
}) {
  const labelTrack =
    labelMaxWidth === 'fit'
      ? 'max-content'
      : `minmax(0, ${labelMaxWidth ?? (icon ? 130 : 140)}px)`;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: icon
          ? `14px ${labelTrack} minmax(0, 1fr)`
          : `${labelTrack} minmax(0, 1fr)`,
        gap: theme.space[3],
        alignItems: 'baseline',
        padding: `${theme.space[3]}px 0`,
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      {icon ? (
        <span style={{ color: theme.color.inkSubtle, display: 'inline-flex', alignSelf: 'center' }}>
          {icon}
        </span>
      ) : null}
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          fontWeight: theme.type.weight.semibold,
          lineHeight: theme.type.leading.relaxed,
          minWidth: 0,
          ...(wrapValue
            ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
            : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
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

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length > 0;

  const submit = async () => {
    if (submitting) return;
    if (!reasonValid) {
      setError('Tell us why this is being cancelled — it surfaces on the timeline and reports.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await cancelAppointment({
        appointmentId: appt.id,
        reason: trimmedReason,
        notifyPatient: notify,
      });
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
          <Button
            variant="primary"
            onClick={submit}
            loading={submitting}
            disabled={submitting || !reasonValid}
          >
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
            Reason
            <RequiredAsterisk />
            <span style={{ color: theme.color.inkSubtle }}> · surfaces in the timeline and reports</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={submitting}
            placeholder="e.g. Patient asked to push to next week"
            autoFocus
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

// Standalone red asterisk used on form labels to mark required fields.
// Keeps every "required" indicator visually consistent across this
// page so the meaning is unambiguous.
function RequiredAsterisk() {
  return (
    <span aria-hidden style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
      {' *'}
    </span>
  );
}

// No-show flow as a bottom sheet sliding up. Two stages:
//
//   1. Reason picker — four tappable rows. The first three commit
//      immediately (the enum value alone is the reason). "Other"
//      flips to stage 2 instead so the receptionist must type
//      something — vague "Other" with no explanation is the kind of
//      data point reports can't act on later.
//
//   2. Other-reason text input — required, asterisk-marked, blocks
//      submit until non-empty. The text is stored verbatim in
//      lng_appointments.cancel_reason, replacing the "other" enum
//      so reports surface what actually happened.
//
// Schedule still uses the v1 picker that commits "other" without a
// note; matching it here would let staff bypass the requirement on
// this surface. The user explicitly asked for the text-required
// behaviour on this page.
function NoShowSheet({
  appt,
  onClose,
  onMarked,
}: {
  appt: AppointmentDetailRow;
  onClose: () => void;
  onMarked: () => void;
}) {
  const [stage, setStage] = useState<'pick' | 'other_text'>('pick');
  const [otherText, setOtherText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const otherTextValid = otherText.trim().length > 0;

  // Submit with a typed reason. The third arg becomes
  // lng_appointments.cancel_reason. For one of the three preset
  // categories that's the enum string; for 'other' we send the
  // typed note instead so the report can show what actually happened.
  const submit = async (
    reason: typeof NO_SHOW_REASONS[number]['value'],
    storedReason: string,
  ) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await markNoShow(appt.id, reason, {
        patientId: appt.patient_id,
        wasVirtual: !!appt.join_url,
        joinedBeforeNoShow: false,
        storedReason,
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

  const handlePick = (value: typeof NO_SHOW_REASONS[number]['value']) => {
    if (value === 'other') {
      setStage('other_text');
      setError(null);
      return;
    }
    void submit(value, value);
  };

  const handleOtherSubmit = () => {
    if (!otherTextValid) {
      setError('Tell us why this is a no-show — it surfaces on the timeline and reports.');
      return;
    }
    void submit('other', otherText.trim());
  };

  if (stage === 'other_text') {
    return (
      <BottomSheet
        open
        onClose={submitting ? () => undefined : onClose}
        onBack={submitting ? undefined : () => {
          setStage('pick');
          setError(null);
        }}
        title="What happened?"
        description="A short note so the timeline and reports show why this slot was missed."
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
            <Button
              variant="tertiary"
              onClick={() => {
                setStage('pick');
                setError(null);
              }}
              disabled={submitting}
            >
              Back
            </Button>
            <Button
              variant="primary"
              onClick={handleOtherSubmit}
              loading={submitting}
              disabled={submitting || !otherTextValid}
            >
              {submitting ? 'Marking…' : 'Mark as no-show'}
            </Button>
          </div>
        }
      >
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
            Reason
            <RequiredAsterisk />
          </span>
          <textarea
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={4}
            disabled={submitting}
            placeholder="e.g. Patient called the lab to say they couldn't make it"
            autoFocus
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
              lineHeight: theme.type.leading.relaxed,
            }}
          />
          {error ? (
            <span style={{ color: theme.color.alert, fontSize: theme.type.size.xs }}>{error}</span>
          ) : null}
        </label>
      </BottomSheet>
    );
  }

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
            onClick={() => handlePick(opt.value)}
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
