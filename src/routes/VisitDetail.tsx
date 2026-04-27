import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ShoppingCart } from 'lucide-react';
import { Button, Card, EmptyState, StatusPill } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useVisitDetail } from '../lib/queries/visits.ts';
import { patientFullName } from '../lib/queries/patients.ts';

export function VisitDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { visit, patient, loading } = useVisitDetail(id);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  return (
    <main style={{ minHeight: '100dvh', background: theme.color.bg, padding: theme.space[6] }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <header style={{ marginBottom: theme.space[5] }}>
          <Button variant="tertiary" size="sm" onClick={() => navigate('/today')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <ArrowLeft size={16} /> Today
            </span>
          </Button>
        </header>

        {loading ? (
          <p style={{ color: theme.color.inkMuted }}>Loading visit…</p>
        ) : !visit ? (
          <EmptyState title="Visit not found" description="That visit no longer exists or you do not have access." />
        ) : (
          <>
            <div style={{ marginBottom: theme.space[6] }}>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                {visit.arrival_type === 'walk_in' ? 'Walk-in' : 'Scheduled'} • opened{' '}
                {new Date(visit.opened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </p>
              <h1
                style={{
                  margin: `${theme.space[1]}px 0 ${theme.space[2]}px`,
                  fontSize: theme.type.size.xxl,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                {patient ? patientFullName(patient) : 'Patient'}
              </h1>
              <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
                {patient?.lwo_ref ? <StatusPill tone="arrived" size="sm">{patient.lwo_ref}</StatusPill> : null}
                {patient?.internal_ref ? <StatusPill tone="neutral" size="sm">{patient.internal_ref}</StatusPill> : null}
                <StatusPill tone={visit.status === 'opened' ? 'in_progress' : 'neutral'} size="sm">
                  Status: {visit.status}
                </StatusPill>
              </div>
            </div>

            <Card padding="lg">
              <h2
                style={{
                  margin: 0,
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.semibold,
                }}
              >
                Cart
              </h2>
              <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted }}>
                Cart-building UI ships in slice 7. For now you can return to today and create the next visit.
              </p>

              <EmptyState
                icon={<ShoppingCart size={20} />}
                title="No cart yet"
                description="Slice 7 wires this up. Add a line item, take payment, close the visit."
                action={
                  <Button variant="primary" disabled showArrow>
                    Build cart (slice 7)
                  </Button>
                }
              />
            </Card>

            <div style={{ marginTop: theme.space[6], display: 'flex', gap: theme.space[3], flexWrap: 'wrap' }}>
              <Button variant="secondary" size="md" onClick={() => navigate('/today')}>
                Back to today
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
