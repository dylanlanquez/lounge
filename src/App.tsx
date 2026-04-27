import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { SignIn } from './routes/SignIn.tsx';
import { Today } from './routes/Today.tsx';
import { NewWalkIn } from './routes/NewWalkIn.tsx';
import { VisitDetail } from './routes/VisitDetail.tsx';
import { Pay } from './routes/Pay.tsx';
import { NotFound } from './routes/NotFound.tsx';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/today" element={<Today />} />
        <Route path="/walk-in/new" element={<NewWalkIn />} />
        <Route path="/visit/:id" element={<VisitDetail />} />
        <Route path="/visit/:id/pay" element={<Pay />} />
        {/* /dashboard kept as alias for now — will redirect to /today */}
        <Route path="/dashboard" element={<Navigate to="/today" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
