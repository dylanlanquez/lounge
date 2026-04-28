import { Navigate, useNavigate } from 'react-router-dom';
import { ChevronRight, Stethoscope } from 'lucide-react';
import { Card, EmptyState, Skeleton, StatusPill } from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useActiveVisits, type ActiveVisitRow } from '../lib/queries/visits.ts';
import { properCase } from '../lib/queries/appointments.ts';
import { useNow } from '../lib/useNow.ts';

// "In clinic" — every visit currently open at this location. Receptionist
// uses it as a live board: who's just arrived, who's mid-treatment, how
// long they've been here. Tapping a row drops into the visit detail.
export function InClinic() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const { data, loading, error } = useActiveVisits();
  const now = useNow(60_000);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

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
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1
          style={{
            margin: 0,
            fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            marginBottom: theme.space[2],
          }}
        >
          In clinic
        </h1>
        <p
          style={{
            margin: 0,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.base,
            marginBottom: theme.space[5],
          }}
        >
          {loading
            ? 'Loading…'
            : data.length === 0
              ? 'No active visits right now.'
              : `${data.length} active visit${data.length === 1 ? '' : 's'}.`}
        </p>

        {error ? (
          <Card padding="lg">
            <p style={{ color: theme.color.alert, margin: 0 }}>Could not load visits: {error}</p>
          </Card>
        ) : loading ? (
          <Card padding="lg">
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
              <Skeleton height={64} radius={14} />
            </div>
          </Card>
        ) : data.length === 0 ? (
          <Card padding="lg">
            <EmptyState
              icon={<Stethoscope size={24} />}
              title="No one in clinic right now"
              description="Visits show up here as soon as you mark someone as arrived or start a walk-in."
            />
          </Card>
        ) : (
          <Card padding="md">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
              {data.map((v) => (
                <li key={v.id}>
                  <ActiveVisitListItem visit={v} now={now} onClick={() => navigate(`/visit/${v.id}`)} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </main>
  );
}

function ActiveVisitListItem({
  visit,
  now,
  onClick,
}: {
  visit: ActiveVisitRow;
  now: Date;
  onClick: () => void;
}) {
  const name = displayName(visit);
  const minutesHere = Math.max(0, Math.floor((now.getTime() - new Date(visit.opened_at).getTime()) / 60_000));
  const tone = visit.status === 'in_progress' ? 'in_progress' : 'arrived';
  const arrivalLabel = visit.arrival_type === 'walk_in' ? 'Walk-in' : 'Appointment';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        padding: theme.space[4],
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        fontFamily: 'inherit',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        minHeight: 64,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontWeight: theme.type.weight.semibold,
            fontSize: theme.type.size.base,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {arrivalLabel} · here {minutesHere} min
        </p>
      </div>
      <StatusPill tone={tone} size="sm">
        {visit.status === 'in_progress' ? 'In progress' : 'Arrived'}
      </StatusPill>
      <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
    </button>
  );
}

function displayName(v: ActiveVisitRow): string {
  const first = properCase(v.patient_first_name);
  const last = properCase(v.patient_last_name);
  if (!first && !last) return 'Patient';
  return `${first} ${last}`.trim();
}
