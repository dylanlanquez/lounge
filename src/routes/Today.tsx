import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CalendarOff, LogOut, Plus } from 'lucide-react';
import { Avatar, BottomSheet, Button, Card, EmptyState, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { CalendarGrid, offsetForTime, heightForDuration } from '../components/CalendarGrid/CalendarGrid.tsx';
import { AppointmentCard } from '../components/AppointmentCard/AppointmentCard.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import {
  useTodayAppointments,
  patientDisplayName,
  staffDisplayName,
  type AppointmentRow,
} from '../lib/queries/appointments.ts';
import { markAppointmentArrived } from '../lib/queries/visits.ts';
import { supabase } from '../lib/supabase.ts';

export function Today() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { data: appointments, loading, error } = useTodayAppointments();
  const [selected, setSelected] = useState<AppointmentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [toastError, setToastError] = useState<string | null>(null);

  if (authLoading) return <Loading message="Checking session…" />;
  if (!user) return <Navigate to="/sign-in" replace />;

  const todayLabel = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <main style={{ minHeight: '100dvh', background: theme.color.bg, padding: theme.space[6] }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[4],
            marginBottom: theme.space[6],
          }}
        >
          <img src="/lounge-logo.png" alt="Lounge" style={{ height: 32, width: 'auto' }} />
          <div style={{ flex: 1 }} />
          <Avatar name={user.email ?? 'You'} size="md" badge="online" />
          <Button variant="tertiary" onClick={signOut}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <LogOut size={16} /> Sign out
            </span>
          </Button>
        </header>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: theme.space[4],
            marginBottom: theme.space[6],
            flexWrap: 'wrap',
          }}
        >
          <div>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {todayLabel}
            </p>
            <h1
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              Today
            </h1>
          </div>
          <Button variant="primary" onClick={() => navigate('/walk-in/new')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <Plus size={18} /> New walk-in
            </span>
          </Button>
        </div>

        <Card padding="md">
          {loading ? (
            <SkeletonGrid />
          ) : error ? (
            <EmptyState
              title="Could not load appointments"
              description={error}
              action={
                <Button variant="primary" onClick={() => window.location.reload()}>
                  Retry
                </Button>
              }
            />
          ) : appointments.length === 0 ? (
            <EmptyState
              icon={<CalendarOff size={24} />}
              title="No appointments today"
              description="Create a walk-in below, or wait for a Calendly booking to land."
              action={
                <Button variant="primary" showArrow onClick={() => navigate('/walk-in/new')}>
                  New walk-in
                </Button>
              }
            />
          ) : (
            <div style={{ paddingTop: theme.space[2] }}>
              <CalendarGrid>
                {appointments.map((a) => (
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
                    onClick={() => setSelected(a)}
                  />
                ))}
              </CalendarGrid>
            </div>
          )}
        </Card>

        <div
          style={{
            marginTop: theme.space[6],
            display: 'flex',
            gap: theme.space[2],
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <StatusPill tone="complete" size="sm">Phase 1 done</StatusPill>
          <StatusPill tone="arrived" size="sm">Phase 2 design system shipping</StatusPill>
          <StatusPill tone="in_progress" size="sm">Phase 3 slice 2 (today calendar) live</StatusPill>
          <StatusPill tone="neutral" size="sm">Slice 3 Calendly inbound next</StatusPill>
        </div>

        <p
          style={{
            marginTop: theme.space[6],
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            textAlign: 'center',
          }}
        >
          Lounge v0.5 preview · build {import.meta.env.MODE} · signed in as {user.email}
        </p>
      </div>

      {selected ? (
        <BottomSheet
          open={!!selected}
          onClose={() => setSelected(null)}
          title={patientDisplayName(selected)}
          description={`${formatTime(selected.start_at)} to ${formatTime(selected.end_at)}${
            staffDisplayName(selected) ? ` with ${staffDisplayName(selected)}` : ''
          }${selected.event_type_label ? ` · ${selected.event_type_label}` : ''}`}
          footer={
            selected.status === 'booked' ? (
              <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between' }}>
                <Button
                  variant="tertiary"
                  onClick={async () => {
                    if (!selected) return;
                    setBusy(true);
                    try {
                      await supabase.from('lng_appointments').update({ status: 'no_show' }).eq('id', selected.id);
                      setSelected(null);
                      window.location.reload();
                    } catch (e) {
                      setToastError(e instanceof Error ? e.message : 'Could not update');
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Mark no-show
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
                      setToastError(e instanceof Error ? e.message : 'Could not mark arrived');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Mark as arrived
                </Button>
              </div>
            ) : (
              <Button variant="secondary" onClick={() => setSelected(null)} fullWidth>
                Close
              </Button>
            )
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <p style={{ margin: 0, color: theme.color.ink }}>
              Status: <strong>{selected.status}</strong>
            </p>
            {selected.status === 'cancelled' || selected.status === 'rescheduled' ? (
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                {selected.status === 'rescheduled'
                  ? 'This booking was rescheduled in Calendly. The replacement appointment will appear on the new date.'
                  : 'This booking was cancelled in Calendly.'}
              </p>
            ) : null}
            {selected.status === 'booked' ? (
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                Mark arrived when the patient is at the desk. Mark no-show 15 min after the start time if they have not turned up.
              </p>
            ) : null}
          </div>
        </BottomSheet>
      ) : null}

      {toastError ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not update" description={toastError} onDismiss={() => setToastError(null)} />
        </div>
      ) : null}
    </main>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function Loading({ message }: { message: string }) {
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <p style={{ color: theme.color.inkMuted }}>{message}</p>
    </main>
  );
}

function SkeletonGrid() {
  return (
    <div style={{ padding: theme.space[2] }}>
      <Skeleton height={20} width={120} />
      <div style={{ marginTop: theme.space[4], display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Skeleton height={64} radius={12} />
        <Skeleton height={48} radius={12} />
        <Skeleton height={80} radius={12} />
      </div>
    </div>
  );
}
