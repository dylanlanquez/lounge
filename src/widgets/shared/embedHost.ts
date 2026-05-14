// embedHost.ts — modal chrome for the booking widget when it's
// loaded into a partner page (venneir.com / denture-services.co.uk)
// via the per-brand opener script. The chrome is plain DOM with no
// React dependency on purpose: it has to render before the brand
// bundle has finished downloading so the customer sees activity
// within ~16 ms of the click.
//
// Responsibilities:
//   • Build the backdrop + card + close button + initial spinner.
//   • Trap focus inside the modal while it's open.
//   • Lock the host page's body scroll without losing the scroll
//     position on iOS Safari (which forgets it if we just toggle
//     overflow: hidden).
//   • Mount-point handoff: returns the inner element React will
//     mount into once the bundle has loaded.
//   • Esc + backdrop click + close-button click all converge on a
//     single onClose handler so cleanup is symmetric.
//
// Animations respect prefers-reduced-motion. Sizing breaks at
// 768px: mobile = full-bleed 100vw × 100dvh, desktop = centred 720×900
// card. Z-index is 2147483646 (one below max int) so a host-page
// modal on top of us can still win if it really needs to.

const MODAL_ID = 'vlounge-embed-modal';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const SPIN_STYLE_ID = 'vlounge-embed-keyframes';
const RESET_STYLE_ID = 'vlounge-embed-reset';

export interface ModalOpenOptions {
  /** Accessible name announced to screen readers. */
  ariaLabel: string;
  /** Element to return focus to after close (the trigger button). */
  returnFocusTo?: HTMLElement | null;
  /** Called for any close path: backdrop click, Esc, X button. */
  onClose: () => void;
}

export interface ModalHandle {
  /** Root <div> of the modal in the DOM. Use for teardown. */
  root: HTMLElement;
  /** The element React should mount into. */
  mountContainer: HTMLElement;
  /** Programmatic close (also fires onClose). */
  close: () => void;
}

// Open the modal. If one's already open (rare; defensive), the
// existing chrome is dropped first — we never want two stacked
// modals on the same page.
export function openModal(opts: ModalOpenOptions): ModalHandle {
  const existing = document.getElementById(MODAL_ID);
  if (existing) {
    existing.remove();
  }

  ensureKeyframes();
  ensureResetStyles();

  const reducedMotion = window.matchMedia?.(MOTION_QUERY).matches ?? false;
  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', opts.ariaLabel);
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto',
    isolation: 'isolate',
  } as Partial<CSSStyleDeclaration>);

  // Backdrop. Click-to-close lives here; the card stops propagation.
  // Backdrop alpha + blur lifted from #quizModal-vt (retainer-cart
  // line 2) so the dim feels continuous with the storefront.
  const backdrop = document.createElement('div');
  Object.assign(backdrop.style, {
    position: 'absolute',
    inset: '0',
    background: 'rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(5px)',
    WebkitBackdropFilter: 'blur(5px)',
    opacity: reducedMotion ? '1' : '0',
    transition: reducedMotion ? 'none' : 'opacity 200ms ease',
    cursor: 'pointer',
  } as Partial<CSSStyleDeclaration>);

  // Card. Mirrors venneir.com retainer-cart quiz modal dimensions —
  // 97.5vw × 90vh, generous 12px corner, dramatic 30px-blur shadow.
  // Mobile collapses to full-bleed.
  const card = document.createElement('div');
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  Object.assign(card.style, {
    position: 'relative',
    background: '#F4F4F4',
    width: isDesktop ? '97.5vw' : '100vw',
    height: isDesktop ? '90vh' : '100dvh',
    margin: isDesktop ? '1.25vh auto' : '0',
    maxHeight: '100dvh',
    borderRadius: isDesktop ? '12px' : '0',
    boxShadow: isDesktop ? '0 0 30px rgba(0, 0, 0, 0.3)' : 'none',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    transform: reducedMotion ? 'none' : 'scale(0.95) translateY(10px)',
    opacity: reducedMotion ? '1' : '0',
    transition: reducedMotion
      ? 'none'
      : 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms cubic-bezier(0.16, 1, 0.3, 1)',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
    color: '#333',
  } as Partial<CSSStyleDeclaration>);

  // Close button. Matches retainer-cart's .close-vt (line 5): a plain
  // text × character, 28px, no background, no border, no circle. Top
  // -right of the card. 28px keeps the touch target visible without
  // adding chrome that fights the modal's clean look.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close booking');
  closeBtn.textContent = '×';
  Object.assign(closeBtn.style, {
    position: 'absolute',
    top: isDesktop ? '14px' : 'calc(env(safe-area-inset-top, 0px) + 8px)',
    right: '20px',
    width: '32px',
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: '0',
    borderRadius: '0',
    cursor: 'pointer',
    color: '#333',
    padding: '0',
    fontSize: '28px',
    fontFamily: 'inherit',
    lineHeight: '1',
    zIndex: '2',
    transition: 'transform 0.15s ease, opacity 0.15s ease',
  } as Partial<CSSStyleDeclaration>);
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.transform = 'scale(1.1)';
    closeBtn.style.opacity = '0.7';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.transform = 'scale(1)';
    closeBtn.style.opacity = '1';
  });

  // Content slot. Starts as a loading spinner so the customer sees
  // activity within one frame; React replaces this once the brand
  // bundle has loaded + hydrated.
  // mountContainer is the flex slot the React widget mounts into.
  // The widget owns its own flex-column with a Header / scrollable
  // Body / Footer pattern (see Widget.tsx ChromeShell), so this
  // wrapper just stretches to fill remaining vertical space inside
  // the card and clips overflow. Scrolling lives on the Body inside,
  // not here — keeps the Footer pinned without `position: sticky`
  // tricks that fail under iOS over-scroll.
  const mountContainer = document.createElement('div');
  Object.assign(mountContainer.style, {
    flex: '1',
    minHeight: '0',
    overflow: 'hidden',
    position: 'relative',
  } as Partial<CSSStyleDeclaration>);
  mountContainer.appendChild(buildLoadingSpinner());

  card.appendChild(closeBtn);
  card.appendChild(mountContainer);
  root.appendChild(backdrop);
  root.appendChild(card);
  document.body.appendChild(root);

  // Body scroll lock. iOS Safari forgets the scroll position when
  // we toggle overflow: hidden, so we pin the body to its current
  // scroll Y with position: fixed + top: -<scrollY>px and restore on
  // close. Desktop browsers don't need the position trick, but the
  // same code path works there too.
  const scrollY = window.scrollY;
  const previousBodyStyle = {
    overflow: document.body.style.overflow,
    position: document.body.style.position,
    top: document.body.style.top,
    width: document.body.style.width,
  };
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';

  // Focus management. Snapshot the previously-focused element so we
  // can return focus on close (a11y requirement for modals). The
  // initial focus goes to the close button — it's the only element
  // before React mounts so there's nowhere else useful to land.
  const previousFocus = document.activeElement as HTMLElement | null;
  closeBtn.focus();

  // Animate in on the next frame so the browser sees the initial
  // opacity:0 / scale:0.96 state and animates from there.
  if (!reducedMotion) {
    requestAnimationFrame(() => {
      backdrop.style.opacity = '1';
      card.style.opacity = '1';
      card.style.transform = 'scale(1) translateY(0)';
    });
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;

    if (!reducedMotion) {
      backdrop.style.opacity = '0';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95) translateY(10px)';
    }

    document.removeEventListener('keydown', onKey, true);
    root.removeEventListener('focusin', onFocusIn, true);

    // Restore body scroll BEFORE the next frame so the page doesn't
    // visually scroll-jump during the close animation.
    document.body.style.overflow = previousBodyStyle.overflow;
    document.body.style.position = previousBodyStyle.position;
    document.body.style.top = previousBodyStyle.top;
    document.body.style.width = previousBodyStyle.width;
    window.scrollTo(0, scrollY);

    const removeAfterAnimation = () => {
      root.remove();
      const target = opts.returnFocusTo ?? previousFocus;
      if (target && typeof target.focus === 'function') {
        try {
          target.focus({ preventScroll: true });
        } catch {
          // ignore — focus on a removed node can throw in older Safaris
        }
      }
      opts.onClose();
    };

    if (reducedMotion) {
      removeAfterAnimation();
    } else {
      window.setTimeout(removeAfterAnimation, 240);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // Focus trap. The close button is the only stable focusable
      // before React mounts; once React arrives there'll be inputs
      // and buttons inside mountContainer. Query the live set every
      // tab press so the trap stays correct as React re-renders.
      const focusables = collectFocusables(root);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  document.addEventListener('keydown', onKey, true);

  function onFocusIn(e: FocusEvent) {
    // Catch the case where some external script grabs focus while
    // we're open (e.g. Shopify's own quick-shop). Pull it back.
    if (!root.contains(e.target as Node)) {
      e.stopPropagation();
      closeBtn.focus();
    }
  }
  root.addEventListener('focusin', onFocusIn, true);

  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);

  return {
    root,
    mountContainer,
    close,
  };
}

// ─────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────

function ensureKeyframes() {
  if (document.getElementById(SPIN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SPIN_STYLE_ID;
  style.textContent = `@keyframes vlounge-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

// Defensive CSS reset scoped to the modal. Stops Shopify themes from
// reaching into the widget via global selectors like `button { ... }`
// or `body { font-family: ... }`. ID-prefixed so each rule has
// specificity 1-1-1 (ID + class/attr + tag) — wins against the class-
// based selectors most themes use, without resorting to !important.
//
// We deliberately do NOT do `all: initial` (it nukes inherited styles
// React relies on). Instead we lock the small set of properties
// themes most commonly leak: typography, box-sizing, default heading
// margins, list bullets, link colour.
function ensureResetStyles() {
  if (document.getElementById(RESET_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = RESET_STYLE_ID;
  style.textContent = `
    #${MODAL_ID} {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      color: #0E1414;
    }
    #${MODAL_ID} *,
    #${MODAL_ID} *::before,
    #${MODAL_ID} *::after {
      box-sizing: border-box;
    }
    #${MODAL_ID} button,
    #${MODAL_ID} input,
    #${MODAL_ID} select,
    #${MODAL_ID} textarea {
      font-family: inherit;
      font-size: inherit;
      font-weight: inherit;
      line-height: inherit;
      letter-spacing: normal;
      color: inherit;
      text-transform: none;
    }
    #${MODAL_ID} button {
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
    }
    #${MODAL_ID} a {
      color: inherit;
      text-decoration: none;
    }
    #${MODAL_ID} h1,
    #${MODAL_ID} h2,
    #${MODAL_ID} h3,
    #${MODAL_ID} h4,
    #${MODAL_ID} h5,
    #${MODAL_ID} h6,
    #${MODAL_ID} p,
    #${MODAL_ID} figure,
    #${MODAL_ID} blockquote {
      margin: 0;
      font: inherit;
      letter-spacing: inherit;
      color: inherit;
    }
    #${MODAL_ID} ul,
    #${MODAL_ID} ol {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    #${MODAL_ID} img,
    #${MODAL_ID} svg {
      display: block;
      max-width: 100%;
    }
  `;
  document.head.appendChild(style);
}

function buildLoadingSpinner(): HTMLElement {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    gap: '12px',
    color: '#5A6266',
  } as Partial<CSSStyleDeclaration>);

  const spinner = document.createElement('div');
  Object.assign(spinner.style, {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '3px solid rgba(14, 20, 20, 0.08)',
    borderTopColor: 'rgba(14, 20, 20, 0.55)',
    animation: 'vlounge-spin 0.9s linear infinite',
  } as Partial<CSSStyleDeclaration>);

  const label = document.createElement('p');
  label.textContent = 'Loading booking…';
  Object.assign(label.style, {
    margin: '0',
    fontSize: '14px',
    lineHeight: '1.4',
    color: '#5A6266',
    fontFamily: 'inherit',
  } as Partial<CSSStyleDeclaration>);

  wrap.appendChild(spinner);
  wrap.appendChild(label);
  return wrap;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function collectFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  );
}
