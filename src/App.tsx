import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { theme } from './theme/index.ts';

const SignIn = lazy(() => import('./routes/SignIn.tsx').then((m) => ({ default: m.SignIn })));
const Schedule = lazy(() => import('./routes/Schedule.tsx').then((m) => ({ default: m.Schedule })));
const NewWalkIn = lazy(() => import('./routes/NewWalkIn.tsx').then((m) => ({ default: m.NewWalkIn })));
const VisitDetail = lazy(() => import('./routes/VisitDetail.tsx').then((m) => ({ default: m.VisitDetail })));
const Pay = lazy(() => import('./routes/Pay.tsx').then((m) => ({ default: m.Pay })));
const PatientTimeline = lazy(() => import('./routes/PatientTimeline.tsx').then((m) => ({ default: m.PatientTimeline })));
const Admin = lazy(() => import('./routes/Admin.tsx').then((m) => ({ default: m.Admin })));
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
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/schedule" replace />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/walk-in/new" element={<NewWalkIn />} />
          <Route path="/visit/:id" element={<VisitDetail />} />
          <Route path="/visit/:id/pay" element={<Pay />} />
          <Route path="/patient/:id" element={<PatientTimeline />} />
          <Route path="/admin" element={<Admin />} />
          {/* old aliases */}
          <Route path="/today" element={<Navigate to="/schedule" replace />} />
          <Route path="/dashboard" element={<Navigate to="/schedule" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
