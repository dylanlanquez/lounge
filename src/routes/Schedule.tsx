import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CalendarOff, ChevronRight, Plus } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatusPill,
  Toast,
} from '../components/index.ts';
import {
  CalendarGrid,
  assignAppointmentLanes,
  offsetForTime,
  heightForDuration,
} from '../components/CalendarGrid/CalendarGrid.tsx';
import { AppointmentCard } from '../components/AppointmentCard/AppointmentCard.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type AppointmentRow,
  patientDisplayName,
  staffDisplayName,
  useTodayAppointments,
} from '../lib/queries/appointments.ts';
import { usePastAppointments, useUpcomingAppointments } from '../lib/queries/scheduleViews.ts';
import { markAppointmentArrived } from '../lib/queries/visits.ts';
import { supabase } from '../lib/supabase.ts';

type View = 'today' | 'upcoming' | 'past';

export function Schedule() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const [view, setView] = useState<View>('today');
  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = useTodayAppointments();
  const upcoming = useUpcomingAppointments(14);
  const past = usePastAppointments(30);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const dateLabel = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const headerTitle =
    view === 'today' ? 'Today' : view === 'upcoming' ? 'Upcoming' : 'Past 30 days';

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <TopBar variant="home" />

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: theme.space[4],
            marginBottom: theme.space[5],
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {dateLabel}
            </p>
            <h1
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {headerTitle}
            </h1>
          </div>
          <Button variant="primary" size={isMobile ? 'md' : 'lg'} onClick={() => navigate('/walk-in/new')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Plus size={isMobile ? 16 : 18} /> {isMobile ? 'Walk-in' : 'New walk-in'}
            </span>
          </Button>
        </div>

        <div style={{ marginBottom: theme.space[5] }}>
          <SegmentedControl<View>
            value={view}
            onChange={setView}
            options={[
              { value: 'today', label: `Today${today.data.length ? ` · ${today.data.length}` : ''}` },
              { value: 'upcoming', label: `Upcoming${upcoming.data.length ? ` · ${upcoming.data.length}` : ''}` },
              { value: 'past', label: `Past${past.data.length ? ` · ${past.data.length}` : ''}` },
            ]}
          />
        </div>

        <Card padding={isMobile ? 'sm' : 'md'}>
          {view === 'today' ? (
            today.loading ? (
              <SkeletonRows />
            ) : today.data.length === 0 ? (
              <EmptyState
                icon={<CalendarOff size={24} />}
                title="No appointments today"
                description="Tap the New walk-in button above when someone arrives, or wait for Calendly bookings to land."
              />
            ) : (
              <div style={{ paddingTop: theme.space[2] }}>
                <CalendarGrid>
                  {assignAppointmentLanes(today.data).map((a) => (
                    <AppointmentCard
                      key={a.id}
                      patientName={patientDisplayName(a)}
                      startAt={a.start_at}
                      endAt={a.end_at}
                      status={a.status}
                      staffName={staffDisplayName(a)}
                      serviceLabel={a.event_type_label ?? undefined}
                      top={offsetForTime(a.start_at, 8, 80)}
                      height={heightForDuration(a.start_at, a.end_at, 80)}
                      lane={a.lane}
                      lanesInGroup={a.lanesInGroup}
                      onClick={() => setSelected(a)}
                    />
                  ))}
                </CalendarGrid>
              </div>
            )
          ) : view === 'upcoming' ? (
            upcoming.loading ? (
              <SkeletonRows />
            ) : upcoming.data.length === 0 ? (
              <EmptyState
                title="Nothing on the books"
                description="No appointments in the next 14 days."
              />
            ) : (
              <AppointmentList rows={upcoming.data} onPick={(a) => setSelected(a)} navigate={navigate} />
            )
          ) : past.loading ? (
            <SkeletonRows />
          ) : past.data.length === 0 ? (
            <EmptyState title="Nothing in the past 30 days" description="History fills in as you process visits." />
          ) : (
            <AppointmentList rows={past.data} onPick={(a) => setSelected(a)} navigate={navigate} />
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
          onClose={() => setSelected(null)}
          title={patientDisplayName(selected)}
          description={`${formatRange(selected.start_at, selected.end_at)}${
            staffDisplayName(selected) ? ` with ${staffDisplayName(selected)}` : ''
          }${selected.event_type_label ? ` · ${selected.event_type_label}` : ''}`}
          footer={
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
              {selected.status === 'booked' ? (
                <div style={{ display: 'flex', gap: theme.space[2] }}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      if (!selected) return;
                      setBusy(true);
                      try {
                        await supabase.from('lng_appointments').update({ status: 'no_show' }).eq('id', selected.id);
                        setSelected(null);
                        window.location.reload();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Could not update');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    No-show
                  </Button>
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
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setSelected(null)}>
                  Close
                </Button>
              )}
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <p style={{ margin: 0, color: theme.color.ink }}>
              Status: <strong>{selected.status}</strong>
            </p>
            <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              {selected.status === 'booked'
                ? 'Mark arrived when the patient is at the desk. Mark no-show 15 min after the start time if they have not turned up.'
                : selected.status === 'rescheduled'
                  ? 'This booking was rescheduled in Calendly.'
                  : selected.status === 'cancelled'
                    ? 'This booking was cancelled in Calendly.'
                    : ''}
            </p>
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

function SkeletonRows() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3], padding: theme.space[2] }}>
      <Skeleton height={56} radius={12} />
      <Skeleton height={56} radius={12} />
      <Skeleton height={56} radius={12} />
    </div>
  );
}

function AppointmentList({
  rows,
  onPick,
  navigate,
}: {
  rows: AppointmentRow[];
  onPick: (a: AppointmentRow) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // Group by date
  const byDate = new Map<string, AppointmentRow[]>();
  rows.forEach((a) => {
    const d = new Date(a.start_at).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const arr = byDate.get(d) ?? [];
    arr.push(a);
    byDate.set(d, arr);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {[...byDate.entries()].map(([date, group]) => (
        <div key={date}>
          <p
            style={{
              margin: `0 0 ${theme.space[2]}px`,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkSubtle,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            {date}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            {group.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onPick(a)}
                  style={{
                    appearance: 'none',
                    border: `1px solid ${theme.color.border}`,
                    background: theme.color.surface,
                    borderRadius: 12,
                    padding: theme.space[3],
                    width: '100%',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    gap: theme.space[3],
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      flexShrink: 0,
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {new Date(a.start_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        margin: 0,
                        fontSize: theme.type.size.base,
                        fontWeight: theme.type.weight.semibold,
                        color: theme.color.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {patientDisplayName(a)}
                    </p>
                    <p
                      style={{
                        margin: `${theme.space[1]}px 0 0`,
                        fontSize: theme.type.size.xs,
                        color: theme.color.inkMuted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {a.event_type_label ?? 'Appointment'}
                      {staffDisplayName(a) ? ` · ${staffDisplayName(a)}` : ''}
                    </p>
                  </div>
                  <StatusPill tone={statusToTone(a.status)} size="sm">
                    {a.status.replace('_', ' ')}
                  </StatusPill>
                  <ChevronRight size={18} style={{ color: theme.color.inkSubtle }} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {rows.length > 0 ? (
        <p style={{ margin: 0, color: theme.color.inkSubtle, fontSize: theme.type.size.xs, textAlign: 'center' }}>
          {rows.length} appointment{rows.length === 1 ? '' : 's'} · tap to mark arrived or open the patient timeline
        </p>
      ) : null}
      <Button variant="tertiary" size="sm" onClick={() => navigate('/walk-in/new')}>
        Or create a walk-in
      </Button>
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
