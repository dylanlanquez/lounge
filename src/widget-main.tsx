import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { theme } from './theme/index.ts';

// Customer-facing entry for the legacy iframe widget at
// book.venneir.com. The widget source has been relocated to
// src/widgets/shared/ so the new per-brand bundles can fork their
// own steps off the same shared core; this entry point still ships
// the original full-screen flow unchanged. The bundle contains zero
// staff-app code — by construction, not just route guards — because
// nothing in this entry tree imports outside src/widgets/shared/
// (and shared libs).
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
  import('./widgets/shared/Widget.tsx').then((m) => ({ default: m.Widget })),
);
const Manage = lazy(() =>
  import('./widgets/shared/Manage.tsx').then((m) => ({ default: m.Manage })),
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
