import { Navigate, useNavigate } from 'react-router-dom';
import { Card } from '../components/index.ts';
import { PatientSearch } from '../components/PatientSearch/PatientSearch.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';

// Standalone patient lookup. Reuses PatientSearch from the walk-in
// flow — same query (name / phone / email), same result-row layout.
// Tapping a result drops into the patient timeline at /patient/:id.
export function Patients() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);

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
          Patients
        </h1>
        <p
          style={{
            margin: 0,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.base,
            marginBottom: theme.space[5],
          }}
        >
          Search by name, phone, or email to open a patient's timeline.
        </p>

        <Card padding="lg">
          <PatientSearch
            onPick={(p) => navigate(`/patient/${p.id}`)}
            emptyHint="Type at least two characters to look up by name, phone, or email."
          />
        </Card>
      </div>
    </main>
  );
}
