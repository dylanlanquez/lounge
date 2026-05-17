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
  // Hard-coded Inter stack — venneir.com loads Inter from its
  // Shopify theme CDN, so on that host the widget already rendered
  // in Inter. Other hosts (denture-services.co.uk, future white-
  // labels) ship theme fonts that don't carry the same polish, so
  // embedHost.ts injects an Inter stylesheet from Google Fonts on
  // every host and we anchor on Inter here. System fonts trail the
  // stack as graceful fallbacks while the webfont loads.
  FONT_STACK: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',

  // ── Modal chrome ───────────────────────────────────────────────
  // The modal frame these live inside is built by embedHost.ts; the
  // numbers here govern the absolute-positioned step container.
  STEP_TOP_OFFSET: 80,          // px from card top to step content
  STEP_BOTTOM_OFFSET: 108,      // px from card bottom (sticky footer height)
  STEP_TOP_OFFSET_MOBILE: 80,
  STEP_BOTTOM_OFFSET_MOBILE: 88,
  // Breathing room beneath every step's H2 title before the option
  // grid / form below. Single source of truth — drives the flex
  // `gap` in StepBody (shell-rendered title path) and the flex `gap`
  // in any step that renders its own inline h2 (currently only
  // RepairBuilder, which needs the chip-above-title affordance).
  // 24 matches the repair step's existing rhythm that Dylan called
  // out as the visual target; bumping from 16 closes the
  // step-to-step inconsistency where the arch step felt crammed
  // (~16px gap) next to the repair step (~24px). No per-step
  // marginTop overrides remain — every step composes from this one
  // value.
  STEP_TITLE_BOTTOM_SPACE: 24,
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

    /* Slide-up sheet — used by RepairBuilder's "Add a repair" sheet.
       Translates from below the viewport with a soft bounce easing,
       paired with the .vlounge-fadeIn on the backdrop overlay so the
       two land together. */
    @keyframes vlounge-sheet-up {
      from { transform: translateY(100%); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }

    /* Success ring + tick — stroke-dashoffset draw-in for the
       booking-confirmation glyph. Ring draws clockwise from the top,
       tick draws after a short delay. Combined feel: ~0.85s motion,
       reads as "completed" without a heavy filled-circle treatment. */
    @keyframes vlounge-success-ring {
      to { stroke-dashoffset: 0; }
    }
    @keyframes vlounge-success-tick {
      to { stroke-dashoffset: 0; }
    }

    /* Progress fill shimmer overlay — ::after pseudo isn't reachable
       from inline styles, so we declare it on the .vlounge-progress-fill
       class and toggle it through className. Gradient mirrors the
       original Venneir retainer-cart storefront widget exactly
       (#adc4d2 → #8badbd → #adc4d2 — a soft blue-grey that the brand
       has used since launch). Dylan briefly tried the brand navy
       here but the blue-grey is the version he wants to live with,
       so this is the canonical reference now. */
    .vlounge-progress-fill {
      position: relative;
      height: 100%;
      background: linear-gradient(90deg,
        #adc4d2 0%,
        #8badbd 50%,
        #adc4d2 100%);
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

    /* "Still" modifier on the progress fill — disables both the
       background-position shine AND the ::after shimmer overlay so
       the bar sits perfectly static. Used on the Payment step where
       the Pay button is the only thing that should pulse. */
    .vlounge-progress-fill--still {
      animation: none !important;
    }
    .vlounge-progress-fill--still::after {
      animation: none !important;
      opacity: 0;
    }

    /* Pay-button glisten — a soft white gradient sweeps across the
       navy CTA so the button hints "press me" without being noisy.
       Continuous translateX combined with opacity fades at the
       start and end of the cycle: the gradient becomes invisible
       before it teleports back to the start, so the loop reads as
       a single smooth pulse with a beat of rest between repeats
       instead of the earlier "snap-back-to-left" glitch. */
    @keyframes vlounge-pay-shimmer {
      0%   { transform: translateX(-130%) skewX(-18deg); opacity: 0; }
      15%  { opacity: 1; }
      50%  { transform: translateX(180%) skewX(-18deg); opacity: 1; }
      60%  { transform: translateX(180%) skewX(-18deg); opacity: 0; }
      100% { transform: translateX(180%) skewX(-18deg); opacity: 0; }
    }
    .vlounge-pay-shimmer {
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }
    .vlounge-pay-shimmer::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 35%;
      height: 100%;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0) 0%,
        rgba(255, 255, 255, 0.22) 50%,
        rgba(255, 255, 255, 0) 100%
      );
      animation: vlounge-pay-shimmer 3.6s ease-in-out infinite;
      pointer-events: none;
      z-index: 1;
      opacity: 0;
    }

    /* Footer button hover/active treatment.
       Previously the Next + Back buttons set their hover transform
       inline via onMouseEnter / onMouseLeave React handlers. On iOS
       Safari that's the classic hover-then-click pitfall: the first
       tap fires the emulated mouseenter (styles change), and the
       click only registers on a second tap — except sometimes the
       hover state sticks and the click never fires at all until the
       user taps somewhere else. From the customer's POV the button
       "doesn't work."
       The fix is to scope the hover styles to devices that actually
       support hover, via @media (hover: hover) + :hover, and use
       :active for the touch press affordance. Hands off the click
       path completely on touchscreens.
       touch-action: manipulation kills iOS Safari's 300ms tap delay
       and the double-tap-zoom gesture for these specific controls. */
    .vlounge-next-btn,
    .vlounge-back-btn,
    .vlounge-close-btn {
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
    }
    @media (hover: hover) {
      .vlounge-next-btn:not(:disabled):hover {
        transform: translateY(-1px);
        box-shadow: ${QUIZ.SHADOW_BUTTON_HOVER};
      }
      .vlounge-back-btn:hover {
        background: ${QUIZ.PROGRESS_BACK_BG_HOVER};
        transform: translateY(-1px);
      }
      .vlounge-close-btn:hover {
        transform: scale(1.1);
        opacity: 0.7;
      }
    }
    .vlounge-next-btn:not(:disabled):active {
      transform: translateY(0);
    }
    .vlounge-back-btn:active {
      transform: translateY(0);
    }
    .vlounge-close-btn:active {
      transform: scale(1);
      opacity: 1;
    }

    /* Stagger delays for sets of cards (option-card-vt / addon-item-vt)
       — applied via inline animationDelay too, this is a fallback. */
    .vlounge-stagger > *:nth-child(1) { animation-delay: 0.05s; }
    .vlounge-stagger > *:nth-child(2) { animation-delay: 0.10s; }
    .vlounge-stagger > *:nth-child(3) { animation-delay: 0.15s; }
    .vlounge-stagger > *:nth-child(4) { animation-delay: 0.20s; }
    .vlounge-stagger > *:nth-child(5) { animation-delay: 0.25s; }
    .vlounge-stagger > *:nth-child(6) { animation-delay: 0.30s; }

    /* Footer Today / On-the-day pair stacks on narrow viewports so
       neither label clips on a 360px-wide phone. Divider hides in
       the stack since vertical alignment makes the separator
       redundant. */
    @media (max-width: 480px) {
      .vlounge-footer-price {
        flex-direction: column !important;
        gap: 10px !important;
      }
      .vlounge-footer-price-divider {
        display: none !important;
      }
    }

    /* Denture-repair arch context chip — visible on mobile only.
       On desktop (≥768px) the per-arch title already spells out
       "...your top denture" / "...your bottom denture" with the
       arch words in accent-bold, so the chip becomes redundant and
       just steals vertical space. */
    @media (min-width: 768px) {
      .vlounge-arch-sticky {
        display: none !important;
      }
    }

    /* Option cards (Location / Service / Axis steps): mobile-first
       sizing is set inline so the cards hug their title +
       description on phone-sized viewports — the earlier 130px
       minHeight floor left 30-40px of dead space below short
       cards like Top / Bottom / Both. On tablet+ (≥768px) the
       generous footprint reads better: bigger padding, taller
       minimum height, more breathing between the title and the
       description so the cards feel like polished cards rather
       than tightly-packed list rows. !important is required to
       defeat the inline mobile defaults the button carries. */
    @media (min-width: 768px) {
      .vlounge-option-card {
        padding: 20px !important;
        padding-right: 52px !important;
        min-height: 130px !important;
      }
    }


    /* Success-screen smile-photo grid:
       • Desktop: 3 columns, square tiles side-by-side.
       • Mobile (≤520px): horizontal-snap row so three large
         tiles can stay tappable on a phone instead of squishing
         into thumbnails. Native momentum scroll + scroll-snap so
         each tile lands cleanly under the patient's thumb. */
    .vlounge-photo-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    @media (max-width: 520px) {
      .vlounge-photo-grid {
        display: flex;
        grid-template-columns: none;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
        padding-bottom: 6px;
        /* Tighter scrollbar so the modal doesn't get a heavy iOS
           scroll track underlining the photo row. */
        scrollbar-width: thin;
      }
      .vlounge-photo-grid > * {
        flex: 0 0 70%;
        max-width: 240px;
        scroll-snap-align: start;
      }
      .vlounge-photo-grid::-webkit-scrollbar {
        height: 4px;
      }
      .vlounge-photo-grid::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.12);
        border-radius: 2px;
      }
    }


    /* Thin neutral scrollbar — applied to any scrollable area in
       the widget (step body, popup body, etc) via the
       .vlounge-scroll class. The default OS scrollbar in macOS /
       Windows Chrome is too dark + thick against the modal's
       light surfaces. */
    .vlounge-scroll {
      scrollbar-width: thin;
      scrollbar-color: rgba(0, 0, 0, 0.12) transparent;
    }
    .vlounge-scroll::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .vlounge-scroll::-webkit-scrollbar-track {
      background: transparent;
    }
    .vlounge-scroll::-webkit-scrollbar-thumb {
      background: rgba(0, 0, 0, 0.12);
      border-radius: 3px;
      transition: background 0.15s ease;
    }
    .vlounge-scroll::-webkit-scrollbar-thumb:hover {
      background: rgba(0, 0, 0, 0.22);
    }
  `;
  document.head.appendChild(style);
}
