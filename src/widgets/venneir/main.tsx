// venneir/main.tsx — entry point lazy-loaded by embed/venneir.js
// after the customer taps a "Book now" trigger on venneir.com.
//
// The opener IIFE creates the modal chrome (backdrop, card, close
// button, loading spinner) the moment the click fires — long before
// this bundle has finished downloading on a slow connection. Once
// vite finishes loading this module, window.__vlounge.mount() is
// invoked with the modal's content slot and the data-attributes
// from the trigger. React mounts in place; no iframe, no nested
// stacking context.
//
// The dataset passed in carries the deep-link pins (service,
// product, arch, location) plus the Shopify customer prefill
// (email, id) — see Widget below for how each is consumed.

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Widget } from '../shared/Widget.tsx';
import { brand } from './brand.ts';

interface MountDataset {
  service?: string;
  product?: string;
  arch?: 'upper' | 'lower' | 'both';
  location?: string;
  shopifyCustomerEmail?: string;
  shopifyCustomerId?: string;
}

interface VloungeApi {
  brand: typeof brand;
  mount(container: HTMLElement, dataset: MountDataset): void;
  unmount(container: HTMLElement): void;
}

declare global {
  interface Window {
    __vlounge?: VloungeApi;
  }
}

// Tracks one React root per mount container so we can unmount
// cleanly on modal close without leaking event listeners or
// localStorage subscriptions.
const roots = new WeakMap<HTMLElement, Root>();

const api: VloungeApi = {
  brand,
  mount(container, dataset) {
    if (roots.has(container)) {
      // Defensive — the opener should never call mount twice on the
      // same container, but if a re-trigger races a slow first
      // render, re-render in place rather than stacking roots.
      roots.get(container)!.render(renderTree(dataset));
      return;
    }
    const root = createRoot(container);
    roots.set(container, root);
    root.render(renderTree(dataset));
  },
  unmount(container) {
    const root = roots.get(container);
    if (!root) return;
    root.unmount();
    roots.delete(container);
  },
};

function renderTree(_dataset: MountDataset) {
  // Brand + prefill wiring lands in a follow-up — Widget today only
  // reads the URL search-param for ?location=, which is empty inside
  // the modal embed. The legacy step machine still renders correctly
  // from scratch; the customer manually picks the missing axes. Once
  // Widget accepts a `prefill` prop, swap in dataset.service /
  // .product / .arch / .location here so click-in-veneers + retainer
  // pages deep-link past the first three steps.
  return (
    <StrictMode>
      <Widget />
    </StrictMode>
  );
}

// Expose to window for the opener. The opener doesn't import this
// module directly — it `await import(...)` it and then reads from
// window after the import resolves, so the API has to live there.
window.__vlounge = api;
