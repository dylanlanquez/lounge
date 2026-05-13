// embed/denture.ts — tiny opener for denture-services.co.uk Shopify
// pages. Mirrors widgets/embed/venneir.ts but binds to
// [data-dental-open] triggers and resolves window.__dlounge once the
// React bundle finishes loading. Two openers keep the two brands
// isolated; a page that mistakenly loads both scripts can't have
// venneir steal a denture click or vice versa.
//
// Bundle target: < 5 KB gzipped. The only thing this file imports
// is embedHost.ts; React lands only via dynamic import on click.

import { openModal, type ModalHandle } from '../shared/embedHost.ts';

declare const __DLOUNGE_BUNDLE_URL__: string;

interface MountDataset {
  service?: string;
  product?: string;
  arch?: 'upper' | 'lower' | 'both';
  location?: string;
  shopifyCustomerEmail?: string;
  shopifyCustomerId?: string;
}

interface DloungeApi {
  mount(container: HTMLElement, dataset: MountDataset): void;
  unmount(container: HTMLElement): void;
}

// The bundle sets window.__dlounge via its own `declare global` (see
// widgets/denture/main.tsx). We read it through a local accessor here
// rather than re-declaring the global to keep the embed and bundle
// TS compilations from clashing on the merged interface shape.
function getDlounge(): DloungeApi | undefined {
  return (window as unknown as { __dlounge?: DloungeApi }).__dlounge;
}

(function () {
  if ((window as unknown as { __dloungeEmbedLoaded?: boolean }).__dloungeEmbedLoaded) {
    return;
  }
  (window as unknown as { __dloungeEmbedLoaded?: boolean }).__dloungeEmbedLoaded = true;

  let bundlePromise: Promise<unknown> | null = null;
  let openHandle: ModalHandle | null = null;

  async function ensureBundle(): Promise<void> {
    if (getDlounge()) return;
    if (bundlePromise) {
      await bundlePromise;
      return;
    }
    bundlePromise = import(/* @vite-ignore */ __DLOUNGE_BUNDLE_URL__);
    try {
      await bundlePromise;
    } catch (err) {
      bundlePromise = null;
      throw err;
    }
  }

  async function openFromTrigger(trigger: HTMLElement): Promise<void> {
    const ds = trigger.dataset as MountDataset & DOMStringMap;
    openHandle = openModal({
      ariaLabel: 'Book an appointment with Denture Services',
      returnFocusTo: trigger,
      onClose: () => {
        const api = getDlounge();
        if (openHandle && api) {
          try {
            api.unmount(openHandle.mountContainer);
          } catch {
            // ignore
          }
        }
        openHandle = null;
      },
    });

    try {
      await ensureBundle();
      if (!openHandle) return;
      const api = getDlounge();
      if (!api) {
        throw new Error('Widget bundle loaded but window.__dlounge is missing.');
      }
      openHandle.mountContainer.replaceChildren();
      api.mount(openHandle.mountContainer, {
        service: ds.service,
        product: ds.product,
        arch: ds.arch as MountDataset['arch'],
        location: ds.location,
        shopifyCustomerEmail: ds.shopifyCustomerEmail,
        shopifyCustomerId: ds.shopifyCustomerId,
      });
    } catch (err) {
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
        ? `Network issue: ${err.message}. Refresh the page and try again, or call us.`
        : 'Network issue. Refresh the page and try again, or call us.';
    wrap.appendChild(heading);
    wrap.appendChild(detail);
    return wrap;
  }

  function bindTrigger(el: HTMLElement) {
    const marker = el as HTMLElement & { __dlBound?: boolean };
    if (marker.__dlBound) return;
    marker.__dlBound = true;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openFromTrigger(el);
    });
  }

  function bindAll() {
    document.querySelectorAll<HTMLElement>('[data-dental-open]').forEach(bindTrigger);
  }

  bindAll();
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(bindAll).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
})();
