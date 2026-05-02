import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  List,
  Mail,
  Monitor,
  Pencil,
  Plus,
  ShieldCheck,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  DatePicker,
  Dialog,
  EditBookingSheet,
  EmptyState,
  Input,
  NewBookingSheet,
  RescheduleSheet,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toast,
  WeekStrip,
  WEEK_STRIP_WINDOW_RADIUS_DAYS,
} from '../components/index.ts';
import {
  CalendarGrid,
  layoutAppointments,
  offsetForTime,
  heightForDuration,
} from '../components/CalendarGrid/CalendarGrid.tsx';
import { AppointmentCard, SourceGlyph } from '../components/AppointmentCard/AppointmentCard.tsx';
import { ClusterCard } from '../components/ClusterCard/ClusterCard.tsx';
import { ScheduleListRow, ScheduleListView } from '../components/ScheduleListView/ScheduleListView.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsDesktop, useIsMobile } from '../lib/useIsMobile.ts';
import { useNow } from '../lib/useNow.ts';
import {
  addDaysIso,
  monthLabel,
  todayIso as computeTodayIso,
} from '../lib/calendarMonth.ts';
import {
  type AppointmentRow,
  eventTypeCategory,
  formatBookingSummary,
  formatLateDuration,
  humaniseStatus,
  isAppointmentDimmed,
  isBookingLate,
  minutesPastStart,
  patientDisplayName,
  patientFullDisplayName,
  staffDisplayName,
} from '../lib/queries/appointments.ts';
import { useDayAppointments, useDateRangeCounts } from '../lib/queries/scheduleViews.ts';
import {
  inferServiceTypeFromEventLabel,
  requiredSectionsForServiceTypes,
  summariseWaiverFlag,
  useWaiverSections,
  usePatientWaiverState,
  type WaiverFlag,
} from '../lib/queries/waiver.ts';
import {
  markNoShow,
  markVirtualMeetingJoined,
  type NoShowReason,
  NO_SHOW_REASONS,
  reverseNoShow,
} from '../lib/queries/visits.ts';
import { sendAppointmentConfirmation } from '../lib/queries/sendAppointmentConfirmation.ts';
import { cancelAppointment } from '../lib/queries/cancelAppointment.ts';
import { useCurrentLocation } from '../lib/queries/locations.ts';

type Layout = 'calendar' | 'list';
const LAYOUT_KEY = 'lounge.scheduleLayout';

export function Schedule() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const isDesktop = useIsDesktop();
  const now = useNow();
  const todayIso = computeTodayIso(now);

  // `selectedDate` is the source-of-truth for which day is showing.
  // We mirror it into a `?date=YYYY-MM-DD` URL search param so:
  //   • the browser back button restores the day the receptionist was
  //     viewing when they navigated into an appointment / visit page,
  //   • breadcrumb back-from-detail can include the date and land on
  //     the same day,
  //   • a refresh or shared link still opens on the right day.
  // Today is the default; we keep the URL clean (no ?date=) when on
  // today so /schedule remains the canonical "now" link.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlDate = searchParams.get('date');
  const validUrlDate = urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate) ? urlDate : null;
  const selectedDate = validUrlDate ?? todayIso;
  const setSelectedDate = useCallback(
    (next: string | ((prev: string) => string)) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          const current = params.get('date');
          const validCurrent =
            current && /^\d{4}-\d{2}-\d{2}$/.test(current) ? current : todayIso;
          const resolved = typeof next === 'function' ? next(validCurrent) : next;
          if (resolved === todayIso) {
            params.delete('date');
          } else {
            params.set('date', resolved);
          }
          return params;
        },
        // Replace, not push, so flicking through the strip doesn't
        // pile a history entry per day. Browser back should hop back
        // to the page-before-Schedule, not to the previous date.
        { replace: true },
      );
    },
    [setSearchParams, todayIso],
  );
  const [layout, setLayout] = useState<Layout>(() => {
    if (typeof window === 'undefined') return 'calendar';
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    return saved === 'list' || saved === 'calendar' ? saved : 'calendar';
  });

  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const [clusterRows, setClusterRows] = useState<AppointmentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True when staff has tapped "No-show" inside the BottomSheet and we're
  // waiting for them to pick a reason. Cleared on cancel or successful submit.
  const [pickingNoShowReason, setPickingNoShowReason] = useState(false);
  // The appointment currently being rescheduled. When non-null the
  // RescheduleSheet renders on top of the existing detail sheet
  // (BottomSheet stacking is handled by their respective z-indices).
  const [reschedulingRow, setReschedulingRow] = useState<AppointmentRow | null>(null);
  // "Resend confirmation" toast state — separate from the generic
  // error toast so a success ("Sent to patient@example.com") and a
  // failure ("Email delivery not configured") can render with the
  // right tone without us reusing the error rail for both.
  const [confirmationToast, setConfirmationToast] = useState<
    { tone: 'success' | 'error' | 'info'; title: string; description?: string } | null
  >(null);
  const [resendingConfirmationId, setResendingConfirmationId] = useState<string | null>(null);
  // ISO datetime of the empty slot the operator just tapped. When
  // non-null the NewBookingSheet renders pre-filled with this time.
  const [newBookingSlot, setNewBookingSlot] = useState<string | null>(null);
  // The row currently being cancelled, if any. When set, a confirm
  // dialog renders on top of the detail sheet asking for an optional
  // reason and an explicit "Yes, cancel" tap. Discrete from
  // reschedulingRow because the two flows shouldn't share state.
  const [cancellingRow, setCancellingRow] = useState<AppointmentRow | null>(null);
  // The row currently being edited (notes / staff). Discrete from
  // reschedulingRow because edit-in-place doesn't move the slot —
  // time changes still go through reschedule.
  const [editingRow, setEditingRow] = useState<AppointmentRow | null>(null);
  const currentLocation = useCurrentLocation();
  // "Jump to date" picker — anchored to the month-label pill so the
  // operator can leap to any date without flicking through weeks.
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const monthPillRef = useRef<HTMLButtonElement | null>(null);

  const day = useDayAppointments(selectedDate);
  // Counts power the dots under each day pill in the WeekStrip. The
  // strip materialises every day in a ±60 day window around today, so
  // this query matches that window — earlier this only fetched the
  // selected week, which left dots missing on adjacent weeks even
  // when those days had bookings. The query is a small aggregate
  // (just date+status), so a 121-day fetch is cheap.
  const stripStartIso = addDaysIso(todayIso, -WEEK_STRIP_WINDOW_RADIUS_DAYS);
  const stripEndIso = addDaysIso(todayIso, WEEK_STRIP_WINDOW_RADIUS_DAYS);
  const weekCounts = useDateRangeCounts(stripStartIso, stripEndIso);

  // Waiver state for the selected patient. Sections are global; signatures
  // are per-patient. Pre-arrival the "required sections" are inferred from
  // the booking's event_type_label only — once a cart exists the visit
  // page does the more accurate cart-item resolution.
  const { sections: waiverSections } = useWaiverSections();
  const { latest: patientSignatures } = usePatientWaiverState(selected?.patient_id);
  const waiverFlag: WaiverFlag | null = (() => {
    if (!selected) return null;
    if (waiverSections.length === 0) return null;
    // Virtual impression appointments never take a physical impression in
    // clinic, so the waiver isn't applicable at this booking. The patient
    // still needs to sign for any future in-person follow-up — that's
    // handled by the next in-person appointment's intake gate.
    if (selected.join_url) return null;
    const inferred = inferServiceTypeFromEventLabel(selected.event_type_label);
    const required = requiredSectionsForServiceTypes(
      inferred ? [inferred] : [],
      waiverSections
    );
    return summariseWaiverFlag(required, patientSignatures);
  })();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAYOUT_KEY, layout);
    }
  }, [layout]);

  // Auto-switch to list when the selected day is dense and the user
  // hasn't expressed a preference yet.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    if (!saved && day.data.length > 8) {
      setLayout('list');
    }
  }, [day.data.length]);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const closeSheet = () => {
    setSelected(null);
    setClusterRows(null);
    setPickingNoShowReason(false);
  };

  const handleSelectDate = (dateIso: string) => {
    setSelectedDate(dateIso);
  };

  // Chevrons either side of the date strip used to step a full week
  // (delta * 7). Receptionists asked for a day-at-a-time step so they
  // can scrub through the strip more precisely — the strip's natural
  // scroll-snap still moves them by week-equivalents when they
  // flick across it.
  const handleShiftDay = (delta: number) => {
    setSelectedDate((prev) => addDaysIso(prev, delta));
  };

  const handleJumpToToday = () => {
    setSelectedDate(todayIso);
  };

  // (openAppointment was removed when the Schedule's bottom sheet
  // was restored — clicks open the in-place sheet again. The
  // AppointmentDetail page is reached via the Ledger; Schedule's
  // job is the daily-ops view, where a sheet over the calendar is
  // a faster gesture than a full route change.)

  const onToday = selectedDate === todayIso;
  const dayHeading = formatDayHeading(selectedDate);
  // Toolbar label follows the selected day's month (not the week's), so it
  // flips Apr→May the moment the receptionist taps a day in the next month
  // (e.g. selecting Fri 1 in a Mon-Sun strip that started in April).
  const selectedYear = Number(selectedDate.slice(0, 4));
  const selectedMonth = Number(selectedDate.slice(5, 7)) - 1;
  const toolbarLabel = monthLabel(selectedYear, selectedMonth);

  // Calendar grid expands to cover whatever's actually scheduled.
  // Default 8 am → 7 pm; if any appointment starts before 8 or ends
  // after 7 pm, the bounds extend so cards never orphan below the
  // grid (the bug shown in the 29 Apr screenshot where 7:54 pm and
  // 8:45 pm walk-ins fell outside the visible range).
  const { startHour, endHour } = (() => {
    let s = 8;
    let e = 19;
    for (const r of day.data) {
      const start = new Date(r.start_at);
      const end = new Date(r.end_at);
      if (!Number.isNaN(start.getTime())) {
        s = Math.min(s, start.getHours());
      }
      if (!Number.isNaN(end.getTime())) {
        const endH = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
        e = Math.max(e, endH);
      }
    }
    return { startHour: Math.max(0, s), endHour: Math.min(24, e) };
  })();

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        {/* Header structure (top → bottom):
            Row 1: month label centred.
            Row 2: chevrons flank the WeekStrip (40px / 1fr / 40px grid).
            Row 3: selected-day heading on the left; "Today" pill (when
                   not on today's week) + calendar/list segmented
                   control on the right.
            The chevrons live with the strip so week-navigation reads
            as one unit. The view toggle and Today pill live with the
            day heading because both change what's shown for *this
            day*. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: theme.space[3],
          }}
        >
          <button
            ref={monthPillRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={datePickerOpen}
            aria-label={`${toolbarLabel}, jump to a different date`}
            onClick={() => setDatePickerOpen((v) => !v)}
            style={{
              appearance: 'none',
              border: `1px solid ${datePickerOpen ? theme.color.ink : 'transparent'}`,
              background: 'transparent',
              padding: `${theme.space[1]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.pill,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              color: theme.color.inkMuted,
              fontFamily: 'inherit',
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              whiteSpace: 'nowrap',
              transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
          >
            <CalendarDays size={12} aria-hidden />
            <span aria-live="polite">{toolbarLabel}</span>
            <ChevronDown size={12} aria-hidden />
          </button>
        </div>
        <DatePicker
          open={datePickerOpen}
          onClose={() => setDatePickerOpen(false)}
          value={selectedDate}
          onChange={(iso) => handleSelectDate(iso)}
          anchorRef={monthPillRef}
          title="Jump to a date"
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '40px 1fr 40px',
            alignItems: 'center',
            gap: theme.space[2],
            marginBottom: theme.space[5],
          }}
        >
          <IconNavButton ariaLabel="Previous day" onClick={() => handleShiftDay(-1)}>
            <ChevronLeft size={20} />
          </IconNavButton>
          <WeekStrip
            selectedIso={selectedDate}
            todayIso={todayIso}
            counts={weekCounts.counts}
            onSelect={handleSelectDate}
            loading={weekCounts.loading}
          />
          <IconNavButton ariaLabel="Next day" onClick={() => handleShiftDay(1)}>
            <ChevronRight size={20} />
          </IconNavButton>
        </div>

        {/* Selected-day section heading. View toggle on the right. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[4],
            marginBottom: theme.space[3],
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: theme.space[3],
              flexWrap: 'wrap',
              minWidth: 0,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              {dayHeading}
            </h2>
            <span
              style={{
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
                // Stale count would lie about the day; suppress until the
                // refetch settles. Once we have any prior data, holding back
                // the count for ~150ms feels less janky than flicker.
                opacity: day.loading && day.hasLoaded ? 0 : 1,
                transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
            >
              {day.data.length === 0
                ? 'No appointments'
                : `${day.data.length} appointment${day.data.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              flexShrink: 0,
            }}
          >
            {!onToday ? (
              <TodayPill onClick={handleJumpToToday} />
            ) : null}
            <SegmentedControl<Layout>
              ariaLabel="Day view layout"
              value={layout}
              onChange={setLayout}
              size="sm"
              options={[
                {
                  value: 'calendar',
                  label: <CalendarDays size={16} aria-label="Calendar view" />,
                },
                {
                  value: 'list',
                  label: <List size={16} aria-label="List view" />,
                },
              ]}
            />
          </div>
        </div>

        <Card padding={isMobile ? 'sm' : 'md'}>
          {day.loading && !day.hasLoaded ? (
            <SkeletonRows />
          ) : (
            <DayReloadingWrapper loading={day.loading}>
              {day.data.length === 0 ? (
            <EmptyState
              icon={<CalendarOff size={24} />}
              title={onToday ? 'No appointments today' : 'Nothing on this day'}
              description={
                onToday
                  ? 'Book a new appointment, tap New walk-in when someone arrives, or wait for Calendly bookings to land.'
                  : 'Book a new appointment for this day, or pick another above.'
              }
              action={
                currentLocation.data ? (
                  <Button
                    variant="primary"
                    onClick={() => setNewBookingSlot(defaultBookingIso(selectedDate, startHour))}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                      <Plus size={16} aria-hidden /> Book new appointment
                    </span>
                  </Button>
                ) : undefined
              }
            />
          ) : layout === 'list' ? (
            <ScheduleListView rows={day.data} onPick={setSelected} />
          ) : (
            <div style={{ paddingTop: theme.space[2] }}>
              <CalendarGrid
                showNowIndicator={onToday}
                startHour={startHour}
                endHour={endHour}
                isoDate={selectedDate}
                onEmptyTap={
                  currentLocation.data
                    ? (iso) => setNewBookingSlot(iso)
                    : undefined
                }
              >
                {layoutAppointments(day.data).map((item) =>
                  item.kind === 'card' ? (
                    <AppointmentCard
                      key={item.data.id}
                      patientName={patientDisplayName(item.data)}
                      startAt={item.data.start_at}
                      endAt={item.data.end_at}
                      status={item.data.status}
                      staffName={staffDisplayName(item.data)}
                      serviceLabel={formatBookingSummary(item.data) || undefined}
                      top={offsetForTime(item.data.start_at, startHour, 80)}
                      height={heightForDuration(item.data.start_at, item.data.end_at, 80)}
                      lane={item.lane}
                      lanesInGroup={item.lanesInGroup}
                      barColor={theme.category[eventTypeCategory(item.data.event_type_label)]}
                      source={item.data.source}
                      lateMinutes={
                        onToday &&
                        item.data.status === 'booked' &&
                        new Date(item.data.end_at).getTime() > now.getTime() &&
                        isBookingLate(item.data.start_at, now)
                          ? minutesPastStart(item.data.start_at, now)
                          : null
                      }
                      dimmed={isAppointmentDimmed(item.data, now)}
                      onClick={() => setSelected(item.data)}
                    />
                  ) : (
                    <ClusterCard
                      key={item.key}
                      count={item.rows.length}
                      startAt={item.startAt}
                      endAt={item.endAt}
                      firstNames={item.rows.map((r) => firstNameOf(patientDisplayName(r)))}
                      top={offsetForTime(item.startAt, startHour, 80)}
                      height={heightForDuration(item.startAt, item.endAt, 80)}
                      onClick={() => setClusterRows(item.rows)}
                    />
                  )
                )}
              </CalendarGrid>
            </div>
          )}
            </DayReloadingWrapper>
          )}
        </Card>

        <p
          style={{
            marginTop: theme.space[6],
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            textAlign: 'center',
          }}
        >
          Lounge v0.7 · {user.email}
        </p>
      </div>

      {selected || clusterRows ? (
        <BottomSheet
          open={true}
          onClose={closeSheet}
          // Header back chevron unifies the two pop-back affordances:
          //   - In reason picker → back to the patient detail
          //   - In a cluster-driven detail → back to the cluster list
          // Otherwise no back button — close-X is the only escape.
          onBack={
            pickingNoShowReason
              ? () => setPickingNoShowReason(false)
              : selected && clusterRows
                ? () => setSelected(null)
                : undefined
          }
          title={
            pickingNoShowReason
              ? 'Why was this a no-show?'
              : selected
                ? patientFullDisplayName(selected)
                : `${clusterRows!.length} appointments`
          }
          description={
            pickingNoShowReason ? (
              <span>Pick the reason. We log it against the appointment so reports show no-show causes.</span>
            ) : selected ? (
              // Single line: source glyph + day + start time + staff.
              // Email and phone are not surfaced here — they live on
              // the patient profile, which the receptionist can open
              // from the visit page if needed. End time is dropped
              // too: the duration is fixed per booking type and the
              // start is what staff actually scan for.
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <SourceGlyph source={selected.source} size={13} />
                <span>
                  {selected.source === 'manual' ? 'Walk-in · ' : ''}
                  {formatStart(selected.start_at)}
                  {staffDisplayName(selected) ? ` · with ${staffDisplayName(selected)}` : ''}
                </span>
              </span>
            ) : (
              <span>{formatClusterRange(clusterRows!)}</span>
            )
          }
          footer={
            pickingNoShowReason ? null : !selected ? null : (
              <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {(() => {
                  const isVirtual = !!selected.join_url;
                  const status = selected.status;
                  // Virtual no-show is desktop-only. Staff need to
                  // have actually attempted the Google Meet to know
                  // whether the patient connected, and that flow
                  // lives on the desktop. From a tablet there's no
                  // legitimate way to verify attendance, so hide the
                  // button outright instead of letting it sit there
                  // as a temptation. Same for the Join Meeting
                  // button, which is wired to a desktop window.open.
                  const isVirtualOnNonDesktop = isVirtual && !isDesktop;
                  const showNoShow =
                    !isVirtualOnNonDesktop &&
                    (status === 'booked' || (isVirtual && status === 'arrived'));
                  const showVirtualJoin =
                    isVirtual &&
                    isDesktop &&
                    (status === 'booked' || status === 'arrived' || status === 'no_show');
                  const showMarkArrived = !isVirtual && status === 'booked';
                  const showCloseOnly =
                    !showNoShow && !showVirtualJoin && !showMarkArrived && status !== 'no_show';
                  if (showCloseOnly) {
                    return (
                      <Button variant="secondary" onClick={closeSheet}>
                        Close
                      </Button>
                    );
                  }
                  const joinLabel =
                    status === 'arrived' || status === 'no_show' ? 'Re-join meeting' : 'Join meeting';
                  const showUndoNoShow = status === 'no_show';
                  return (
                    <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
                      {showUndoNoShow ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          loading={busy}
                          onClick={async () => {
                            if (!selected) return;
                            setBusy(true);
                            try {
                              // Flip the appointment status back so the
                              // receptionist can use the normal
                              // Mark-as-arrived flow (intake, JB ref,
                              // waivers). The earlier behaviour bounced
                              // straight to /visit, skipping all of that.
                              await reverseNoShow(selected.id);
                              setSelected(null);
                              day.refresh();
                              weekCounts.refresh();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not undo no-show');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Undo no-show
                        </Button>
                      ) : null}
                      {showNoShow ? (
                        (() => {
                          const late = status === 'booked' && isBookingLate(selected.start_at, now);
                          return (
                            <Button
                              variant={late ? 'primary' : 'secondary'}
                              disabled={busy}
                              onClick={() => setPickingNoShowReason(true)}
                            >
                              No-show
                            </Button>
                          );
                        })()
                      ) : null}
                      {showVirtualJoin ? (
                        <Button
                          variant="primary"
                          loading={busy}
                          onClick={async () => {
                            if (!selected || !selected.join_url) return;
                            window.open(selected.join_url, '_blank', 'noopener,noreferrer');
                            if (status === 'arrived' || status === 'no_show') return;
                            setBusy(true);
                            try {
                              await markVirtualMeetingJoined(selected.id);
                              setSelected(null);
                              day.refresh();
                              weekCounts.refresh();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not record join');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                            <Video size={16} /> {joinLabel}
                          </span>
                        </Button>
                      ) : null}
                      {showMarkArrived ? (
                        <Button
                          variant="primary"
                          showArrow
                          onClick={() => {
                            if (!selected) return;
                            // Hand off to the four-step arrival wizard.
                            // The in-place ArrivalIntakeSheet is gone —
                            // a customer-facing flow needs more visual
                            // room than a bottom sheet allows.
                            navigate(`/arrival/appointment/${selected.id}`);
                          }}
                        >
                          Mark as arrived
                        </Button>
                      ) : null}
                    </div>
                  );
                })()}
              </div>
            )
          }
        >
          {pickingNoShowReason && selected ? (
            <NoShowReasonPicker
              busy={busy}
              onPick={async (reason) => {
                if (!selected) return;
                const isVirtual = !!selected.join_url;
                setBusy(true);
                try {
                  await markNoShow(selected.id, reason, {
                    patientId: selected.patient_id,
                    wasVirtual: isVirtual,
                    joinedBeforeNoShow: selected.status === 'arrived',
                  });
                  setPickingNoShowReason(false);
                  setSelected(null);
                  day.refresh();
                  weekCounts.refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not mark no-show');
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : !selected && clusterRows ? (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[2],
              }}
            >
              {clusterRows.map((r) => (
                <ScheduleListRow
                  key={r.id}
                  row={r}
                  now={now}
                  // Keep clusterRows set so the BottomSheet stays mounted
                  // and morphs into detail mode in place — no second
                  // popup.
                  onPick={() => setSelected(r)}
                />
              ))}
            </ul>
          ) : selected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                  <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Status</span>
                  <StatusPill tone={statusToTone(selected.status)} size="sm">
                    {humaniseStatus(selected.status)}
                  </StatusPill>
                  {waiverFlag ? (
                    <StatusPill
                      tone={waiverFlag.status === 'ready' ? 'arrived' : 'pending'}
                      size="sm"
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ShieldCheck size={12} aria-hidden />
                        {waiverFlag.status === 'ready' ? 'Waiver signed' : 'Waiver pending'}
                      </span>
                    </StatusPill>
                  ) : null}
                </div>

                {selected.deposit_pence != null && selected.deposit_status ? (
                <DepositLine
                  status={selected.deposit_status}
                  amountPence={selected.deposit_pence}
                  provider={selected.deposit_provider}
                />
              ) : null}
              </div>

              {selected.status === 'booked' && isBookingLate(selected.start_at, now) ? (
                <div
                  style={{
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    background: 'rgba(184, 58, 42, 0.08)',
                    border: `1px solid ${theme.color.alert}`,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    color: theme.color.ink,
                  }}
                >
                  <AlertTriangle size={20} color={theme.color.alert} aria-hidden style={{ flexShrink: 0 }} />
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
                    <strong>{formatLateDuration(minutesPastStart(selected.start_at, now))} late.</strong>{' '}
                    {/* For virtual bookings on a non-desktop the
                        No-show button isn't rendered, so don't
                        promise it here — point staff at the
                        desktop instead. */}
                    {selected.join_url
                      ? isDesktop
                        ? 'If they have not connected, tap No-show.'
                        : 'If they have not connected, mark No-show from a desktop browser.'
                      : 'If they have not turned up, tap No-show.'}
                  </p>
                </div>
              ) : null}

              {selected.join_url && !isDesktop ? (
                <div
                  style={{
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    background: theme.color.accentBg,
                    border: `1px solid ${theme.color.accent}`,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                    color: theme.color.ink,
                  }}
                >
                  <Monitor size={20} color={theme.color.accent} aria-hidden style={{ flexShrink: 0 }} />
                  {/* Both joining the meeting and marking no-show
                      require staff to verify attendance through the
                      desktop Google Meet flow, so both buttons are
                      hidden on non-desktop. The notice has to make
                      that obvious — earlier copy implied no-show
                      was tablet-friendly, which it isn't. */}
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
                    Virtual appointment. Open <strong>lounge.venneir.com</strong> on a desktop to join the meeting and mark attendance. No-show can only be flagged from there too.
                  </p>
                </div>
              ) : null}

              {formatBookingSummary(selected) ? (
                (() => {
                  // When the virtual-appointment notice above is also
                  // showing (mobile virtual booking), quiet down this
                  // card so the actionable notice keeps the visual
                  // high ground. Otherwise show the full accent card
                  // — booking details ARE the primary info on every
                  // other path.
                  const sharingSpaceWithVirtualNotice =
                    !!selected.join_url && !isDesktop;
                  return (
                    <div
                      style={{
                        padding: `${theme.space[3]}px ${theme.space[4]}px`,
                        background: sharingSpaceWithVirtualNotice
                          ? 'rgba(232, 245, 236, 0.4)'
                          : theme.color.accentBg,
                        border: sharingSpaceWithVirtualNotice
                          ? `1px solid ${theme.color.border}`
                          : `1px solid ${theme.color.accent}`,
                        borderRadius: 12,
                      }}
                    >
                      <p
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkMuted,
                          fontWeight: theme.type.weight.medium,
                          textTransform: 'uppercase',
                          letterSpacing: theme.type.tracking.wide,
                          marginBottom: theme.space[1],
                        }}
                      >
                        Booking details
                      </p>
                      <p
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.lg,
                          fontWeight: theme.type.weight.semibold,
                          color: theme.color.ink,
                          lineHeight: theme.type.leading.snug,
                        }}
                      >
                        {formatBookingSummary(selected)}
                      </p>
                    </div>
                  );
                })()
              ) : null}

              {hasMeaningfulNotes(selected.notes) ? (
                <div
                  style={{
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    background: theme.color.surface,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 12,
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      fontWeight: theme.type.weight.medium,
                      textTransform: 'uppercase',
                      letterSpacing: theme.type.tracking.wide,
                      marginBottom: theme.space[1],
                    }}
                  >
                    Notes
                  </p>
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      lineHeight: theme.type.leading.relaxed,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {selected.notes}
                  </p>
                </div>
              ) : null}

              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                {selected.status === 'booked'
                  ? selected.join_url
                    ? 'Tap Join meeting on a desktop when the call begins. Mark no-show 15 min after the start time if they have not connected.'
                    : 'Mark arrived when the patient is at the desk. Mark no-show 15 min after the start time if they have not turned up.'
                  : selected.status === 'arrived' && selected.join_url
                    ? 'You joined the meeting. If the patient does not connect, mark them as a no-show.'
                    : selected.status === 'no_show'
                      ? selected.join_url
                        ? 'Marked as a no-show. Re-join the meeting if they turn up late, then tap "Patient attended" to amend.'
                        : 'Marked as a no-show. If the patient turned up late, tap "Patient attended" to flip them back to arrived and open the appointment.'
                      : selected.status === 'rescheduled'
                        ? 'This booking was rescheduled in Calendly.'
                        : selected.status === 'cancelled'
                          ? 'This booking was cancelled in Calendly.'
                          : ''}
              </p>

              <DetailQuickActions
                appointment={selected}
                resendingConfirmationId={resendingConfirmationId}
                onViewAppointment={() => {
                  navigate(`/appointment/${selected.id}`, {
                    state: {
                      from: 'schedule',
                      patientId: selected.patient_id,
                      patientName: patientFullDisplayName(selected),
                      // Forward the day the receptionist was viewing
                      // so the breadcrumb back-link lands on it instead
                      // of bouncing them to today.
                      scheduleDate: selectedDate,
                    },
                  });
                }}
                onPatientProfile={() => {
                  navigate(`/patient/${selected.patient_id}`, {
                    state: {
                      from: 'schedule',
                      patientName: patientDisplayName(selected),
                      // Forward the day the receptionist was viewing
                      // so the back-link returns to the same day.
                      scheduleDate: selectedDate,
                    },
                  });
                }}
                onEdit={() => setEditingRow(selected)}
                onReschedule={() => setReschedulingRow(selected)}
                onCancel={() => setCancellingRow(selected)}
                onResendConfirmation={async () => {
                  const target = selected;
                  setResendingConfirmationId(target.id);
                  const result = await sendAppointmentConfirmation({
                    appointmentId: target.id,
                  });
                  setResendingConfirmationId(null);
                  if (result.ok) {
                    setConfirmationToast({
                      tone: 'success',
                      title: 'Confirmation sent',
                      description: result.recipient,
                    });
                  } else if (result.reason === 'no_email_on_patient') {
                    setConfirmationToast({
                      tone: 'info',
                      title: 'No email on file for this patient',
                    });
                  } else if (result.reason === 'delivery_not_configured') {
                    setConfirmationToast({
                      tone: 'error',
                      title: 'Email delivery not configured',
                      description: 'Set RESEND_API_KEY on the edge function.',
                    });
                  } else {
                    setConfirmationToast({
                      tone: 'error',
                      title: 'Could not send',
                      description: result.error,
                    });
                  }
                }}
              />
            </div>
          ) : null}
        </BottomSheet>
      ) : null}

      {reschedulingRow ? (
        <RescheduleSheet
          open
          appointment={{
            id: reschedulingRow.id,
            patient_id: reschedulingRow.patient_id,
            location_id: reschedulingRow.location_id,
            // service_type was added to lng_appointments in
            // 20260501000005 but the AppointmentRow shape predates
            // it — we narrow + best-effort-cast here. New native
            // bookings written by this very flow will set it; legacy
            // Calendly imports were backfilled to 'other' if no
            // pattern matched.
            service_type:
              ((reschedulingRow as unknown as { service_type?: string | null }).service_type ?? null) as
                | 'denture_repair'
                | 'click_in_veneers'
                | 'same_day_appliance'
                | 'impression_appointment'
                | 'other'
                | null,
            source: reschedulingRow.source,
            start_at: reschedulingRow.start_at,
            end_at: reschedulingRow.end_at,
            patient_first_name: reschedulingRow.patient_first_name,
            patient_last_name: reschedulingRow.patient_last_name,
          }}
          onClose={() => setReschedulingRow(null)}
          onRescheduled={() => {
            setReschedulingRow(null);
            setSelected(null);
            day.refresh();
            weekCounts.refresh();
          }}
        />
      ) : null}

      {editingRow ? (
        <EditBookingSheet
          open
          appointment={{
            id: editingRow.id,
            patient_id: editingRow.patient_id,
            location_id: editingRow.location_id,
            source: editingRow.source,
            start_at: editingRow.start_at,
            end_at: editingRow.end_at,
            notes: editingRow.notes,
            staff_account_id: editingRow.staff_account_id,
            patient_first_name: editingRow.patient_first_name,
            patient_last_name: editingRow.patient_last_name,
          }}
          onClose={() => setEditingRow(null)}
          onSaved={() => {
            setEditingRow(null);
            setSelected(null);
            day.refresh();
            setConfirmationToast({
              tone: 'success',
              title: 'Changes saved',
            });
          }}
        />
      ) : null}

      {cancellingRow ? (
        <CancelAppointmentDialog
          appointment={cancellingRow}
          onClose={() => setCancellingRow(null)}
          onCancelled={(info) => {
            setCancellingRow(null);
            setSelected(null);
            day.refresh();
            weekCounts.refresh();
            if (info.emailSent) {
              setConfirmationToast({
                tone: 'success',
                title: 'Appointment cancelled',
                description: 'Cancellation email sent to the patient.',
              });
            } else if (info.emailReason === 'no_email_on_patient') {
              setConfirmationToast({
                tone: 'info',
                title: 'Appointment cancelled',
                description: 'No email on file, so no cancellation was sent.',
              });
            } else if (info.emailReason === 'delivery_not_configured') {
              setConfirmationToast({
                tone: 'info',
                title: 'Appointment cancelled',
                description: 'Email delivery is not configured on the server.',
              });
            } else if (info.emailReason) {
              setConfirmationToast({
                tone: 'info',
                title: 'Appointment cancelled',
                description: `Cancellation email did not send: ${info.emailReason}.`,
              });
            } else {
              setConfirmationToast({
                tone: 'success',
                title: 'Appointment cancelled',
              });
            }
          }}
        />
      ) : null}

      {newBookingSlot && currentLocation.data ? (
        <NewBookingSheet
          open
          initialIso={newBookingSlot}
          locationId={currentLocation.data.id}
          onClose={() => setNewBookingSlot(null)}
          onCreated={(_id, info) => {
            setNewBookingSlot(null);
            day.refresh();
            weekCounts.refresh();
            // Single confirmation toast that captures both "booking
            // saved" and the email outcome — keeps the operator from
            // having to read two separate toasts in sequence.
            if (info.emailSent) {
              setConfirmationToast({
                tone: 'success',
                title: 'Booking added',
                description: 'Confirmation email sent to the patient.',
              });
            } else if (info.emailReason === 'no_email_on_patient') {
              setConfirmationToast({
                tone: 'info',
                title: 'Booking added',
                description: 'No email on file, so no confirmation was sent.',
              });
            } else if (info.emailReason === 'delivery_not_configured') {
              setConfirmationToast({
                tone: 'info',
                title: 'Booking added',
                description: 'Email delivery is not configured on the server.',
              });
            } else if (info.emailReason) {
              setConfirmationToast({
                tone: 'info',
                title: 'Booking added',
                description: `Confirmation email did not send: ${info.emailReason}.`,
              });
            } else {
              setConfirmationToast({ tone: 'success', title: 'Booking added' });
            }
          }}
        />
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not update" description={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      {confirmationToast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast
            tone={confirmationToast.tone}
            title={confirmationToast.title}
            description={confirmationToast.description}
            onDismiss={() => setConfirmationToast(null)}
          />
        </div>
      ) : null}
    </main>
  );
}

// Pill button that returns the strip to this week. Only rendered
// when the receptionist has navigated off today (the schedule lands
// on today by default).
//
// Wording: "Jump to today" reads unambiguously as an action. An
// earlier version used a leading accent dot + "Today" — but the dot
// looked like a status badge ("this is today"), which was the
// opposite of what it does. Dropped the dot and led with a verb so
// the button is action-shaped, not status-shaped.
//
// Visual: 32px tall to line up with the SegmentedControl beside it.
// Surface fill + 1px border. Hover tints to bg; no green halo.
function TodayPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Jump to today"
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = theme.color.bg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = theme.color.surface;
      }}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        color: theme.color.ink,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        height: 32,
        padding: `0 ${theme.space[4]}px`,
        borderRadius: theme.radius.pill,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        WebkitTapHighlightColor: 'transparent',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      Jump to today
    </button>
  );
}

function IconNavButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: theme.color.ink,
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'rgba(14, 20, 20, 0.05)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

function firstNameOf(fullName: string): string {
  const trimmed = fullName.trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

// Holds the previous day's content visible (dimmed) while a refetch is
// in flight, so day-switching cross-fades instead of flashing a skeleton.
// On the very first paint the parent renders a skeleton instead — once
// hasLoaded is true, this wrapper takes over.
function DayReloadingWrapper({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-busy={loading || undefined}
      style={{
        opacity: loading ? 0.45 : 1,
        transition: `opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
      }}
    >
      {children}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3], padding: theme.space[2] }}>
      <Skeleton height={56} radius={12} />
      <Skeleton height={56} radius={12} />
      <Skeleton height={56} radius={12} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DetailQuickActions — secondary navigation rows shown inside the
// appointment-detail BottomSheet's body. Replaces the cramped
// inline footer that was trying to fit Patient profile + Reschedule
// + Resend confirmation alongside the primary action; now each
// gets a full-width tap-target row in the body, the footer
// stays focused on the primary status action.
//
// Conditional rules per the original footer:
//   Patient profile        always shown
//   Reschedule             native source + status='booked'
//                          (Calendly-source rows reschedule on
//                          Calendly itself per the working
//                          agreement; we surface that as a hint)
//   Resend confirmation    native source + status='booked' + has
//                          patient_email
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CancelAppointmentDialog — confirmation dialog for the destructive
// "cancel this appointment" path. Renders on top of the detail
// BottomSheet (zIndex 1000). Optional reason field is stored on
// lng_appointments.cancel_reason and surfaced on the patient
// timeline event. The patient gets a cancellation email with a
// CANCEL .ics so their calendar removes the slot — best-effort,
// the cancel still commits if the email fails.
//
// Two-step UX (open → explicit confirm) is the right pattern for
// destructive actions; an inline tap on the action row would let
// staff cancel by accident.
// ─────────────────────────────────────────────────────────────────────────────

function CancelAppointmentDialog({
  appointment,
  onClose,
  onCancelled,
}: {
  appointment: AppointmentRow;
  onClose: () => void;
  onCancelled: (info: { emailSent: boolean; emailReason: string | null }) => void;
}) {
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patientName = patientFullDisplayName(appointment);
  const hasEmail = !!appointment.patient_email;

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await cancelAppointment({
        appointmentId: appointment.id,
        reason,
        notifyPatient: hasEmail,
      });
      onCancelled({ emailSent: result.emailSent, emailReason: result.emailReason });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      width={460}
      title="Cancel this appointment?"
      description={
        <span>
          {patientName}'s appointment on{' '}
          <strong>{formatStart(appointment.start_at)}</strong> will be cancelled.
          {hasEmail
            ? ` We'll email ${appointment.patient_email} a calendar update so the slot drops off their calendar.`
            : ` There's no email on file for this patient, so no cancellation email will be sent.`}{' '}
          The slot will return to available immediately.
        </span>
      }
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Keep appointment
          </Button>
          <Button variant="primary" onClick={handleConfirm} loading={busy}>
            {busy ? 'Cancelling…' : 'Cancel appointment'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Input
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. patient phoned to cancel; clinic equipment fault."
          disabled={busy}
        />
        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.alert,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function DetailQuickActions({
  appointment,
  resendingConfirmationId,
  onViewAppointment,
  onPatientProfile,
  onEdit,
  onReschedule,
  onCancel,
  onResendConfirmation,
}: {
  appointment: AppointmentRow;
  resendingConfirmationId: string | null;
  onViewAppointment: () => void;
  onPatientProfile: () => void;
  onEdit: () => void;
  onReschedule: () => void;
  onCancel: () => void;
  onResendConfirmation: () => void;
}) {
  // Edit-in-place: native source + status='booked'. Adjusts notes
  // and staff without touching the slot — for time changes the
  // operator uses Reschedule instead.
  const showEdit =
    appointment.status === 'booked' && appointment.source !== 'calendly';
  const showReschedule =
    appointment.status === 'booked' && appointment.source !== 'calendly';
  const calendlyHintInline =
    appointment.status === 'booked' && appointment.source === 'calendly';
  const showResendConfirmation =
    appointment.status === 'booked' &&
    appointment.source !== 'calendly' &&
    !!appointment.patient_email;
  // Cancel is allowed on booked or arrived (rare — patient changed
  // their mind on the way to the chair). Native source only;
  // Calendly-source bookings cancel on Calendly itself.
  const showCancel =
    (appointment.status === 'booked' || appointment.status === 'arrived') &&
    appointment.source !== 'calendly';
  const sendingThis = resendingConfirmationId === appointment.id;

  return (
    <section
      aria-label="Other actions"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        overflow: 'hidden',
      }}
    >
      {/* View full appointment — opens /appointment/:id, which itself
          redirects to /visit/:id when a visit exists. Sits at the
          top of the action list so the receptionist sees the
          "drill into this booking" affordance before the secondary
          patient/edit/reschedule rows. */}
      <QuickActionRow
        icon={<CalendarCheck size={16} aria-hidden />}
        label="View full appointment"
        description="Detail page with timeline, deposit, intake answers"
        trailing={<ChevronRight size={16} aria-hidden style={{ color: theme.color.inkSubtle }} />}
        onClick={onViewAppointment}
        first
      />
      <QuickActionRow
        icon={<UserIcon />}
        label="Patient profile"
        trailing={<ChevronRight size={16} aria-hidden style={{ color: theme.color.inkSubtle }} />}
        onClick={onPatientProfile}
      />
      {showEdit ? (
        <QuickActionRow
          icon={<Pencil size={16} aria-hidden />}
          label="Edit appointment"
          trailing={<ChevronRight size={16} aria-hidden style={{ color: theme.color.inkSubtle }} />}
          onClick={onEdit}
        />
      ) : null}
      {showReschedule ? (
        <QuickActionRow
          icon={<CalendarClock size={16} aria-hidden />}
          label="Reschedule"
          trailing={<ChevronRight size={16} aria-hidden style={{ color: theme.color.inkSubtle }} />}
          onClick={onReschedule}
        />
      ) : null}
      {showResendConfirmation ? (
        <QuickActionRow
          icon={<Mail size={16} aria-hidden />}
          label={sendingThis ? 'Sending…' : 'Resend confirmation'}
          trailing={
            sendingThis ? (
              <span
                aria-hidden
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontWeight: theme.type.weight.medium,
                }}
              >
                Sending
              </span>
            ) : appointment.patient_email ? (
              <span
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {appointment.patient_email}
              </span>
            ) : null
          }
          onClick={sendingThis ? () => undefined : onResendConfirmation}
          disabled={sendingThis}
        />
      ) : null}
      {showCancel ? (
        <QuickActionRow
          icon={<XCircle size={16} aria-hidden />}
          label="Cancel appointment"
          tone="alert"
          onClick={onCancel}
        />
      ) : null}
      {calendlyHintInline ? (
        <div
          style={{
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderTop: `1px solid ${theme.color.border}`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            fontStyle: 'italic',
            background: theme.color.bg,
          }}
        >
          Reschedule on Calendly
        </div>
      ) : null}
    </section>
  );
}

function QuickActionRow({
  icon,
  label,
  description,
  trailing,
  onClick,
  first = false,
  disabled = false,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  /** Optional secondary line under the label. Used for the "View
   * full appointment" row to hint at what's on the destination. */
  description?: string;
  trailing?: React.ReactNode;
  onClick: () => void;
  first?: boolean;
  disabled?: boolean;
  // 'alert' tints the icon + label red so destructive actions like
  // Cancel appointment read distinctly from navigation rows.
  tone?: 'default' | 'alert';
}) {
  const labelColour = tone === 'alert' ? theme.color.alert : theme.color.ink;
  const iconColour = tone === 'alert' ? theme.color.alert : theme.color.inkMuted;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        borderTop: first ? 'none' : `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        opacity: disabled ? 0.6 : 1,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = theme.color.bg;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          color: iconColour,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.medium,
            color: labelColour,
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
      {trailing ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

// Lightweight User glyph for the Patient profile row — using a
// hand-drawn 16px Lucide-equivalent so the import surface stays
// trim. Same dimensions and stroke as the other 16px icons in the
// list.
function UserIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx={12} cy={7} r={4} />
    </svg>
  );
}

function NoShowReasonPicker({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (reason: NoShowReason) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      {NO_SHOW_REASONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={busy}
          onClick={() => onPick(opt.value)}
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
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.5 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            minHeight: theme.layout.minTouchTarget,
            transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
          onMouseEnter={(e) => {
            if (busy) return;
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
    </div>
  );
}

function statusToTone(s: AppointmentRow['status']) {
  return s === 'booked'
    ? 'neutral'
    : s === 'arrived'
      ? 'arrived'
      : s === 'in_progress'
        ? 'in_progress'
        : s === 'complete'
          ? 'complete'
          : s === 'no_show'
            ? 'no_show'
            : 'cancelled';
}

// Compact day + start-time string for the appointment popup
// header. The cluster sheet uses formatClusterRange (range matters
// when it spans multiple appointments), but a single appointment
// reads cleaner without the redundant duration — staff care about
// when it starts, not when it ends.
function formatStart(startIso: string): string {
  const s = new Date(startIso);
  return `${s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatClusterRange(rows: AppointmentRow[]): string {
  if (rows.length === 0) return '';
  let earliestStart = rows[0]!.start_at;
  let latestEnd = rows[0]!.end_at;
  for (const r of rows) {
    if (r.start_at < earliestStart) earliestStart = r.start_at;
    if (r.end_at > latestEnd) latestEnd = r.end_at;
  }
  const s = new Date(earliestStart);
  const e = new Date(latestEnd);
  const day = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} · ${formatTime12h(s)} to ${formatTime12h(e)}`;
}

// 12-hour time, lowercase am/pm, no leading zero on the hour. Mirrors the
// formatter in ScheduleListView so the cluster sheet header reads in the
// same style as the rows below it.
function formatTime12h(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${hh}${mm}${ampm}`;
}

// Solid badge + label that surfaces a Calendly deposit on the booking
// detail sheet. Filled green circle with a white tick when paid; filled
// red circle with a white cross when the payment failed (Calendly attempt
// recorded, money not collected — receptionist needs to chase).
function DepositLine({
  status,
  amountPence,
  provider,
}: {
  status: 'paid' | 'failed';
  amountPence: number;
  provider: 'paypal' | 'stripe' | null;
}) {
  const isPaid = status === 'paid';
  const badgeColor = isPaid ? theme.color.accent : theme.color.alert;
  const labelColor = isPaid ? theme.color.ink : theme.color.alert;
  const labelWeight = isPaid ? theme.type.weight.medium : theme.type.weight.semibold;
  const text = isPaid
    ? `${formatGbp(amountPence)} deposit paid${provider ? ` · ${capitalise(provider)}` : ''}`
    : `${formatGbp(amountPence)} deposit failed${provider ? ` · ${capitalise(provider)}` : ''}`;
  return (
    <div
      role={isPaid ? undefined : 'alert'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[2],
        fontSize: theme.type.size.sm,
        color: labelColor,
        fontWeight: labelWeight,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 999,
          background: badgeColor,
          color: theme.color.surface,
          flexShrink: 0,
        }}
      >
        {isPaid ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
      </span>
      <span>{text}</span>
    </div>
  );
}

// Compact GBP formatter: "£25" / "£25.50". Uses Intl so the receptionist
// sees the locale-correct separator.
function formatGbp(pence: number): string {
  const pounds = pence / 100;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: pounds % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(pounds);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Date heading shown above the day's timeline. e.g. "Tuesday 28 April".
function formatDayHeading(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Default ISO datetime to seed the NewBookingSheet with when the
// operator clicks "Book new appointment" from the empty-day card
// (no calendar grid is rendered, so there's nothing to tap). We
// choose the calendar's first hour because the booking-type
// working-hours config typically opens around then; the operator
// adjusts in the sheet if needed.
function defaultBookingIso(dateIso: string, startHour: number): string {
  const d = new Date(`${dateIso}T${String(startHour).padStart(2, '0')}:00:00`);
  return d.toISOString();
}

// Notes column is `text` and historically nullable; some legacy
// rows have the literal string "None" stored where null would now
// land. Treat that as empty so the detail card doesn't render a
// "NOTES / None" block for what is effectively no notes.
function hasMeaningfulNotes(notes: string | null): boolean {
  if (!notes) return false;
  const trimmed = notes.trim();
  if (!trimmed) return false;
  if (/^none$/i.test(trimmed)) return false;
  return true;
}

