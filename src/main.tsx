import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { applyGlobalStyles } from './theme/globalStyles.ts';
import { installScrollGuard } from './lib/installScrollGuard.ts';

applyGlobalStyles();
// Block iPad rubber-band on pages whose content already fits. The
// body is pinned (globalStyles) but #root accepts touch as scroll
// regardless of content; without this guard a short Schedule day
// or a settled visit still has a millimetre of elastic give that
// reads as "the page is wobbly" on a kiosk. See
// src/lib/installScrollGuard.ts for the why.
installScrollGuard();

// Register the service worker so Chrome recognises Lounge as installable.
// Network-only strategy — see public/sw.js. Skip in dev to avoid Vite HMR
// confusion.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[lounge] service worker registration failed', err);
    });
  });
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
