import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { SignIn } from './routes/SignIn.tsx';
import { Today } from './routes/Today.tsx';
import { NotFound } from './routes/NotFound.tsx';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/today" element={<Today />} />
        {/* /dashboard kept as alias for now — will redirect to /today */}
        <Route path="/dashboard" element={<Navigate to="/today" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
