import { Navigate } from 'react-router-dom';
import { CalendarOff, LogOut } from 'lucide-react';
import { Avatar, Button, Card, EmptyState, Skeleton, StatusPill } from '../components/index.ts';
import { CalendarGrid, offsetForTime, heightForDuration } from '../components/CalendarGrid/CalendarGrid.tsx';
import { AppointmentCard } from '../components/AppointmentCard/AppointmentCard.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import {
  useTodayAppointments,
  patientDisplayName,
  staffDisplayName,
} from '../lib/queries/appointments.ts';

export function Today() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { data: appointments, loading, error } = useTodayAppointments();

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

        <div style={{ marginBottom: theme.space[6] }}>
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
              description="Once a Calendly booking lands or a walk-in arrives, it will appear here."
              action={
                <Button variant="primary" disabled showArrow>
                  New walk-in (slice 4)
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
          Lounge v0.4 preview · build {import.meta.env.MODE} · signed in as {user.email}
        </p>
      </div>
    </main>
  );
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
