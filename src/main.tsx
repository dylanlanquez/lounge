import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { applyGlobalStyles } from './theme/globalStyles.ts';

applyGlobalStyles();

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
