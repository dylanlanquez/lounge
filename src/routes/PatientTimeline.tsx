import { Navigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Calendar, CreditCard, ShoppingCart, User } from 'lucide-react';
import { Avatar, Card, EmptyState, Skeleton, StatusPill } from '../components/index.ts';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { type PatientRow, getPatient, patientFullName } from '../lib/queries/patients.ts';
import { usePatientTimeline } from '../lib/queries/patientTimeline.ts';
import { formatPence } from '../lib/queries/carts.ts';

export function PatientTimeline() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [loadingPatient, setLoadingPatient] = useState(true);
  const { events, visits, appointments, payments, loading } = usePatientTimeline(id);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getPatient(id);
        if (!cancelled) setPatient(p);
      } finally {
        if (!cancelled) setLoadingPatient(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isMobile = useIsMobile(640);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  // Build merged timeline of events / visits / appointments / payments by date desc.
  const items = buildTimeline(events, visits, appointments, payments);

  const totalSpent = payments
    .filter((p) => p.status === 'succeeded')
    .reduce((s, p) => s + p.amount_pence, 0);
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <TopBar variant="subpage" />

        {loadingPatient ? (
          <Skeleton height={64} radius={16} />
        ) : !patient ? (
          <EmptyState title="Patient not found" />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4], marginBottom: theme.space[5] }}>
              <Avatar name={patientFullName(patient)} size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xxl,
                    fontWeight: theme.type.weight.semibold,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {patientFullName(patient)}
                </h1>
                <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                  {patient.internal_ref}
                  {patient.phone ? ` · ${patient.phone}` : ''}
                  {patient.email ? ` · ${patient.email}` : ''}
                </p>
                <div style={{ display: 'flex', gap: theme.space[2], marginTop: theme.space[2], flexWrap: 'wrap' }}>
                  {patient.lwo_ref ? <StatusPill tone="arrived" size="sm">{patient.lwo_ref}</StatusPill> : null}
                  {visits.length > 0 ? (
                    <StatusPill tone="neutral" size="sm">
                      {visits.length} visit{visits.length === 1 ? '' : 's'}
                    </StatusPill>
                  ) : null}
                  {totalSpent > 0 ? (
                    <StatusPill tone="complete" size="sm">
                      Total spent: {formatPence(totalSpent)}
                    </StatusPill>
                  ) : null}
                </div>
              </div>
            </div>

            <Card padding="lg">
              <h2
                style={{
                  margin: 0,
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.semibold,
                  marginBottom: theme.space[4],
                }}
              >
                Timeline
              </h2>

              {loading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                  <Skeleton height={48} />
                  <Skeleton height={48} />
                  <Skeleton height={48} />
                </div>
              ) : items.length === 0 ? (
                <EmptyState title="No history" description="Nothing on file yet for this patient." />
              ) : (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
                  {items.map((item) => (
                    <li
                      key={item.key}
                      style={{ display: 'flex', gap: theme.space[3], position: 'relative' }}
                    >
                      <div
                        style={{
                          width: 32,
                          flexShrink: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: theme.space[1],
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: theme.radius.pill,
                            background: theme.color.accentBg,
                            color: theme.color.accent,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {item.icon}
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0, paddingTop: theme.space[1] }}>
                        <p style={{ margin: 0, fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
                          {item.title}
                        </p>
                        {item.subtitle ? (
                          <p
                            style={{
                              margin: `${theme.space[1]}px 0 0`,
                              fontSize: theme.type.size.sm,
                              color: theme.color.inkMuted,
                            }}
                          >
                            {item.subtitle}
                          </p>
                        ) : null}
                        <p
                          style={{
                            margin: `${theme.space[1]}px 0 0`,
                            fontSize: theme.type.size.xs,
                            color: theme.color.inkSubtle,
                          }}
                        >
                          {new Date(item.at).toLocaleString('en-GB', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </>
        )}
      </div>
    </main>
  );
}

interface TimelineItem {
  key: string;
  at: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
}

function buildTimeline(
  events: ReturnType<typeof usePatientTimeline>['events'],
  visits: ReturnType<typeof usePatientTimeline>['visits'],
  appointments: ReturnType<typeof usePatientTimeline>['appointments'],
  payments: ReturnType<typeof usePatientTimeline>['payments']
): TimelineItem[] {
  const items: TimelineItem[] = [];

  visits.forEach((v) => {
    items.push({
      key: `v-${v.id}`,
      at: v.opened_at,
      title: v.arrival_type === 'walk_in' ? 'Walked in' : 'Arrived for appointment',
      subtitle: `Visit · ${v.status}`,
      icon: <User size={16} />,
    });
    if (v.closed_at) {
      items.push({
        key: `vc-${v.id}`,
        at: v.closed_at,
        title: 'Visit closed',
        subtitle: v.status,
        icon: <ShoppingCart size={16} />,
      });
    }
  });

  appointments.forEach((a) => {
    items.push({
      key: `a-${a.id}`,
      at: a.start_at,
      title: a.event_type_label ?? 'Appointment',
      subtitle: `${a.status}`,
      icon: <Calendar size={16} />,
    });
  });

  payments.forEach((p) => {
    if (p.status !== 'succeeded') return;
    const j = p.payment_journey;
    const label = j === 'klarna' ? 'Klarna' : j === 'clearpay' ? 'Clearpay' : p.method === 'cash' ? 'Cash' : 'Card';
    items.push({
      key: `p-${p.id}`,
      at: p.succeeded_at ?? p.created_at,
      title: `${label} · ${formatPence(p.amount_pence)}`,
      subtitle: 'Payment received',
      icon: <CreditCard size={16} />,
    });
  });

  events.forEach((e) => {
    if (e.event_type === 'walk_in_arrived' || e.event_type === 'visit_arrived') return; // covered by visits
    if (e.event_type === 'payment_succeeded' || e.event_type === 'payment_failed' || e.event_type === 'payment_cancelled') return;
    items.push({
      key: `e-${e.id}`,
      at: e.created_at,
      title: humaniseEventType(e.event_type),
      subtitle: e.notes ?? undefined,
      icon: <User size={16} />,
    });
  });

  return items.sort((a, b) => (a.at > b.at ? -1 : 1));
}

function humaniseEventType(t: string): string {
  return t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
