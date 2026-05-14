// quizTokens.ts — design tokens + keyframe injection for the
// venneir.com retainer-cart-style booking widget.
//
// Pulled verbatim from /Users/dylan/Downloads/retainer-cart.liquid
// so the embedded widget is visually identical to the venneir.com
// native quiz modal the customer just came from. Each value here is
// referenced inline in the widget components — there is no Tailwind
// or CSS-in-JS dependency, just plain `style={{ ... }}` objects so
// the bundle stays tiny and the runtime touches the DOM only via
// React.
//
// Hover, dim, and checked states are driven by React state (passing
// `isHovered`, `isSelected` props down to leaf elements) rather than
// CSS pseudo-selectors so the styling survives in environments
// where `:has()` isn't reliable (older Safari, embedded WebViews).
//
// Only keyframes + the shimmer pseudo-element overlay live in a
// shared <style> block injected once via ensureQuizKeyframes() —
// CSS animations can't be expressed in inline styles.

export const QUIZ = {
  // ── Colour palette ─────────────────────────────────────────────
  ACCENT: '#083758',         // navy primary
  ACCENT_HOVER: '#0d4670',   // darker navy on hover (matches storefront)
  LAVENDER: '#6f86ff',       // accent — prices, info buttons, savings
  LAVENDER_HOVER: '#5a71e6',
  INK: '#333',
  MUTED: '#555',
  MUTED_2: '#666',
  SUBTLE: '#999',
  SUBTLE_2: '#cfcfcf',
  BORDER: '#e5e5e5',
  BORDER_SOFT: '#f0f0f0',
  BG: '#f4f4f4',
  BG_HOVER: '#f0f0f0',
  SURFACE: '#fff',
  SOFT_BG: '#f8f9fa',
  SOFT_BG_HIGHLIGHT: '#f0f4ff',
  PROGRESS_TRACK: '#e8e8e8',
  PROGRESS_GRAD_START: '#adc4d2',
  PROGRESS_GRAD_MID: '#8badbd',
  PROGRESS_BACK_BG: '#e7e6e6',
  PROGRESS_BACK_BG_HOVER: '#d5d5d5',
  ALERT: '#B83A2A',

  // ── Easing ─────────────────────────────────────────────────────
  EASE_CARD: 'cubic-bezier(0.4, 0, 0.2, 1)',
  EASE_BOUNCE: 'cubic-bezier(0.16, 1, 0.3, 1)',

  // ── Shadows ────────────────────────────────────────────────────
  SHADOW_LIFT: '0 4px 12px rgba(0,0,0,0.08)',
  SHADOW_SOFT: '0 2px 8px rgba(0,0,0,0.06)',
  SHADOW_BUTTON_HOVER: '0 4px 12px rgba(0,0,0,0.15)',
  SHADOW_DEEP: '0 0 30px rgba(0,0,0,0.3)',
  SHADOW_FOOTER: '0 -2px 10px rgba(0,0,0,0.08)',

  // ── Geometry ───────────────────────────────────────────────────
  R_CARD: 12,
  R_INPUT: 8,
  R_PILL: 999,

  // ── Typography ─────────────────────────────────────────────────
  FONT_STACK:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",

  // ── Modal chrome ───────────────────────────────────────────────
  // The modal frame these live inside is built by embedHost.ts; the
  // numbers here govern the absolute-positioned step container.
  STEP_TOP_OFFSET: 80,          // px from card top to step content
  STEP_BOTTOM_OFFSET: 108,      // px from card bottom (sticky footer height)
  STEP_TOP_OFFSET_MOBILE: 80,
  STEP_BOTTOM_OFFSET_MOBILE: 88,
} as const;

// ─────────────────────────────────────────────────────────────────
// Keyframe + pseudo-element <style> injection (once per document)
// ─────────────────────────────────────────────────────────────────
//
// CSS animations and ::after pseudo-elements can't live in inline
// styles. Everything below comes straight from the retainer-cart
// template (lines 4–17, 24, 31, 77 etc) so the motion feels native
// when the modal opens on venneir.com.

const KEYFRAMES_ID = 'vlounge-quiz-keyframes';

export function ensureQuizKeyframes(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;

  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
    /* Modal slide-in — matches .modal-content-vt animation in retainer-cart */
    @keyframes vlounge-modalSlideIn {
      from { opacity: 0; transform: scale(0.95) translateY(10px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    /* Step title fade — matches .step-title-vt */
    @keyframes vlounge-fadeInDown {
      from { opacity: 0; transform: translateY(-10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Option / addon card stagger — matches .option-card-vt, .addon-item-vt */
    @keyframes vlounge-fadeInUp {
      from { opacity: 0; transform: translateY(15px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Plain fade — for content reveals (.price-preview-vt, summary cards) */
    @keyframes vlounge-fadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* Progress bar gradient shift — matches .progress-fill-vt */
    @keyframes vlounge-progressShine {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* Shimmer overlay on top of the progress fill */
    @keyframes vlounge-shimmer {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    /* Info popup slide-in — for the v2 popup pattern */
    @keyframes vlounge-popupSlideIn {
      from { opacity: 0; transform: scale(0.92) translateY(20px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }

    /* Step transition — content opacity + translateY when stepKey changes */
    @keyframes vlounge-stepFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Progress fill shimmer overlay — ::after pseudo isn't reachable
       from inline styles, so we declare it on the .vlounge-progress-fill
       class and toggle it through className. */
    .vlounge-progress-fill {
      position: relative;
      height: 100%;
      background: linear-gradient(90deg,
        ${QUIZ.PROGRESS_GRAD_START} 0%,
        ${QUIZ.PROGRESS_GRAD_MID}   50%,
        ${QUIZ.PROGRESS_GRAD_START} 100%);
      background-size: 200% 100%;
      transition: width 0.35s ${QUIZ.EASE_CARD};
      animation: vlounge-progressShine 2s ease-in-out infinite;
    }
    .vlounge-progress-fill::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg,
        transparent 0%,
        rgba(255,255,255,0.3) 50%,
        transparent 100%);
      animation: vlounge-shimmer 2s ease-in-out infinite;
    }

    /* Stagger delays for sets of cards (option-card-vt / addon-item-vt)
       — applied via inline animationDelay too, this is a fallback. */
    .vlounge-stagger > *:nth-child(1) { animation-delay: 0.05s; }
    .vlounge-stagger > *:nth-child(2) { animation-delay: 0.10s; }
    .vlounge-stagger > *:nth-child(3) { animation-delay: 0.15s; }
    .vlounge-stagger > *:nth-child(4) { animation-delay: 0.20s; }
    .vlounge-stagger > *:nth-child(5) { animation-delay: 0.25s; }
    .vlounge-stagger > *:nth-child(6) { animation-delay: 0.30s; }
  `;
  document.head.appendChild(style);
}
