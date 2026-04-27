import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './lib/auth.tsx';
import { SignIn } from './routes/SignIn.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { NotFound } from './routes/NotFound.tsx';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/sign-in" replace />} />
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
