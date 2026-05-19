// denture/main.tsx — entry point lazy-loaded by embed/denture.js
// after the customer taps a "Book now" trigger on
// denture-services.co.uk. Mirrors widgets/venneir/main.tsx in shape;
// the difference is the brand tokens injected into the React tree
// and the global it exposes (__dlounge for denture, __vlounge for
// venneir — keeps the two bundles isolated so a page mistakenly
// loading both scripts can't have one clobber the other).
//
// The opener IIFE creates the modal chrome before this bundle has
// finished downloading, so the customer always sees activity within
// a frame. The mount call replaces the loading spinner with the
// React Widget once the brand bundle is ready.

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Widget, type WidgetPrefill } from '../shared/Widget.tsx';
import { brand } from './brand.ts';

interface MountDataset {
  service?: string;
  product?: string;
  arch?: 'upper' | 'lower' | 'both';
  location?: string;
  /** denture_repair only — passes through to the catalogue's
   *  repair_variant axis (e.g. 'chip', 'rebase'). */
  repairVariant?: string;
  shopifyCustomerEmail?: string;
  shopifyCustomerId?: string;
  /** When "1", the product picker for same-day appliances renders
   *  an extra "Click-in veneers" cross-service card. Opt-in so a
   *  service-pinned trigger doesn't quietly offer a different
   *  service from underneath the patient. */
  includeClickIn?: string;
}

interface DloungeApi {
  brand: typeof brand;
  /** `onClose` is the close handler from embedHost.ts — wired through
   *  to Widget so the React-rendered close button (inside the widget
   *  header) fires the same close path as Esc / backdrop click. */
  mount(
    container: HTMLElement,
    dataset: MountDataset,
    onClose?: () => void,
  ): void;
  unmount(container: HTMLElement): void;
}

declare global {
  interface Window {
    __dlounge?: DloungeApi;
  }
}

const roots = new WeakMap<HTMLElement, Root>();

const api: DloungeApi = {
  brand,
  mount(container, dataset, onClose) {
    if (roots.has(container)) {
      roots.get(container)!.render(renderTree(dataset, onClose));
      return;
    }
    const root = createRoot(container);
    roots.set(container, root);
    root.render(renderTree(dataset, onClose));
  },
  unmount(container) {
    const root = roots.get(container);
    if (!root) return;
    root.unmount();
    roots.delete(container);
  },
};

function renderTree(dataset: MountDataset, onClose: (() => void) | undefined) {
  const prefill: WidgetPrefill = {
    serviceKey: dataset.service ?? null,
    productKey: dataset.product ?? null,
    arch: dataset.arch ?? null,
    repairVariant: dataset.repairVariant ?? null,
    locationId: dataset.location ?? null,
    shopifyCustomerEmail: dataset.shopifyCustomerEmail ?? null,
    shopifyCustomerId: dataset.shopifyCustomerId ?? null,
    includeClickIn: dataset.includeClickIn === '1',
  };
  return (
    <StrictMode>
      <Widget brand={brand} prefill={prefill} embedded onClose={onClose} />
    </StrictMode>
  );
}

window.__dlounge = api;
