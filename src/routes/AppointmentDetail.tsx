import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ClipboardList,
  Copy,
  CreditCard,
  Mail,
  MapPin,
  Pencil,
  RotateCcw,
  StickyNote,
  User as UserIcon,
  UserCheck,
  UserX,
  Video,
  XCircle,
} from 'lucide-react';
import {
  AppointmentExtras,
  AppointmentHero,
  type AppointmentHeroPill,
  type AppointmentHeroTone,
  ContinuousTimeline,
  MeetAttendanceCard,
  BottomSheet,
  Breadcrumb,
  Button,
  Card,
  DepositGlyph,
  DropdownSelect,
  EmptyState,
  PhaseTimeline,
  RescheduleSheet,
  Section,
  Skeleton,
  SmilePhotosCard,
  type StatusTone,
} from '../components/index.ts';
import { SourceGlyph } from '../components/AppointmentCard/AppointmentCard.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import {
  configFor,
  useAdminProductConfig,
} from '../lib/queries/productWidgetConfig.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { logFailure } from '../lib/failureLog.ts';
import {
  formatAppointmentSummary,
  patientFullDisplayName,
  properCase,
} from '../lib/queries/appointments.ts';
import type { AppointmentStatus } from '../components/AppointmentCard/AppointmentCard.tsx';
import { humaniseEventTypeLabel } from '../lib/queries/patientProfile.ts';
import {
  formatDateLongOrdinal,
  formatTime,
  formatTimeRange,
  relativeDay,
} from '../lib/dateFormat.ts';
import { formatPence } from '../lib/queries/carts.ts';
import { useAppointmentLivePhases } from '../lib/queries/appointmentLivePhases.ts';
import { createMeetSpaceForAppointment, fetchMeetAttendance, useMeetHosts } from '../lib/queries/meetHosts.ts';
import { humaniseCancelReason, logVirtualMeetingRejoin, markNoShow, markVirtualMeetingJoined, NO_SHOW_REASONS, reverseNoShow } from '../lib/queries/visits.ts';
import { cancelAppointment, reverseCancellation } from '../lib/queries/cancelAppointment.ts';
import { recordOwedToPatient } from '../lib/queries/owedToPatient.ts';
import { RefundSheet } from '../components/RefundSheet/RefundSheet.tsx';
import { supabase } from '../lib/supabase.ts';
import { editAppointment } from '../lib/queries/editAppointment.ts';
import { sendAppointmentConfirmation } from '../lib/queries/sendAppointmentConfirmation.ts';
import {
  availableActions,
  useAppointmentDetail,
  type AppointmentAction,
  type AppointmentDetailRow,
} from '../lib/queries/appointmentDetail.ts';
import { humaniseLedgerSource } from '../lib/queries/ledger.ts';
import { useClinicSettings } from '../lib/queries/clinicSettings.ts';
import googleMeetIcon from '../assets/google-meet.png';

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
  // Resolve the signed-in user's accounts.id (NOT the auth user uuid)
  // for stamping uploader on patient_files rows. The two are
  // different — patient_files.uploaded_by has an FK to accounts.id.
  const { account: currentAccount } = useCurrentAccount();
  // Per-product widget config drives whether the Smile photos card
  // surfaces on this appointment. Looked up via (service_type,
  // product_key) — previously hardcoded to click_in_veneers; now any
  // product whose admin toggle is on shows it. Missing rows fall back
  // to defaults (request_smile_photos=false).
  const { data: productConfig } = useAdminProductConfig();
  const [rescheduling, setRescheduling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reversingCancellation, setReversingCancellation] = useState(false);
  const [reversingNoShow, setReversingNoShow] = useState(false);
  const [confirmNoShowOpen, setConfirmNoShowOpen] = useState(false);
  const [confirmReverseCancelOpen, setConfirmReverseCancelOpen] = useState(false);
  const [confirmReverseNoShowOpen, setConfirmReverseNoShowOpen] = useState(false);
  const [resending, setResending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-pull Meet attendance once when the page opens on a virtual
  // appointment whose end time has passed and Google has nothing for
  // us yet (no conference_started_at on the row). Removes the
  // "did the operator remember to tap Refresh?" failure mode that
  // caused the original "attendance not working" complaint: by the
  // time someone disputes who attended, the data is already pulled
  // and the verdict line is already showing the truth. The hook
  // listens on lng_meet_attendance changes (via useMeetAttendance's
  // realtime subscription) so the freshly-inserted rows surface
  // without needing to refresh the appointment row itself.
  useEffect(() => {
    // Gate on the fields meet-fetch-attendance actually needs:
    // meet_meeting_code (what it filters on) + meet_host_id (whose
    // OAuth token to use). meet_space_id is intentionally not part of
    // this gate — it can legitimately be NULL when an earlier
    // spaces.get lookup failed, and meeting_code is sufficient for
    // every downstream API call.
    if (!appt.meet_meeting_code || !appt.meet_host_id) return;
    if (appt.conference_started_at) return;
    if (new Date(appt.end_at).getTime() > Date.now()) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchMeetAttendance(appt.id);
        if (cancelled) return;
        // Only refresh the appointment row if Google actually produced
        // a conference record this round — otherwise we'd re-trigger
        // this same effect on the next render with no new data, just
        // burning a function invoke per visit.
        if (result.ok && !result.waitingForMeeting) {
          onChanged();
        }
      } catch {
        // Auto-fetch is best-effort. The Refresh button stays available
        // for an operator-initiated retry; we don't want a transient
        // 5xx to throw a toast on every page open.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appt.id, appt.meet_meeting_code, appt.meet_host_id, appt.conference_started_at, appt.end_at, onChanged]);

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
        isVirtual: !!appt.join_url,
      }),
    [
      appt.status,
      appt.source,
      appt.patient.email,
      appt.visit,
      appt.reschedule_to_id,
      appt.join_url,
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

  // Virtual appointments: first join records that the meeting started
  // (sets status → arrived, writes a patient event) then opens the URL.
  // Rejoin skips the status mutation — the appointment is already arrived.
  const handleJoinMeeting = async () => {
    try {
      await markVirtualMeetingJoined(appt.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not record meeting join';
      await logFailure({
        source: 'AppointmentDetail.joinMeeting',
        severity: 'error',
        message,
        context: { appointmentId: appt.id },
      });
      setActionError(message);
    }
    if (appt.join_url) window.open(appt.join_url, '_blank', 'noopener,noreferrer');
    onChanged();
  };

  const handleRejoinMeeting = async () => {
    if (appt.join_url) window.open(appt.join_url, '_blank', 'noopener,noreferrer');
    try {
      await logVirtualMeetingRejoin(appt.id, appt.patient_id);
    } catch (e) {
      await logFailure({
        source: 'AppointmentDetail.rejoinMeeting',
        severity: 'warning',
        message: e instanceof Error ? e.message : 'Could not log rejoin event',
        context: { appointmentId: appt.id },
      });
    }
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
        {appt.status === 'rescheduled' ||
        appt.status === 'cancelled' ||
        appt.status === 'no_show' ||
        appt.status === 'complete' ? null : appt.join_url ? (
          <MeetingLinkCard joinUrl={appt.join_url} />
        ) : appt.service_type === 'virtual_impression_appointment' ? (
          <GenerateMeetLinkCard appointmentId={appt.id} currentHostId={appt.meet_host_id} onCreated={onChanged} />
        ) : null}
        <BookingFactsCard appt={appt} />
        <AppointmentExtras
          upgrades={appt.upgrades}
          repairItems={appt.repairItems}
        />
        {configFor(appt.service_type, appt.product_key, productConfig).request_smile_photos ? (
          <SmilePhotosCard
            appointmentId={appt.id}
            patientId={appt.patient_id}
            patientName={patientFullDisplayName({
              patient_first_name: appt.patient.first_name,
              patient_last_name: appt.patient.last_name,
            } as never)}
            uploaderAccountId={currentAccount?.account_id ?? null}
            onPromoted={onChanged}
          />
        ) : null}
        {appt.intake && appt.intake.length > 0 ? <IntakeCard intake={appt.intake} /> : null}
        {appt.deposit_pence != null && appt.deposit_pence > 0 ? <DepositCard appt={appt} /> : null}
        {appt.shopify_order_name && (appt.shopify_order_total_pence ?? 0) > 0 ? (
          <OnlineOrderCreditCard
            orderName={appt.shopify_order_name}
            pence={appt.shopify_order_total_pence ?? 0}
          />
        ) : null}
        <NotesCard appt={appt} onChanged={onChanged} />
        {appt.status === 'cancelled' && appt.cancel_reason ? (
          <ReasonCard
            tone="cancelled"
            label="Cancellation reason"
            // cancel_reason carries either an enum (NoShowReason
            // values, 'patient_self_serve', 'patient_self_serve_reschedule')
            // or the free-text "Other" note typed by the receptionist.
            // humaniseCancelReason returns the friendly label for known
            // enums (including the two self-serve variants written by
            // the widget edge functions) and passes free-text through
            // verbatim.
            text={humaniseCancelReason(appt.cancel_reason) ?? appt.cancel_reason}
          />
        ) : null}
        {appt.status === 'no_show' && appt.cancel_reason ? (
          <ReasonCard
            tone="no_show"
            label="No-show reason"
            text={humaniseCancelReason(appt.cancel_reason) ?? appt.cancel_reason}
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
        isCsOnly={currentAccount?.is_cs_only === true}
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
        onJoinMeeting={handleJoinMeeting}
        onRejoinMeeting={handleRejoinMeeting}
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

      {appt.meet_meeting_code && appt.meet_host_id ? (
        <section style={{ marginTop: theme.space[5] }}>
          <MeetAttendanceCard
            appointmentId={appt.id}
            meetMeetingCode={appt.meet_meeting_code}
            meetingHasEnded={new Date(appt.end_at).getTime() < Date.now()}
            conferenceStartedAt={appt.conference_started_at}
            conferenceEndedAt={appt.conference_ended_at}
            conferenceCount={appt.conference_count}
            recordingCount={appt.recording_count}
            transcriptCount={appt.transcript_count}
            patientFirstName={appt.patient.first_name}
            patientLastName={appt.patient.last_name}
          />
        </section>
      ) : null}

      <section style={{ marginTop: theme.space[5] }}>
        {/* ContinuousTimeline drives both pre- and post-arrival pages,
            so the patient's audit trail reads as one stream regardless
            of which surface a receptionist is on. visitId is null
            here — when a visit exists, AppointmentDetail redirects to
            /visit/:id (above) and VisitDetail mounts the same hook
            with visitId set, picking up the post-arrival events on
            top of the same pre-arrival history. */}
        <ContinuousTimeline appointmentId={appt.id} visitId={null} />
      </section>

      {rescheduling ? (
        <RescheduleSheet
          open
          appointment={{
            id: appt.id,
            patient_id: appt.patient_id,
            location_id: appt.location_id,
            // Axis pins are required so RescheduleSheet's availability
            // RPCs (resolveBookingTypeConfig, useAvailableDates,
            // loadAvailableSlots, checkBookingConflict) resolve the
            // per-product duration the widget uses for THIS exact
            // booking — not the parent service's default. Without
            // them, the calendar dimmed the wrong dates and the slot
            // picker offered the wrong times. Dylan's flag: "must
            // match exactly the original booking layout".
            service_type:
              (appt.service_type ?? null) as
                | 'denture_repair'
                | 'click_in_veneers'
                | 'same_day_appliance'
                | 'impression_appointment'
                | 'virtual_impression_appointment'
                | 'other'
                | null,
            repair_variant: appt.repair_variant,
            product_key: appt.product_key,
            arch: appt.arch as 'upper' | 'lower' | 'both' | null,
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
  joined: 'arrived',
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
  const navigate = useNavigate();
  // Sheet state for the phase timeline. Lives in the hero because
  // the "Estimated appointment length" affordance lives in the
  // hero's timeLine. Sheet itself renders via portal so DOM position
  // doesn't matter.
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Refund sheet for a cancelled appointment with a paid deposit on
  // file. Opened from the CancelledRefundBanner rendered just below.
  const [refundOpen, setRefundOpen] = useState(false);
  // Sum of succeeded refunds against this appointment's deposit.
  // Both the banner ("We owe £X" should drop after each refund)
  // AND the sheet's suggested amount need this — otherwise the
  // sheet auto-allocates the full original deposit and renders a
  // misleading "shortfall" alert.
  const [depositRefundedPence, setDepositRefundedPence] = useState(0);
  const [depositRefundsLoaded, setDepositRefundsLoaded] = useState(false);
  const [depositRefundsTick, setDepositRefundsTick] = useState(0);
  useEffect(() => {
    if (appt.deposit_status !== 'paid') {
      setDepositRefundedPence(0);
      setDepositRefundsLoaded(true);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('lng_payment_refunds')
        .select('amount_pence')
        .eq('deposit_appointment_id', appt.id)
        .eq('status', 'succeeded');
      if (cancelled) return;
      const total = ((data ?? []) as { amount_pence: number }[]).reduce(
        (acc, r) => acc + (r.amount_pence ?? 0),
        0,
      );
      setDepositRefundedPence(total);
      setDepositRefundsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [appt.id, appt.deposit_status, depositRefundsTick]);
  const depositRemainingPence = Math.max(
    0,
    (appt.deposit_pence ?? 0) - depositRefundedPence,
  );
  // Resolve the LIVE booking-type phases for this appointment.
  // Source is the admin's current config (lng_booking_type_resolve),
  // not the materialised snapshot, because the modal is a customer-
  // facing description of how the service unfolds and should reflect
  // what's set up right now — not whatever was frozen at the moment
  // of booking. See appointmentLivePhases.ts for the trade-off.
  const livePhasesState = useAppointmentLivePhases({
    service_type: appt.service_type,
    repair_variant: appt.repair_variant,
    product_key: appt.product_key,
    arch: appt.arch,
    start_at: appt.start_at,
  });
  const livePhases = livePhasesState.phases ?? [];
  // Only offer the link when the breakdown is non-trivial — i.e.
  // the service has more than one phase in the live config. A
  // single-phase booking (no passive lab gap) has a contiguous
  // 09:15 → 09:45 window where the legacy timeRange line is honest;
  // swapping to "Booked for 09:15 + link" would lose information
  // without explaining anything new. Services without configured
  // phases also skip the link so it never points at a dead modal.
  const onShowTimeline =
    livePhases.length > 1 ? () => setTimelineOpen(true) : null;
  // Source label — "Native" reads as developer jargon to the
  // reception team. For widget-originated bookings we know which
  // storefront the patient booked through (brand_id is written by
  // widget-create-appointment), so swap in the storefront URL
  // instead. Calendly / manual / unknown brand keep their
  // existing labels.
  const sourceLabel =
    appt.source === 'native'
      ? appt.brand_id === 'denture'
        ? 'denture-services.co.uk'
        : appt.brand_id === 'venneir'
          ? 'venneir.com'
          : 'Booking widget'
      : humaniseLedgerSource(appt.source);
  // Subtitle is a JSX node so the SourceGlyph (walk-in vs widget vs
  // Calendly) sits inline with the text. The icon is the at-a-glance
  // signal the schedule cards use; mirroring it on the detail page
  // keeps the cue consistent across every surface an appointment
  // appears on.
  // Checkpoint bookings come in as source='manual' (since a staff
  // member created them on the patient's behalf) but they're not
  // the same as an in-app NewBookingSheet booking — the staff
  // member never opened Lounge. Detect via created_via and swap
  // the source label so reception can tell at a glance.
  const isCheckpointBooking = appt.created_via === 'checkpoint';
  const refTextParts = [
    isCheckpointBooking ? 'Checkpoint' : sourceLabel,
    appt.appointment_ref ?? null,
  ].filter(Boolean) as string[];
  const refLine = (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <SourceGlyph source={appt.source} size={12} />
        <span>{refTextParts.join(' · ')}</span>
      </span>
      {isCheckpointBooking ? (
        <span
          style={{
            fontSize: 12,
            color: theme.color.inkMuted,
            lineHeight: 1.4,
          }}
        >
          Booked through Checkpoint
          {appt.created_via_actor ? ` by ${appt.created_via_actor}` : ''}
        </span>
      ) : null}
    </span>
  );
  // Native widget bookings AND staff-created manual bookings both
  // store axis pins (arch + product_key + service_type) on the row
  // directly, so compose the title from those columns instead of
  // running the Calendly intake-parsing heuristics. Result:
  //   click-in veneers + upper → "Upper Click-in veneers"
  //   same-day appliance + retainer + lower → "Lower retainer"
  //   same-day appliance + retainer + both  → "Upper & lower retainers"
  // Calendly-imported rows fall back to the legacy parsing path —
  // they pre-date the axis columns and only carry intake answers.
  const service =
    formatAppointmentSummary(appt) ||
    humaniseEventTypeLabel(appt.event_type_label) ||
    'Appointment';

  // State-driven ribbon — icon + dateLong + anchor + relative + tone
  // all picked together so a glance answers "what is this booking
  // doing right now". The dateLong override matters for rescheduled,
  // where the row's start_at is the OLD slot — without a prefix the
  // big bold date reads as the active booking date and confuses the
  // operator about which row this is.
  const ribbon = buildApptRibbon(appt, onShowTimeline);
  const dateLong = ribbon.dateLong ?? formatDateLongOrdinal(appt.start_at);

  // For rescheduled rows the relative slot becomes a one-tap link to
  // the new booking — same destination as the "Rescheduled to" card
  // below, but reachable from the ribbon so the staff don't have to
  // scroll. The button styles match the accent treatment the ribbon
  // already gives to the relative span so it reads as one element,
  // not a tacked-on control.
  const relative: ReactNode | null =
    appt.status === 'rescheduled' && appt.reschedule_to_id ? (
      <RibbonNavLink
        onClick={() => navigate(`/appointment/${appt.reschedule_to_id}`)}
      >
        Open new booking
      </RibbonNavLink>
    ) : (
      ribbon.relative
    );

  // Pills sit next to the patient name in the hero. Status is always
  // present; "Deposit paid" joins it when the booking-time deposit has
  // settled, so the page reads as deposit-secured the moment a glance
  // lands on the hero. Distinct from the solid-green "Paid" used for a
  // fully-settled cart on VisitDetail — a £25 deposit is not the same
  // as a £200 visit being paid in full.
  const pills: AppointmentHeroPill[] = [
    { tone, label: humaniseAppointmentStatus(appt.status) },
  ];
  if (appt.deposit_status === 'paid' && (appt.deposit_pence ?? 0) > 0) {
    // Same money fact, two labels: paid_in_full_at_booking flips
    // the read from "partial up-front" to "the whole bill is
    // settled". Keep the deposit_paid tone so the visual family
    // (soft accent fill) stays consistent on the hero, but swap
    // the copy + glyph so the receptionist doesn't go chasing a
    // balance that doesn't exist.
    const fullyPaid = appt.paid_in_full_at_booking;
    pills.push({
      tone: 'deposit_paid',
      label: fullyPaid ? 'Paid in full' : 'Deposit paid',
      icon: fullyPaid ? <BadgeCheck size={14} aria-hidden /> : <DepositGlyph size={14} />,
    });
  }

  return (
    <>
      <AppointmentHero
        patient={{ name: fullName, avatarSrc: appt.patient.avatar_data }}
        pills={pills}
        subtitle={refLine}
        when={{
          dateLong,
          timeLine: ribbon.timeLine,
          relative,
          service,
          tone: ribbon.tone,
          icon: ribbon.icon,
        }}
      />
      <CancelledRefundBanner
        appt={appt}
        depositRefundedPence={depositRefundedPence}
        depositRefundsLoaded={depositRefundsLoaded}
        onOpenRefund={() => setRefundOpen(true)}
      />
      <RefundSheet
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        cartId={null}
        appointmentId={appt.id}
        suggestedPence={depositRemainingPence}
        defaultCategory="visit_cancelled"
        onCompleted={() => setDepositRefundsTick((t) => t + 1)}
      />
      <BottomSheet
        open={timelineOpen}
        onClose={() => setTimelineOpen(false)}
        title="Estimated appointment length"
        description={
          service ? (
            <span>
              How long {service} typically takes, and when you're free
              to step away.
            </span>
          ) : null
        }
      >
        <PhaseTimeline phases={livePhases} />
      </BottomSheet>
    </>
  );
}

// Inline link rendered in the ribbon's relative slot. Inherits the
// accent colour + semibold weight the surrounding span supplies so it
// looks like part of the ribbon line, not a separate control.
function RibbonNavLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        font: 'inherit',
        color: 'inherit',
        fontWeight: 'inherit',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        textUnderlineOffset: 3,
        textDecoration: 'underline',
      }}
    >
      {children}
      <ArrowRight size={12} aria-hidden />
    </button>
  );
}

// Inline "Estimated appointment length" affordance rendered next to
// the booked-for time on the hero ribbon. Same chrome as RibbonNavLink
// but with the accent colour locked to the ribbon's accent so it's
// recognisably a link even when the surrounding span colours flex
// per ribbon tone. Trailing arrow signals "this opens something",
// matching the pattern Linear / Vercel use for inline contextual
// links.
function TimelineLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.accent,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        textUnderlineOffset: 3,
        textDecoration: 'underline',
      }}
    >
      Estimated appointment length
      <ArrowRight size={12} aria-hidden />
    </button>
  );
}

// One source of truth for what the ribbon says + which icon it shows
// for every appointment status. Each branch returns a fully-formed
// "what's going on now, in plain English" — no shared scaffolding
// across statuses, because the language for "did not turn up" should
// not look like the language for "rescheduled to a new slot".
function buildApptRibbon(
  appt: AppointmentDetailRow,
  onShowTimeline: (() => void) | null,
): {
  icon: ReactNode;
  /** Optional override for the big bold date heading. Most states
   * keep the appointment's own start_at (formatted long); rescheduled
   * uses this to label the date as past so the operator never thinks
   * the OLD slot is the live one. */
  dateLong?: string;
  timeLine: ReactNode;
  relative: string | null;
  tone: AppointmentHeroTone;
} {
  const startMs = new Date(appt.start_at).getTime();
  const now = Date.now();
  const timeRange = formatTimeRange(appt.start_at, appt.end_at);
  const startStr = formatTime(appt.start_at);
  // For 'booked' rows we replace the misleading "09:15 — 09:45" range
  // with just the start time + an inline link that opens the full
  // phase timeline. The end of the appointment can be hours later if
  // the booking has a passive lab phase mid-flow (e.g. Click-in
  // veneers: Book-in 10m + Impression 5m + Manufacture 4h + Try In
  // 10m), so the patient and the receptionist were both reading a
  // dishonest single-block window. We only swap when the timeline is
  // actually available (caller passed a non-null onShowTimeline) —
  // services with zero or one configured phase fall back to the
  // original range string.
  const canShowTimeline = onShowTimeline !== null;
  const bookedForLine: ReactNode = canShowTimeline ? (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span>Booked for {startStr}</span>
      <TimelineLink onClick={onShowTimeline!} />
    </span>
  ) : (
    `Booked for ${timeRange}`
  );

  switch (appt.status) {
    case 'booked': {
      // Future booking — calendar icon, accent tone, "in 5 days" copy.
      // Past booking still flagged 'booked' is a missed slot the
      // operator hasn't actioned (no arrived / no-show / cancel) —
      // surface that as overdue with a warn tone so it doesn't blend
      // in with normal upcoming bookings on the page.
      if (startMs > now) {
        return {
          icon: <CalendarClock size={16} aria-hidden />,
          timeLine: bookedForLine,
          relative: relativeDay(appt.start_at),
          tone: 'accent',
        };
      }
      return {
        icon: <AlertTriangle size={16} aria-hidden />,
        timeLine: bookedForLine,
        relative: 'Patient overdue',
        tone: 'warn',
      };
    }
    case 'joined':
    case 'arrived': {
      // Virtual appointments stay on this page after joining (no visit
      // row is created), so the ribbon must read as an active meeting.
      // Non-virtual arrived rows are transient — the arrival flow opens
      // a visit immediately and the page redirects; the bridging copy
      // only shows for a moment.
      if (appt.join_url) {
        return {
          icon: <Video size={16} aria-hidden />,
          timeLine: `Remote session at ${timeRange}`,
          relative: null,
          tone: 'accent',
        };
      }
      return {
        icon: <UserCheck size={16} aria-hidden />,
        timeLine: 'Patient checked in',
        relative: 'Opening visit',
        tone: 'accent',
      };
    }
    case 'complete': {
      return {
        icon: <CheckCircle2 size={16} aria-hidden />,
        timeLine: appt.join_url ? 'Meeting complete' : 'Visit complete',
        relative: null,
        tone: 'neutral',
      };
    }
    case 'no_show': {
      return {
        icon: <UserX size={16} aria-hidden />,
        timeLine: 'Patient did not turn up',
        relative: humaniseCancelReason(appt.cancel_reason),
        tone: 'warn',
      };
    }
    case 'cancelled': {
      // Customer self-serve cancels carry the dedicated enum
      // 'patient_self_serve' from widget-cancel-booking. The
      // humaniser turns it into "Customer cancelled via the
      // self-service link in their email" so the ribbon makes
      // clear it wasn't a staff action. Free-text "Other" notes
      // (typed by the receptionist on the cancel sheet) still
      // truncate so the ribbon doesn't grow on long reasons.
      const friendly = humaniseCancelReason(appt.cancel_reason);
      return {
        icon: <Ban size={16} aria-hidden />,
        timeLine: 'Cancelled',
        relative: friendly ? truncateRibbonReason(friendly) : null,
        tone: 'alert',
      };
    }
    case 'rescheduled': {
      // The big bold date on a rescheduled row is the OLD slot
      // (appt.start_at hasn't moved — the new booking is a separate
      // row reachable via reschedule_to_id). Heading reads "Was on
      // <day> at <time>" so the receptionist sees both the day AND
      // the original slot time the patient was supposed to arrive
      // at, without having to navigate into the new booking just
      // to know what got moved. The relative slot is replaced in
      // Hero() with a clickable "Open new booking →" link that
      // navigates straight to the replacement.
      //
      // Self-serve reschedules carry cancel_reason=
      // 'patient_self_serve_reschedule' on the OLD row; surface
      // that as the timeLine so the ribbon explicitly says the
      // patient moved their own slot.
      const isSelfServe =
        appt.cancel_reason === 'patient_self_serve_reschedule';
      return {
        icon: <RotateCcw size={16} aria-hidden />,
        // Start-time only — Dylan's convention is to surface the
        // booked time (when the patient was supposed to arrive),
        // not the full slot range. Matches the booked-state hero
        // which leads with the start time too; the end is a
        // duration concern, not a heading concern.
        dateLong: `Was on ${formatDateLongOrdinal(appt.start_at)} at ${formatTime(appt.start_at)}`,
        timeLine: isSelfServe
          ? 'Customer rescheduled themselves via their email link'
          : 'This booking has been moved',
        relative: null,
        tone: 'warn',
      };
    }
  }
}

// Long cancel reasons would push the relative line off the ribbon and
// truncate awkwardly; keep them to a glance-readable length, the full
// reason still shows in the ReasonCard below.
function truncateRibbonReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
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
    case 'joined':
      return 'Joined';
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

const PLATFORM_LABELS: Record<string, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  microsoft_teams: 'Microsoft Teams',
  whereby: 'Whereby',
};

function platformLabel(platform: string | null, joinUrl: string | null): string {
  if (platform && PLATFORM_LABELS[platform]) return PLATFORM_LABELS[platform];
  // Fallback: infer from join URL domain for legacy rows without a stored platform.
  if (joinUrl?.includes('meet.google.com')) return 'Google Meet';
  if (joinUrl?.includes('zoom.us')) return 'Zoom';
  if (joinUrl?.includes('teams.microsoft')) return 'Microsoft Teams';
  if (joinUrl?.includes('whereby.com')) return 'Whereby';
  return 'Online';
}

function platformIcon(platform: string | null, joinUrl: string | null): ReactNode {
  const label = platformLabel(platform, joinUrl);
  if (label === 'Google Meet') {
    return (
      <img
        src={googleMeetIcon}
        alt="Google Meet"
        width={13}
        height={13}
        style={{ display: 'block', objectFit: 'contain' }}
      />
    );
  }
  return <Video size={13} aria-hidden />;
}

function MeetingLinkCard({ joinUrl }: { joinUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const teal = theme.category.virtualImpression;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(joinUrl);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = joinUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  const displayUrl = joinUrl.replace(/^https?:\/\//, '');

  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${teal}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[3] }}>
        <img
          src={googleMeetIcon}
          height={18}
          aria-hidden
          style={{ display: 'block', width: 'auto', flexShrink: 0 }}
        />
        <span style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}>
          Virtual meeting link
        </span>
      </div>

      {/* Clickable link row */}
      <button
        type="button"
        onClick={handleCopy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={copied ? 'Meeting link copied' : 'Copy meeting link'}
        style={{
          appearance: 'none',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          background: hovered ? `rgba(61,143,160,0.1)` : `rgba(61,143,160,0.06)`,
          border: `1px solid rgba(61,143,160,${hovered ? '0.28' : '0.12'})`,
          borderRadius: 10,
          padding: `${theme.space[2] + 2}px ${theme.space[3]}px`,
          cursor: 'pointer',
          textAlign: 'left',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          userSelect: 'none',
        }}
      >
        {/* URL */}
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: theme.type.size.sm,
          color: teal,
          fontWeight: theme.type.weight.medium,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {displayUrl}
        </span>

        {/* Vertical divider */}
        <div style={{ width: 1, height: 16, background: `rgba(61,143,160,0.18)`, flexShrink: 0 }} aria-hidden />

        {/* Copy state */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: copied ? theme.color.accent : teal,
          flexShrink: 0,
          minWidth: 72,
          justifyContent: 'flex-end',
          transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}>
          {copied
            ? <><CheckCircle2 size={13} aria-hidden /> Copied!</>
            : <><Copy size={13} aria-hidden /> Copy link</>
          }
        </div>
      </button>

      {/* Hint */}
      <p style={{
        margin: `${theme.space[2]}px 0 0`,
        fontSize: theme.type.size.xs,
        color: theme.color.inkSubtle,
        lineHeight: theme.type.leading.snug,
      }}>
        Click the link to copy it and share with the patient.
      </p>
    </div>
  );
}

// Recovery surface for virtual appointments where the Meet link
// creation failed at booking time (most commonly: OAuth secrets
// weren't in place yet, or the chosen host's token had been revoked).
// Visual language matches MeetingLinkCard (teal left edge, Google
// Meet icon, "Virtual meeting" eyebrow) so the receptionist reads
// these as two states of the same surface: link missing → tap to
// generate → link present.
function GenerateMeetLinkCard({
  appointmentId,
  currentHostId,
  onCreated,
}: {
  appointmentId: string;
  currentHostId: string | null;
  onCreated: () => void;
}) {
  const { hosts, loading: hostsLoading } = useMeetHosts({ activeOnly: true });
  const [hostId, setHostId] = useState<string | null>(currentHostId);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const teal = theme.category.virtualImpression;

  // Auto-pick the appointment's existing host if any, otherwise the
  // top-priority active host. Keeps the common case down to one tap.
  useEffect(() => {
    if (hostId) return;
    if (currentHostId) {
      setHostId(currentHostId);
      return;
    }
    if (hosts.length > 0) setHostId(hosts[0]!.id);
  }, [currentHostId, hostId, hosts]);

  const onGenerate = async () => {
    if (!hostId) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const result = await createMeetSpaceForAppointment({
        appointment_id: appointmentId,
        host_id: hostId,
      });
      if (!result.ok) {
        setErrorMsg(result.error ?? 'Could not create the Meet link.');
        return;
      }
      // Fire the Lounge-branded confirmation email now that join_url
      // is set. The Calendar invite Google sent from the host's
      // account covers the .ics / calendar attendance side; this
      // covers the branded "You're booked in" email pattern. The
      // confirmation sender is idempotent at the message-id level,
      // so a duplicate at booking time is harmless.
      try {
        await sendAppointmentConfirmation({ appointmentId });
      } catch (e) {
        // Non-fatal — the Meet link is the urgent fix; the email can
        // be re-sent from the action list.
        console.warn('[GenerateMeetLinkCard] confirmation send failed:', e);
      }
      onCreated();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Could not create the Meet link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        background: theme.color.surface,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${teal}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[3] }}>
        <img
          src={googleMeetIcon}
          height={18}
          aria-hidden
          style={{ display: 'block', width: 'auto', flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Virtual meeting link
        </span>
      </div>
      <p
        style={{
          margin: `0 0 ${theme.space[3]}px`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: 1.5,
        }}
      >
        This virtual appointment has no Meet link yet. Pick the host whose Google account should own the room and tap Generate. The link appears here once Google returns the space.
      </p>
      {hostsLoading ? (
        <Skeleton height={48} radius={12} />
      ) : hosts.length === 0 ? (
        <div
          style={{
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            background: theme.color.bg,
            border: `1px dashed ${theme.color.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            No Meet hosts connected yet.
          </p>
          <a
            href="/admin?tab=services"
            style={{
              alignSelf: 'flex-start',
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.pill,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.accent,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              textDecoration: 'none',
            }}
          >
            Open Admin, Services
          </a>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <DropdownSelect<string>
            label="Meeting host"
            value={hostId ?? ''}
            onChange={(v) => setHostId(v || null)}
            options={hosts.map((h) => ({
              value: h.id,
              label: `${h.display_name} (${h.google_email})`,
            }))}
            placeholder="Pick a host"
          />
          {errorMsg ? (
            <p
              role="alert"
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.alert,
                lineHeight: 1.5,
              }}
            >
              {errorMsg}
            </p>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={onGenerate}
            loading={busy}
            disabled={!hostId || busy}
            style={{ alignSelf: 'flex-start' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Video size={14} aria-hidden />
              Generate Meet link
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

function BookingFactsCard({ appt }: { appt: AppointmentDetailRow }) {
  const { data: clinicSettings } = useClinicSettings();
  const isVirtual = !!appt.join_url;

  // In-person bookings show the deliverable address only — staff
  // already know which clinic they're at, repeating the clinic name
  // here would be noise. Street address goes on line 1, city +
  // postcode share line 2 so the postcode reads next to its city.
  // Source is the locations row that the Branding admin tab writes
  // to (now including the postcode added by the 20260514 migration).
  const locationLine: ReactNode = isVirtual
    ? platformLabel(appt.meeting_platform, appt.join_url)
    : (() => {
        const l = appt.location;
        if (!l) return null;
        const street = l.address?.trim() || null;
        const cityPostcode = [l.city?.trim(), l.postcode?.trim()]
          .filter(Boolean)
          .join(', ');
        const lines = [street, cityPostcode || null].filter(
          (s): s is string => Boolean(s),
        );
        // Single source: fall back to the location name if neither
        // address nor city is filled in — better than rendering
        // empty.
        if (lines.length === 0) return l.name ?? null;
        if (lines.length === 1) return lines[0];
        return (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {lines.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </span>
        );
      })();

  const staffLine = appt.staff
    ? [properCase(appt.staff.first_name), properCase(appt.staff.last_name)].filter(Boolean).join(' ').trim()
    : null;

  const hasContent = !!locationLine || !!staffLine || !!appt.patient.email;
  if (!hasContent) return null;

  const rows: Array<{ icon: ReactNode; label: string; value: ReactNode }> = [];
  if (locationLine) {
    rows.push({
      icon: isVirtual ? platformIcon(appt.meeting_platform, appt.join_url) : <MapPin size={13} aria-hidden />,
      label: 'Location',
      value: locationLine,
    });
  }
  // "Join from" = the host's email. For per-host Meet bookings we
  // surface the actual host whose Google account owns the room
  // (Karly / Lab / Venneirlaboratory). Legacy / Calendly-imported
  // rows fall back to the clinic-wide setting so they keep their
  // current behaviour.
  const joinFromEmail = appt.meet_host_email ?? clinicSettings.virtualHostEmail;
  if (isVirtual && joinFromEmail) {
    rows.push({
      icon: <Mail size={13} aria-hidden />,
      label: 'Join from',
      value: joinFromEmail,
    });
  }
  if (staffLine) {
    rows.push({ icon: <UserCheck size={13} aria-hidden />, label: 'Staff', value: staffLine });
  }
  if (appt.patient.email) {
    rows.push({ icon: <Mail size={13} aria-hidden />, label: 'Patient email', value: appt.patient.email });
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
              // Reserve the icon column so values align with the
              // Booking details card on the same page. The
              // humaniseIntakeQuestion switch keeps every label
              // shorter than the 130px cap so this row's label
              // never wraps.
              reserveIconColumn
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
    case 'what product is the impression for':
    case 'what product is this impression for':
    case 'product the impression is for':
      return 'Product';
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

// Hero card for the Shopify-paid order linked at booking. Mirrors
// DepositCard's accent-tinted background and 32px amount typography
// so the receptionist reads it as the same "money already in" signal,
// but with copy that makes the difference clear: this isn't a
// deposit reserved against a future bill, it's the actual amount the
// customer paid online for the product they're coming in to redeem,
// and that amount will come off the till at checkout.
function OnlineOrderCreditCard({ orderName, pence }: { orderName: string; pence: number }) {
  return (
    <Card
      padding="lg"
      style={{
        background: theme.color.accentBg,
        border: '1px solid rgba(31, 77, 58, 0.18)',
      }}
    >
      <DetailSectionHeader
        icon={<BadgeCheck size={16} aria-hidden />}
        title="Paid online via venneir.com"
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
          {formatPence(pence)}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          already paid for order <strong style={{ color: theme.color.ink, fontWeight: theme.type.weight.semibold }}>{orderName}</strong>. This credits against the bill at checkout, so the till only collects anything extra on the day.
        </span>
      </div>
    </Card>
  );
}

function DepositCard({ appt }: { appt: AppointmentDetailRow }) {
  if (appt.deposit_pence == null) return null;
  const amount = formatPence(appt.deposit_pence);
  const provider =
    appt.deposit_provider === 'paypal'
      ? 'PayPal'
      : appt.deposit_provider === 'stripe'
        ? 'Stripe'
        : 'Unknown';
  const paid = appt.deposit_status === 'paid';
  const failed = appt.deposit_status === 'failed';

  // Paid: a soft accent-tinted card. Two read-states, same chrome:
  //   • Deposit only — dashed DepositGlyph + "Deposit paid" + copy
  //     mentioning the balance still due on the day.
  //   • Paid in full — solid BadgeCheck + "Paid in full" + copy
  //     making clear there's nothing left to collect.
  // The flag swap saves the receptionist from chasing a balance
  // that doesn't exist (and the BadgeCheck/Deposit-glyph contrast
  // means a glance is enough).
  if (paid) {
    const fullyPaid = appt.paid_in_full_at_booking;
    return (
      <Card
        padding="lg"
        style={{
          background: theme.color.accentBg,
          border: '1px solid rgba(31, 77, 58, 0.18)',
        }}
      >
        <DetailSectionHeader
          icon={fullyPaid ? <BadgeCheck size={20} aria-hidden /> : <DepositGlyph size={20} />}
          title={fullyPaid ? 'Paid in full' : 'Deposit paid'}
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
            {fullyPaid
              ? `received via ${provider} at booking. Nothing further to collect at the visit.`
              : `received via ${provider} at booking. The remaining bill is settled at the visit.`}
          </span>
        </div>
      </Card>
    );
  }

  // Failed / unknown: keep the deposit framing — staff still need to
  // see the amount that was attempted, and the alert box when failed
  // turns the card into a clear call to action.
  const statusLabel = failed ? 'Failed' : 'Unknown';
  const statusPill = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        padding: '4px 10px',
        borderRadius: theme.radius.pill,
        background: failed ? 'rgba(184, 58, 42, 0.10)' : 'rgba(14, 20, 20, 0.05)',
        color: failed ? theme.color.alert : theme.color.inkMuted,
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
    appt.source !== 'calendly' &&
    (appt.status === 'booked' || appt.status === 'arrived' || appt.status === 'joined');
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
        Open new booking
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
  bottomGap,
}: {
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
  iconBg?: string;
  iconFg?: string;
  /**
   * Override the gap below the header. Defaults to theme.space[4] —
   * the natural separation between the header and the body content
   * that follows. Collapsible cards pass `0` when the body is hidden
   * so the closed-state card doesn't carry a leftover gap that
   * pushes its contents off-centre.
   */
  bottomGap?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginBottom: bottomGap ?? theme.space[4],
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
  reserveIconColumn,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  isFirst?: boolean;
  wrapValue?: boolean;
  /**
   * When true, the row uses the icon-aware grid layout even without
   * an icon — the icon cell is left empty but its 14px track + gap
   * still occupy space. Used by IntakeCard so its rows align column-
   * for-column with BookingDetailsCard's iconned rows. Without this
   * flag the labels would start 26px further left and the values
   * would pull left too, breaking the page's vertical rhythm.
   */
  reserveIconColumn?: boolean;
}) {
  // Single grid template across both cards so values land in the
  // same vertical column. Booking-detail rows pass an icon; intake
  // rows pass reserveIconColumn so the icon track is preserved
  // empty.
  const useIconColumn = !!icon || !!reserveIconColumn;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: useIconColumn
          ? `14px minmax(0, 130px) minmax(0, 1fr)`
          : `minmax(0, 140px) minmax(0, 1fr)`,
        gap: theme.space[3],
        // Top-align so multi-line values (address rows) keep the
        // icon + label on the same line as the value's first row.
        // Baseline alignment looked fine on single-line rows but
        // left the icon centred between lines on multi-line values.
        alignItems: 'start',
        padding: `${theme.space[3]}px 0`,
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      {useIconColumn ? (
        <span
          style={{
            color: theme.color.inkSubtle,
            display: 'inline-flex',
            // 2px nudge so the icon's optical centre lines up with
            // the cap height of the 14px text rather than sitting
            // flush with the top of the row.
            paddingTop: 2,
          }}
        >
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
  isCsOnly,
  onPatientProfile,
  onMarkArrived,
  onJoinMeeting,
  onRejoinMeeting,
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
  // When true, hide clinic-floor actions (mark arrived, mark no-show,
  // reverse no-show). Customer Service staff can still reschedule,
  // cancel, and resend confirmations — those are patient-comms.
  isCsOnly: boolean;
  onPatientProfile: () => void;
  onMarkArrived: () => void;
  onJoinMeeting: () => void;
  onRejoinMeeting: () => void;
  onMarkNoShow: () => void;
  onReschedule: () => void;
  onCancel: () => void;
  onResendConfirmation: () => void;
  onReverseCancellation: () => void;
  onReverseNoShow: () => void;
  onViewRescheduledTo: () => void;
}) {
  // Wrap `actions.includes` with a CS-aware filter: CS-only staff
  // never see mark_arrived / mark_no_show / reverse_no_show, even
  // when availableActions() returned them. Patient-comms actions
  // (reschedule, cancel, resend_confirmation, reverse_cancellation,
  // view_rescheduled_to, join_meeting) pass through unchanged.
  const CS_HIDDEN: ReadonlyArray<AppointmentAction> = [
    'mark_arrived',
    'mark_no_show',
    'reverse_no_show',
  ];
  const has = (a: AppointmentAction) => {
    if (isCsOnly && CS_HIDDEN.includes(a)) return false;
    return actions.includes(a);
  };
  const isFirstAction = !has('join_meeting') && !has('mark_arrived');
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
      {has('join_meeting') ? (
        <ActionRow
          first
          icon={<Video size={16} aria-hidden />}
          label="Join meeting"
          description={appt.join_url ?? undefined}
          onClick={onJoinMeeting}
          accent
        />
      ) : null}
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
        first={isFirstAction}
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
      {has('rejoin_meeting') ? (
        <ActionRow
          icon={<Video size={16} aria-hidden />}
          label="Rejoin meeting"
          description={appt.join_url ?? undefined}
          onClick={onRejoinMeeting}
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
          label="Open new booking"
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
      // Patient-paid deposit on this appointment? We now owe it
      // back. Log the moment with the cancel reason verbatim so the
      // timeline shows WHY we're holding the money against the
      // patient's pocket. Best-effort — the cancellation succeeded
      // regardless.
      if (
        appt.deposit_status === 'paid' &&
        typeof appt.deposit_pence === 'number' &&
        appt.deposit_pence > 0
      ) {
        await recordOwedToPatient({
          patient_id: appt.patient_id,
          trigger: 'appointment_cancelled',
          owed_pence: appt.deposit_pence,
          visit_id: null,
          appointment_id: appt.id,
          reason: `Appointment cancelled: ${trimmedReason}`,
          context: {
            appointment_ref: appt.appointment_ref,
            cancel_reason: trimmedReason,
            deposit_currency: appt.deposit_currency,
            deposit_provider: appt.deposit_provider,
          },
        });
      }
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
    <BottomSheet
      open
      onClose={submitting ? () => undefined : onClose}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Section
          title="Reason"
          required
          sub="Surfaces on the patient timeline and on cancellation reports."
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={submitting}
            placeholder="e.g. Patient asked to push to next week"
            autoFocus
            style={{
              width: '100%',
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              lineHeight: theme.type.leading.normal,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[3],
              color: theme.color.ink,
              background: theme.color.surface,
              outline: 'none',
              resize: 'vertical',
              minHeight: 96,
            }}
          />
        </Section>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontSize: theme.type.size.base,
            color: theme.color.ink,
            cursor: appt.patient.email ? 'pointer' : 'not-allowed',
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
          }}
        >
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            disabled={submitting || !appt.patient.email}
            style={{ width: 18, height: 18 }}
          />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: theme.type.weight.semibold }}>Email the patient</span>
            <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              {appt.patient.email ? appt.patient.email : 'No email on file'}
            </span>
          </span>
        </label>
        {error ? (
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
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
        joinedBeforeNoShow: appt.status === 'joined' || appt.status === 'arrived',
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
        <Section
          title="Reason"
          required
          sub="Surfaces on the patient timeline and on no-show reports."
        >
          <textarea
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={4}
            disabled={submitting}
            placeholder="e.g. Patient called the lab to say they couldn't make it"
            autoFocus
            style={{
              width: '100%',
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[3],
              color: theme.color.ink,
              background: theme.color.surface,
              outline: 'none',
              resize: 'vertical',
              lineHeight: theme.type.leading.normal,
              minHeight: 120,
            }}
          />
          {error ? (
            <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.alert, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
              {error}
            </p>
          ) : null}
        </Section>
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
    <BottomSheet
      open
      onClose={confirming ? () => undefined : onClose}
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
    </BottomSheet>
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

// Banner that appears under the appointment hero when the booking
// has been cancelled but the patient's widget deposit is still on
// file. One click opens the RefundSheet pre-filled with the
// deposit amount and the visit_cancelled category. CS-only staff
// see the banner without the action button (they know to escalate).
function CancelledRefundBanner({
  appt,
  depositRefundedPence,
  depositRefundsLoaded,
  onOpenRefund,
}: {
  appt: AppointmentDetailRow;
  depositRefundedPence: number;
  depositRefundsLoaded: boolean;
  onOpenRefund: () => void;
}) {
  if (appt.status !== 'cancelled') return null;
  if (appt.deposit_status !== 'paid') return null;
  if (!appt.deposit_pence || appt.deposit_pence <= 0) return null;
  // Wait for the refund query so we don't render the banner just to
  // un-render it 200 ms later when the data arrives. Matches the
  // "no load-time flicker" rule used elsewhere on this page.
  if (!depositRefundsLoaded) return null;
  const remaining = Math.max(0, appt.deposit_pence - depositRefundedPence);
  if (remaining <= 0) return null;
  const amount = formatPence(remaining);
  const partiallyRefunded = depositRefundedPence > 0;
  return (
    <div
      role="alert"
      style={{
        marginTop: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: 'rgba(220, 38, 38, 0.08)',
        border: '1px solid rgba(220, 38, 38, 0.30)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: '#991b1b',
          }}
        >
          We owe {appt.patient.first_name ?? 'the patient'} {amount}
        </span>
        <span style={{ fontSize: theme.type.size.xs, color: '#7f1d1d' }}>
          {partiallyRefunded
            ? `Appointment cancelled. ${formatPence(depositRefundedPence)} of the deposit has been refunded so far.`
            : 'Appointment cancelled but the deposit has not been refunded yet.'}
        </span>
      </div>
      {/* Refund button stays available to Customer Service — they
          field the "where's my money" emails. Manager approval
          (email + password) at submit is the real gate. */}
      <Button variant="primary" size="sm" onClick={onOpenRefund}>
        Refund {amount}
      </Button>
    </div>
  );
}
