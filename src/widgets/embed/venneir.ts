// embed/venneir.ts — the tiny opener script Shopify pages load
// upfront. Hosted at https://lounge.venneir.com/embed/venneir.js so
// venneir.com themes only need to add one <script> tag to the
// layout once.
//
// Its job is small but critical:
//   1. Bind to every [data-vlounge-open] trigger on the page (and
//      anything Shopify section-rerenders in later).
//   2. On click, instantly render the modal chrome with a loading
//      spinner — the customer sees activity within ~16 ms even on a
//      slow connection.
//   3. Lazy-import the React widget bundle (the larger
//      /widgets/venneir/main.js file) on the first open, then hand
//      control to window.__vlounge.mount() once it resolves.
//   4. Forward the trigger's data-* attributes to the mount call so
//      the widget can pre-pin location / service / product / arch
//      and prefill identity from the Shopify customer.
//
// Bundle target: < 5 KB gzipped. The only thing this file imports
// is embedHost.ts; React is NOT in the dependency tree of this
// build target — it lands only via the dynamic import on click.

import { openModal, type ModalHandle } from '../shared/embedHost.ts';

// Where the React bundle lives. Resolved against the script's own
// URL so we can host elsewhere without recompiling. The vite build
// stamps the actual /widgets/venneir/main.<hash>.js filename in via
// import.meta — see vite.config.ts for the entry naming.
declare const __VLOUNGE_BUNDLE_URL__: string;

interface MountDataset {
  service?: string;
  product?: string;
  arch?: 'upper' | 'lower' | 'both';
  location?: string;
  /** data-repair-variant on the trigger — denture_repair only. */
  repairVariant?: string;
  shopifyCustomerEmail?: string;
  shopifyCustomerId?: string;
}

interface VloungeApi {
  mount(
    container: HTMLElement,
    dataset: MountDataset,
    onClose?: () => void,
  ): void;
  unmount(container: HTMLElement): void;
}

// The bundle sets window.__vlounge via its own `declare global` (see
// widgets/venneir/main.tsx). We read it through a local accessor here
// rather than re-declaring the global to keep the embed and bundle
// TS compilations from clashing on the merged interface shape.
function getVlounge(): VloungeApi | undefined {
  return (window as unknown as { __vlounge?: VloungeApi }).__vlounge;
}

(function () {
  // Idempotency: re-running the script (e.g. a Shopify section
  // re-injects it) shouldn't double-bind triggers or stack modals.
  if ((window as unknown as { __vloungeEmbedLoaded?: boolean }).__vloungeEmbedLoaded) {
    return;
  }
  (window as unknown as { __vloungeEmbedLoaded?: boolean }).__vloungeEmbedLoaded = true;

  let bundlePromise: Promise<unknown> | null = null;
  let openHandle: ModalHandle | null = null;

  async function ensureBundle(): Promise<void> {
    if (getVlounge()) return;
    if (bundlePromise) {
      await bundlePromise;
      return;
    }
    // The bundle URL is stamped at build time; using a runtime
    // constant rather than a literal `import('...')` lets vite emit
    // a hashed filename without our source caring.
    bundlePromise = import(/* @vite-ignore */ __VLOUNGE_BUNDLE_URL__);
    try {
      await bundlePromise;
    } catch (err) {
      // Reset so a later trigger can retry rather than getting stuck
      // on a stale rejected promise.
      bundlePromise = null;
      throw err;
    }
  }

  async function openFromTrigger(trigger: HTMLElement): Promise<void> {
    // Pull the deep-link pins straight off the trigger. Shopify
    // theme blocks render these as data-attributes; the section
    // editor is the source of truth for what each landing page
    // pre-pins.
    const ds = trigger.dataset as MountDataset & DOMStringMap;

    // Render the modal chrome immediately — the customer should
    // see activity within one frame of the click.
    openHandle = openModal({
      ariaLabel: 'Book an appointment with Venneir',
      returnFocusTo: trigger,
      onClose: () => {
        // Unmount React from the container so the bundle doesn't
        // keep listeners alive after close.
        const api = getVlounge();
        if (openHandle && api) {
          try {
            api.unmount(openHandle.mountContainer);
          } catch {
            // Defensive — unmount on an already-unmounted root is
            // not catastrophic; swallow to keep the modal close
            // animation clean.
          }
        }
        openHandle = null;
      },
    });

    try {
      await ensureBundle();
      if (!openHandle) return; // closed before bundle arrived
      const api = getVlounge();
      if (!api) {
        throw new Error('Widget bundle loaded but window.__vlounge is missing.');
      }
      // Clear the loading spinner contents — React will own this slot.
      openHandle.mountContainer.replaceChildren();
      // Capture close before async mount in case openHandle is cleared
      // (e.g. user clicks backdrop while bundle is loading).
      const closeFromHost = openHandle.close;
      api.mount(
        openHandle.mountContainer,
        {
          service: ds.service,
          product: ds.product,
          arch: ds.arch as MountDataset['arch'],
          location: ds.location,
          repairVariant: ds.repairVariant,
          shopifyCustomerEmail: ds.shopifyCustomerEmail,
          shopifyCustomerId: ds.shopifyCustomerId,
        },
        closeFromHost,
      );
    } catch (err) {
      // Bundle download failed — replace the spinner with a tiny
      // human-readable retry surface. Keeping the modal open so the
      // customer doesn't think their click did nothing.
      if (openHandle) {
        openHandle.mountContainer.replaceChildren(buildErrorState(err));
      }
    }
  }

  function buildErrorState(err: unknown): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'padding:40px 24px;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100%;color:#0E1414;font-family:inherit;';
    const heading = document.createElement('h2');
    heading.textContent = "We couldn't load the booking form";
    heading.style.cssText = 'margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em;';
    const detail = document.createElement('p');
    detail.style.cssText = 'margin:0;font-size:14px;color:#5A6266;line-height:1.5;max-width:320px;';
    detail.textContent =
      err instanceof Error
        ? `Network issue: ${err.message}. Refresh the page and try again, or call the clinic.`
        : 'Network issue. Refresh the page and try again, or call the clinic.';
    wrap.appendChild(heading);
    wrap.appendChild(detail);
    return wrap;
  }

  function bindTrigger(el: HTMLElement) {
    const marker = el as HTMLElement & { __vlBound?: boolean };
    if (marker.__vlBound) return;
    marker.__vlBound = true;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openFromTrigger(el);
    });
  }

  function bindAll() {
    document.querySelectorAll<HTMLElement>('[data-vlounge-open]').forEach(bindTrigger);
  }

  // Initial pass + watch for late-added triggers (Shopify section
  // editor, AJAX-rendered product cards, infinite-scroll listings).
  bindAll();
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(bindAll).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
