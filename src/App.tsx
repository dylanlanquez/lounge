import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { SignIn } from './routes/SignIn.tsx';
import { Schedule } from './routes/Schedule.tsx';
import { NewWalkIn } from './routes/NewWalkIn.tsx';
import { VisitDetail } from './routes/VisitDetail.tsx';
import { Pay } from './routes/Pay.tsx';
import { PatientTimeline } from './routes/PatientTimeline.tsx';
import { NotFound } from './routes/NotFound.tsx';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/schedule" replace />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/walk-in/new" element={<NewWalkIn />} />
        <Route path="/visit/:id" element={<VisitDetail />} />
        <Route path="/visit/:id/pay" element={<Pay />} />
        <Route path="/patient/:id" element={<PatientTimeline />} />
        {/* old aliases */}
        <Route path="/today" element={<Navigate to="/schedule" replace />} />
        <Route path="/dashboard" element={<Navigate to="/schedule" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
