import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { theme } from './theme/index.ts';

// Customer-facing entry. Built into a separate Vercel project at
// book.venneir.com so the bundle that lands on patient devices
// contains zero staff-app code — by construction, not just by
// route guards. Anything outside src/widget/* (Schedule, Admin,
// Reports, the auth provider, the kiosk status bar, …) is
// tree-shaken out because nothing in this entry tree imports it.
//
// Routes are kept intentionally thin:
//
//   /book                — main booking flow (Widget)
//   /manage              — patient self-serve cancel / reschedule
//   /widget/book         — back-compat for emails / iframes that
//   /widget/manage         still point at the old paths
//   /                     — redirect to /book
//   anything else         — redirect to /book

const Widget = lazy(() =>
  import('./widget/Widget.tsx').then((m) => ({ default: m.Widget })),
);
const Manage = lazy(() =>
  import('./widget/Manage.tsx').then((m) => ({ default: m.Manage })),
);

function BootFallback() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.color.bg,
        color: theme.color.inkMuted,
        fontFamily: theme.type.family,
        fontSize: theme.type.size.sm,
      }}
    >
      Loading…
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<BootFallback />}>
        <Routes>
          <Route path="/book" element={<Widget />} />
          <Route path="/manage" element={<Manage />} />
          {/* Old /widget/* paths kept so existing confirmation
              email links and iframe embeds keep working. */}
          <Route path="/widget/book" element={<Widget />} />
          <Route path="/widget/manage" element={<Manage />} />
          <Route path="/" element={<Navigate to="/book" replace />} />
          <Route path="*" element={<Navigate to="/book" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
