import { Routes, Route } from 'react-router-dom';
import { Home } from './routes/Home.tsx';
import { NotFound } from './routes/NotFound.tsx';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
