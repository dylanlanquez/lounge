import { lazy, Suspense, useLayoutEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import { useCurrentAccount } from './lib/queries/currentAccount.ts';
import { theme } from './theme/index.ts';
import { Button } from './components/Button/Button.tsx';
import { BottomNav } from './components/BottomNav/BottomNav.tsx';
import { KioskStatusBar } from './components/KioskStatusBar/KioskStatusBar.tsx';
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary.tsx';

const SignIn = lazy(() => import('./routes/SignIn.tsx').then((m) => ({ default: m.SignIn })));
const Schedule = lazy(() => import('./routes/Schedule.tsx').then((m) => ({ default: m.Schedule })));
const NewWalkIn = lazy(() => import('./routes/NewWalkIn.tsx').then((m) => ({ default: m.NewWalkIn })));
const VisitDetail = lazy(() => import('./routes/VisitDetail.tsx').then((m) => ({ default: m.VisitDetail })));
const Pay = lazy(() => import('./routes/Pay.tsx').then((m) => ({ default: m.Pay })));
const PatientProfile = lazy(() => import('./routes/PatientProfile.tsx').then((m) => ({ default: m.PatientProfile })));
const Patients = lazy(() => import('./routes/Patients.tsx').then((m) => ({ default: m.Patients })));
const InClinic = lazy(() => import('./routes/InClinic.tsx').then((m) => ({ default: m.InClinic })));
const Admin = lazy(() => import('./routes/Admin.tsx').then((m) => ({ default: m.Admin })));
const Arrival = lazy(() => import('./routes/Arrival.tsx').then((m) => ({ default: m.Arrival })));
const NotFound = lazy(() => import('./routes/NotFound.tsx').then((m) => ({ default: m.NotFound })));

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: theme.color.inkMuted,
        fontSize: theme.type.size.sm,
      }}
    >
      Loading…
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <KioskStatusBar />
      <ScrollToTop />
      <RoutedErrorBoundary />
      <BottomNav />
    </AuthProvider>
  );
}

// Resets the document scroll to the top whenever the URL pathname
// changes. Without this React Router preserves whatever scroll
// position the previous route was at — so navigating from the
// bottom of the patient list to a patient profile lands halfway
// down the profile, the patients pagination next-button keeps you
// at the same y-position on a fresh result set, etc.
//
// The page scroll lives on #root (body is pinned to viewport so
// the iOS rubber-band can't drag the fixed bars), so we scroll
// that element rather than window.
//
// useLayoutEffect (not useEffect) so the scroll fires before the
// browser paints the new route — no visible jump from old position
// to top.
function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.getElementById('root')?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Gates every route except /sign-in and /no-access on Lounge staff
// membership. The check is two-step: must be signed in, AND must have
// an active row in lng_staff_members (or be the super admin). Non-
// staff Meridian users land on /no-access — they shouldn't see the
// till at all, even briefly.
function RequireStaff({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  if (authLoading || accountLoading) return <RouteFallback />;
  if (!user) return <Navigate to="/sign-in" replace />;
  if (!account || !account.is_lng_staff) return <Navigate to="/no-access" replace />;
  return <>{children}</>;
}

function NoAccess() {
  const { signOut, user } = useAuth();
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: theme.space[6],
      }}
    >
      <div style={{ maxWidth: 480, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <h1 style={{ margin: 0, fontSize: theme.type.size.xxl, fontWeight: theme.type.weight.semibold }}>
          No access to Lounge
        </h1>
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.md, lineHeight: 1.5 }}>
          {user?.email
            ? `${user.email} is signed in, but isn't on the Lounge staff list.`
            : "You're signed in but not on the Lounge staff list."}
          {' '}Ask the clinic admin to add you, or sign out and try a different account.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button variant="primary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

// Re-key the boundary on pathname so navigating to a fresh route always
// drops back to a clean tree even if the previous one was stuck on an
// error. The Suspense fallback also lives inside the boundary so a
// chunk-load failure surfaces the same "something broke" surface
// instead of a blank loading screen.
function RoutedErrorBoundary() {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RequireStaff><Navigate to="/schedule" replace /></RequireStaff>} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/no-access" element={<NoAccess />} />
          <Route path="/schedule" element={<RequireStaff><Schedule /></RequireStaff>} />
          <Route path="/walk-in/new" element={<RequireStaff><NewWalkIn /></RequireStaff>} />
          <Route path="/visit/:id" element={<RequireStaff><VisitDetail /></RequireStaff>} />
          <Route path="/visit/:id/pay" element={<RequireStaff><Pay /></RequireStaff>} />
          <Route path="/patient/:id" element={<RequireStaff><PatientProfile /></RequireStaff>} />
          <Route path="/patients" element={<RequireStaff><Patients /></RequireStaff>} />
          <Route path="/in-clinic" element={<RequireStaff><InClinic /></RequireStaff>} />
          <Route path="/admin" element={<RequireStaff><Admin /></RequireStaff>} />
          <Route path="/arrival/appointment/:id" element={<RequireStaff><Arrival /></RequireStaff>} />
          <Route path="/arrival/walk-in/:id" element={<RequireStaff><Arrival /></RequireStaff>} />
          {/* old aliases */}
          <Route path="/today" element={<Navigate to="/schedule" replace />} />
          <Route path="/dashboard" element={<Navigate to="/schedule" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
