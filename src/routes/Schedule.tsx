import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  List,
  Monitor,
  Video,
} from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toast,
  WeekStrip,
} from '../components/index.ts';
import {
  CalendarGrid,
  layoutAppointments,
  offsetForTime,
  heightForDuration,
} from '../components/CalendarGrid/CalendarGrid.tsx';
import { AppointmentCard } from '../components/AppointmentCard/AppointmentCard.tsx';
import { ClusterCard } from '../components/ClusterCard/ClusterCard.tsx';
import { ScheduleListView } from '../components/ScheduleListView/ScheduleListView.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsDesktop, useIsMobile } from '../lib/useIsMobile.ts';
import { useNow } from '../lib/useNow.ts';
import {
  addDaysIso,
  formatWeekLabel,
  getWeekDays,
  todayIso as computeTodayIso,
} from '../lib/calendarMonth.ts';
import {
  type AppointmentRow,
  eventTypeCategory,
  formatBookingSummary,
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
  markAppointmentArrived,
  markNoShow,
  markVirtualMeetingJoined,
  type NoShowReason,
  NO_SHOW_REASONS,
  reverseNoShow,
} from '../lib/queries/visits.ts';

type Layout = 'calendar' | 'list';
const LAYOUT_KEY = 'lounge.scheduleLayout';
// Threshold above which we offer the Calendar/List toggle and auto-pick
// list when the user hasn't expressed a preference. Sparse days don't
// need the alternate view — calendar always reads cleanly under 4 rows.
const DENSE_THRESHOLD = 4;

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

  const day = useDayAppointments(selectedDate);
  // Week-of-selected counts power the dots under each day pill.
  const weekDays = getWeekDays(selectedDate);
  const weekStartIso = weekDays[0]!;
  const weekEndIso = weekDays[6]!;
  const weekCounts = useDateRangeCounts(weekStartIso, weekEndIso);

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
    setPickingNoShowReason(false);
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
  const dense = day.data.length >= DENSE_THRESHOLD;
  const showLayoutToggle = day.data.length > 0 && dense;
  const weekLabel = formatWeekLabel(weekStartIso, weekEndIso);

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        {/* Single-row header: week label + Today chip on the left, week nav on the right.
            Walk-in lives in the bottom nav so it stays one tap away on every page. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            marginBottom: theme.space[4],
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
                whiteSpace: 'nowrap',
              }}
            >
              {weekLabel}
            </h1>
            {!onToday ? (
              <button
                type="button"
                onClick={handleJumpToToday}
                style={{
                  appearance: 'none',
                  border: `1px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.ink,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  padding: `0 ${theme.space[3]}px`,
                  height: 32,
                  borderRadius: theme.radius.pill,
                  cursor: 'pointer',
                  marginLeft: theme.space[2],
                }}
              >
                Today
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
            <IconNavButton ariaLabel="Previous week" onClick={() => handleShiftWeek(-1)}>
              <ChevronLeft size={20} />
            </IconNavButton>
            <IconNavButton ariaLabel="Next week" onClick={() => handleShiftWeek(1)}>
              <ChevronRight size={20} />
            </IconNavButton>
          </div>
        </div>

        <div style={{ marginBottom: theme.space[5] }}>
          <WeekStrip
            anchorIso={selectedDate}
            selectedIso={selectedDate}
            todayIso={todayIso}
            counts={weekCounts.counts}
            onSelect={handleSelectDate}
            loading={weekCounts.loading}
          />
        </div>

        {/* Selected-day heading + optional layout toggle. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
            marginBottom: theme.space[3],
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: theme.space[3], minWidth: 0 }}>
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
              }}
            >
              {day.loading
                ? ''
                : day.data.length === 0
                  ? 'No appointments'
                  : `${day.data.length} appointment${day.data.length === 1 ? '' : 's'}`}
            </span>
          </div>
          {showLayoutToggle ? (
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
          ) : null}
        </div>

        <Card padding={isMobile ? 'sm' : 'md'}>
          {day.loading ? (
            <SkeletonRows />
          ) : day.data.length === 0 ? (
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

      {selected ? (
        <BottomSheet
          open={!!selected}
          onClose={closeSheet}
          title={pickingNoShowReason ? 'Why was this a no-show?' : patientFullDisplayName(selected)}
          description={
            pickingNoShowReason ? (
              <span>Pick the reason. We log it against the appointment so reports show no-show causes.</span>
            ) : (
              <span style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
                <span>
                  {formatRange(selected.start_at, selected.end_at)}
                  {staffDisplayName(selected) ? ` · with ${staffDisplayName(selected)}` : ''}
                </span>
                {selected.patient_email || selected.patient_phone ? (
                  <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm, fontVariantNumeric: 'tabular-nums' }}>
                    {[selected.patient_email, selected.patient_phone].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
            )
          }
          footer={
            pickingNoShowReason ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="tertiary" disabled={busy} onClick={() => setPickingNoShowReason(false)}>
                  Back
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <Button
                  variant="tertiary"
                  onClick={() => {
                    if (!selected) return;
                    navigate(`/patient/${selected.patient_id}`);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                    Patient timeline <ChevronRight size={16} />
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
                                navigate(`/visit/${visit_id}`);
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
                          loading={busy}
                          onClick={async () => {
                            if (!selected) return;
                            setBusy(true);
                            try {
                              const { visit_id } = await markAppointmentArrived(selected.id);
                              navigate(`/visit/${visit_id}`);
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not mark arrived');
                            } finally {
                              setBusy(false);
                            }
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
          {pickingNoShowReason ? (
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
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
                <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Status</span>
                <StatusPill tone={statusToTone(selected.status)} size="sm">
                  {humaniseStatus(selected.status)}
                </StatusPill>
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
                    <strong>{minutesPastStart(selected.start_at, now)} min late.</strong>{' '}
                    {selected.join_url
                      ? 'If they have not connected, tap No-show.'
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
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
                    Virtual appointment. Open <strong>lounge.venneir.com</strong> on a desktop to join the meeting and record attendance.
                  </p>
                </div>
              ) : null}

              {formatBookingSummary(selected) ? (
                <div
                  style={{
                    padding: `${theme.space[3]}px ${theme.space[4]}px`,
                    background: theme.color.accentBg,
                    border: `1px solid ${theme.color.accent}`,
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
                        : 'Marked as a no-show. If the patient turned up late, tap "Patient attended" to flip them back to arrived and start a visit.'
                      : selected.status === 'rescheduled'
                        ? 'This booking was rescheduled in Calendly.'
                        : selected.status === 'cancelled'
                          ? 'This booking was cancelled in Calendly.'
                          : ''}
              </p>
            </div>
          )}
        </BottomSheet>
      ) : null}

      {clusterRows ? (
        <BottomSheet
          open={!!clusterRows}
          onClose={() => setClusterRows(null)}
          title={`${clusterRows.length} appointments`}
          description={formatClusterRange(clusterRows)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {clusterRows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setClusterRows(null);
                  setSelected(r);
                }}
                style={{
                  appearance: 'none',
                  width: '100%',
                  textAlign: 'left',
                  padding: theme.space[3],
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  minHeight: 56,
                }}
              >
                <span
                  style={{
                    width: 80,
                    flexShrink: 0,
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.semibold,
                    fontVariantNumeric: 'tabular-nums',
                    color: theme.color.ink,
                  }}
                >
                  {new Date(r.start_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {patientDisplayName(r)}
                  </span>
                  {formatBookingSummary(r) ? (
                    <span
                      style={{
                        display: 'block',
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                      }}
                    >
                      {formatBookingSummary(r)}
                    </span>
                  ) : null}
                </span>
                <StatusPill tone={r.status === 'booked' ? 'neutral' : 'arrived'} size="sm">
                  {humaniseStatus(r.status)}
                </StatusPill>
              </button>
            ))}
          </div>
        </BottomSheet>
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not update" description={error} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </main>
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
  const sTime = s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const eTime = e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${sTime} to ${eTime}. Pick one to open.`;
}

// Date heading shown above the day's timeline. e.g. "Tuesday 28 April".
function formatDayHeading(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

