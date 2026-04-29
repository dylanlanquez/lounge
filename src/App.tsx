import { lazy, Suspense, useLayoutEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { theme } from './theme/index.ts';
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
          <Route path="/" element={<Navigate to="/schedule" replace />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/walk-in/new" element={<NewWalkIn />} />
          <Route path="/visit/:id" element={<VisitDetail />} />
          <Route path="/visit/:id/pay" element={<Pay />} />
          <Route path="/patient/:id" element={<PatientProfile />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/in-clinic" element={<InClinic />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/arrival/appointment/:id" element={<Arrival />} />
          <Route path="/arrival/walk-in/:id" element={<Arrival />} />
          {/* old aliases */}
          <Route path="/today" element={<Navigate to="/schedule" replace />} />
          <Route path="/dashboard" element={<Navigate to="/schedule" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
