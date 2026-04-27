import { Navigate } from 'react-router-dom';
import { CalendarOff, LogOut } from 'lucide-react';
import { Avatar, Button, Card, EmptyState, StatusPill } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';

// Phase 3 placeholder dashboard. Real today-view comes in slice 2.
// Visible after sign-in so the user can see they made it through the auth flow.

export function Dashboard() {
  const { user, loading, signOut } = useAuth();

  if (loading) {
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
        <p style={{ color: theme.color.inkMuted }}>Loading…</p>
      </main>
    );
  }

  if (!user) return <Navigate to="/sign-in" replace />;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: theme.space[6],
      }}
    >
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[4],
            marginBottom: theme.space[8],
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
            flexDirection: 'column',
            gap: theme.space[2],
            marginBottom: theme.space[6],
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {today}
          </p>
          <h1
            style={{
              margin: 0,
              fontSize: theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Welcome to Lounge
          </h1>
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.md }}>
            Signed in as {user.email}.
          </p>
        </div>

        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', marginBottom: theme.space[6] }}>
          <StatusPill tone="complete" size="sm">Phase 1 done</StatusPill>
          <StatusPill tone="in_progress" size="sm">Phase 2 design system in progress</StatusPill>
          <StatusPill tone="neutral" size="sm">Phase 3 next</StatusPill>
        </div>

        <Card padding="lg">
          <EmptyState
            icon={<CalendarOff size={24} />}
            title="No appointments today"
            description="The calendar primitives are still being built. Today-view ships in slice 2 and will replace this empty state with a real schedule."
            action={
              <Button variant="primary" disabled showArrow>
                New walk-in (slice 4)
              </Button>
            }
          />
        </Card>

        <p
          style={{
            marginTop: theme.space[8],
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            textAlign: 'center',
          }}
        >
          Lounge v0.3 preview • build {import.meta.env.MODE}
        </p>
      </div>
    </main>
  );
}
