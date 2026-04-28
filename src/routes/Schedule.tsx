import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  CalendarOff,
  Check,
  ChevronLeft,
  ChevronRight,
  List,
  Monitor,
  Video,
  X,
} from 'lucide-react';
import {
  ArrivalIntakeSheet,
  BottomSheet,
  Button,
  Card,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toast,
  WaiverSheet,
  WeekStrip,
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
  getWeekDays,
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
  markAppointmentArrived,
  markNoShow,
  markVirtualMeetingJoined,
  type NoShowReason,
  NO_SHOW_REASONS,
  reverseNoShow,
} from '../lib/queries/visits.ts';

type Layout = 'calendar' | 'list';
const LAYOUT_KEY = 'lounge.scheduleLayout';

export function Schedule() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const isDesktop = useIsDesktop();
  const now = useNow();
  const todayIso = computeTodayIso(now);

  const [selectedDate, setSelectedDate] = useState<string>(todayIso);
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

  // Arrival flow state. Captures the appointment we're walking through
  // intake + waiver for, so the schedule's own bottom sheet can close
  // without losing context. Lives outside `selected` because the
  // receptionist may dismiss the schedule sheet mid-flow but the
  // arrival flow has its own full-screen sheet stack.
  const [arrivalFlow, setArrivalFlow] = useState<
    | { appointment: AppointmentRow; step: 'intake' | 'waiver' }
    | null
  >(null);

  const day = useDayAppointments(selectedDate);
  // Week-of-selected counts power the dots under each day pill.
  const weekDays = getWeekDays(selectedDate);
  const weekStartIso = weekDays[0]!;
  const weekEndIso = weekDays[6]!;
  const weekCounts = useDateRangeCounts(weekStartIso, weekEndIso);

  // Waiver state for the selected patient. Sections are global; signatures
  // are per-patient. Pre-arrival the "required sections" are inferred from
  // the booking's event_type_label only — once a cart exists the visit
  // page does the more accurate cart-item resolution.
  const { sections: waiverSections } = useWaiverSections();
  // Waiver state follows whichever surface needs it: the schedule sheet
  // (selected) when nothing's mid-arrival, or the arrival flow's
  // captured appointment once intake is open. Keeps the WaiverSheet
  // sections and signatures fresh for the patient we're actually about
  // to gate.
  const waiverPatientId = arrivalFlow?.appointment.patient_id ?? selected?.patient_id;
  const { latest: patientSignatures } = usePatientWaiverState(waiverPatientId);
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

  // Sections to walk through for the arrival flow's waiver step.
  // Computed against the arrival appointment so it's correct even
  // after the schedule sheet has been dismissed.
  const arrivalRequiredSections = (() => {
    if (!arrivalFlow) return [];
    if (waiverSections.length === 0) return [];
    const inferred = inferServiceTypeFromEventLabel(arrivalFlow.appointment.event_type_label);
    return requiredSectionsForServiceTypes(inferred ? [inferred] : [], waiverSections);
  })();
  const arrivalWaiverFlag: WaiverFlag | null = arrivalFlow
    ? summariseWaiverFlag(arrivalRequiredSections, patientSignatures)
    : null;

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

  // Final step of the arrival flow. Creates the visit + lwo_ref +
  // patient_events row, then routes to /visit/:id. Errors surface in
  // the existing schedule toast so the receptionist sees them in
  // context and can retry without losing intake data.
  const finaliseArrival = async (appointment: AppointmentRow) => {
    setBusy(true);
    try {
      const { visit_id } = await markAppointmentArrived(appointment.id);
      setArrivalFlow(null);
      navigate(`/visit/${visit_id}`, { state: { from: 'schedule' } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark arrived');
      // Leave arrivalFlow set on the waiver step so the receptionist
      // can re-trigger from the waiver "All signed" callback if they
      // need to. (signing is idempotent on its current section.)
    } finally {
      setBusy(false);
    }
  };

  const handleSelectDate = (dateIso: string) => {
    setSelectedDate(dateIso);
  };

  const handleShiftWeek = (delta: number) => {
    setSelectedDate((prev) => addDaysIso(prev, delta * 7));
  };

  const handleJumpToToday = () => {
    setSelectedDate(todayIso);
  };

  const onToday = selectedDate === todayIso;
  const dayHeading = formatDayHeading(selectedDate);
  // Toolbar label follows the selected day's month (not the week's), so it
  // flips Apr→May the moment the receptionist taps a day in the next month
  // (e.g. selecting Fri 1 in a Mon-Sun strip that started in April).
  const selectedYear = Number(selectedDate.slice(0, 4));
  const selectedMonth = Number(selectedDate.slice(5, 7)) - 1;
  const toolbarLabel = monthLabel(selectedYear, selectedMonth);

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
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
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
          <span
            aria-live="polite"
            style={{
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              whiteSpace: 'nowrap',
            }}
          >
            {toolbarLabel}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '40px 1fr 40px',
            alignItems: 'center',
            gap: theme.space[2],
            marginBottom: theme.space[5],
          }}
        >
          <IconNavButton ariaLabel="Previous week" onClick={() => handleShiftWeek(-1)}>
            <ChevronLeft size={20} />
          </IconNavButton>
          <WeekStrip
            anchorIso={selectedDate}
            selectedIso={selectedDate}
            todayIso={todayIso}
            counts={weekCounts.counts}
            onSelect={handleSelectDate}
            loading={weekCounts.loading}
          />
          <IconNavButton ariaLabel="Next week" onClick={() => handleShiftWeek(1)}>
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
                  ? 'Tap New walk-in when someone arrives, or wait for Calendly bookings to land.'
                  : 'Pick another day in the calendar above, or create a walk-in.'
              }
            />
          ) : layout === 'list' ? (
            <ScheduleListView rows={day.data} onPick={setSelected} />
          ) : (
            <div style={{ paddingTop: theme.space[2] }}>
              <CalendarGrid showNowIndicator={onToday}>
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
                      top={offsetForTime(item.data.start_at, 8, 80)}
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
                      top={offsetForTime(item.startAt, 8, 80)}
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
              <span style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <SourceGlyph source={selected.source} size={13} />
                  <span>
                    {selected.source === 'manual' ? 'Walk-in · ' : ''}
                    {formatRange(selected.start_at, selected.end_at)}
                    {staffDisplayName(selected) ? ` · with ${staffDisplayName(selected)}` : ''}
                  </span>
                </span>
                {selected.patient_email || selected.patient_phone ? (
                  <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                    {[selected.patient_email, selected.patient_phone].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            ) : (
              <span>{formatClusterRange(clusterRows!)}</span>
            )
          }
          footer={
            pickingNoShowReason ? null : !selected ? null : (
              <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <Button
                  variant="tertiary"
                  onClick={() => {
                    if (!selected) return;
                    navigate(`/patient/${selected.patient_id}`);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                    Patient profile <ChevronRight size={16} />
                  </span>
                </Button>
                {(() => {
                  const isVirtual = !!selected.join_url;
                  const status = selected.status;
                  const showNoShow = status === 'booked' || (isVirtual && status === 'arrived');
                  const showVirtualJoin =
                    isVirtual && (status === 'booked' || status === 'arrived' || status === 'no_show');
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
                          variant={isVirtual ? 'secondary' : 'primary'}
                          showArrow={!isVirtual}
                          disabled={busy}
                          loading={busy}
                          onClick={async () => {
                            if (!selected) return;
                            setBusy(true);
                            try {
                              const { visit_id } = await reverseNoShow(selected.id);
                              if (visit_id && !isVirtual) {
                                navigate(`/visit/${visit_id}`, { state: { from: 'schedule' } });
                              } else {
                                setSelected(null);
                                window.location.reload();
                              }
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not undo no-show');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Patient attended
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
                        isDesktop ? (
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
                                window.location.reload();
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
                        ) : null
                      ) : null}
                      {showMarkArrived ? (
                        <Button
                          variant="primary"
                          showArrow
                          onClick={() => {
                            if (!selected) return;
                            // Capture the appointment, close the schedule
                            // sheet, and hand control to the arrival flow.
                            // Intake → (waiver if required) → markAppointmentArrived.
                            const apt = selected;
                            setSelected(null);
                            setClusterRows(null);
                            setArrivalFlow({ appointment: apt, step: 'intake' });
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
                  window.location.reload();
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
                <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                  <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Status</span>
                  <StatusPill tone={statusToTone(selected.status)} size="sm">
                    {humaniseStatus(selected.status)}
                  </StatusPill>
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
                    {selected.join_url
                      ? 'If they have not connected, tap No-show.'
                      : 'If they have not turned up, tap No-show.'}
                  </p>
                </div>
              ) : null}

              {waiverFlag && waiverFlag.status !== 'ready' ? (
                <div
                  role="alert"
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
                  <AlertTriangle
                    size={20}
                    color={theme.color.alert}
                    aria-hidden
                    style={{ flexShrink: 0 }}
                  />
                  <p
                    style={{
                      margin: 0,
                      fontSize: theme.type.size.sm,
                      lineHeight: theme.type.leading.snug,
                    }}
                  >
                    <strong>{waiverFlagTitle(waiverFlag)}.</strong>{' '}
                    {waiverFlagBody(waiverFlag)}
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
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
                    Virtual appointment. Open <strong>lounge.venneir.com</strong> on a desktop to join the meeting and record attendance.
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
            </div>
          ) : null}
        </BottomSheet>
      ) : null}

      {arrivalFlow ? (
        <ArrivalIntakeSheet
          open={arrivalFlow.step === 'intake'}
          onClose={() => setArrivalFlow(null)}
          appointmentId={arrivalFlow.appointment.id}
          patientId={arrivalFlow.appointment.patient_id}
          eventTypeLabel={arrivalFlow.appointment.event_type_label}
          onSubmitted={() => {
            // After intake is saved, decide whether the patient still
            // needs to sign the waiver before we open the visit. If yes,
            // pivot to the waiver step; if no, finish the arrival.
            const needsWaiver =
              arrivalWaiverFlag !== null && arrivalWaiverFlag.status !== 'ready';
            if (needsWaiver) {
              setArrivalFlow((s) => (s ? { ...s, step: 'waiver' } : s));
            } else {
              finaliseArrival(arrivalFlow.appointment);
            }
          }}
        />
      ) : null}

      {arrivalFlow && arrivalFlow.step === 'waiver' ? (
        <WaiverSheet
          open
          onClose={() => setArrivalFlow(null)}
          patientId={arrivalFlow.appointment.patient_id}
          // No visit yet — we sign before lng_visits is created so
          // signWaiver writes patient-only signatures. The visit page
          // will pick up the up-to-date waiver state on first render.
          visitId={null}
          sections={(() => {
            const flag = arrivalWaiverFlag;
            const missing = flag?.missingSections ?? [];
            const stale = flag?.staleSections ?? [];
            return [...missing, ...stale];
          })()}
          patientName={patientFullDisplayName(arrivalFlow.appointment)}
          onAllSigned={() => finaliseArrival(arrivalFlow.appointment)}
        />
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not update" description={error} onDismiss={() => setError(null)} />
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

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  return `${s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} to ${e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
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

// Banner title for the waiver flag. Maps the four summariseWaiverFlag
// states to receptionist-facing copy. Tab-friendly: stale and partial
// both phrase as "needs re-signing" — the difference between them is
// just whether the patient has zero up-to-date signatures or some.
function waiverFlagTitle(flag: WaiverFlag): string {
  if (flag.status === 'none') return 'Waiver needed';
  if (flag.status === 'stale') return 'Waiver needs re-signing';
  return 'Waiver partial';
}

function waiverFlagBody(flag: WaiverFlag): string {
  if (flag.status === 'none') {
    return `Patient has not signed the ${listSectionTitles(flag.missingSections)} section(s).`;
  }
  if (flag.status === 'stale') {
    return `Terms updated since they last signed. Re-sign needed for ${listSectionTitles(flag.staleSections)}.`;
  }
  // partial
  const parts: string[] = [];
  if (flag.missingSections.length > 0) parts.push(`missing: ${listSectionTitles(flag.missingSections)}`);
  if (flag.staleSections.length > 0) parts.push(`re-sign: ${listSectionTitles(flag.staleSections)}`);
  return parts.join(' · ');
}

function listSectionTitles(secs: { title: string }[]): string {
  return secs.map((s) => s.title).join(', ');
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

