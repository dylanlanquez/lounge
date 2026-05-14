import { useState, type ReactNode } from 'react';
import { QUIZ } from './quizTokens.ts';

// OptionCard — radio-style card used on Location / Service / Axis
// steps. Matches `.option-card-vt` + `.card-vt` + `.radio-indicator-vt`
// from /Users/dylan/Downloads/retainer-cart.liquid (lines 19–34).
//
// Visual rules (mirroring the storefront):
//   • White surface, 2px transparent border that activates to navy
//     on hover (with a translateY(-2px) lift + soft shadow) and on
//     selected (with scale(1.01)).
//   • Round radio indicator top-right: empty grey ring → filled
//     navy radial-gradient when checked, with a small scale-up.
//   • When ANY card in the group is selected, unselected cards dim
//     to opacity 0.6 so the eye lands on the choice.
//   • fadeInUp stagger handled by the parent `vlounge-stagger` class
//     plus animationDelay; this component doesn't own the delay.
//
// Width: the template fixes cards at 27rem, but in our 97.5vw modal
// that runs out of room on narrow screens. We respect the 27rem
// MAXIMUM and let the card shrink to fill width below that.

export interface OptionCardProps {
  selected: boolean;
  /** Any card in the same group selected. Drives the dim of the
   *  unselected siblings. */
  anySelected: boolean;
  onSelect: () => void;
  /** Brand accent — defaults to QUIZ.ACCENT (navy) when no brand is
   *  in scope. Drives hover border + checked border + radio fill. */
  accent?: string;
  /** Card body. Title + description + (optional) right-aligned price
   *  composed by the caller. */
  children: ReactNode;
  ariaLabel: string;
}

export function OptionCard({
  selected,
  anySelected,
  onSelect,
  accent = QUIZ.ACCENT,
  children,
  ariaLabel,
}: OptionCardProps) {
  const [hovered, setHovered] = useState(false);
  const showLift = hovered && !selected;

  const dimmed = anySelected && !selected;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={ariaLabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        position: 'relative',
        background: QUIZ.SURFACE,
        border: `2px solid ${
          selected || hovered ? accent : 'transparent'
        }`,
        borderRadius: QUIZ.R_CARD,
        padding: '20px',
        paddingRight: '52px', // room for the radio indicator
        minHeight: 130,
        width: '100%',
        maxWidth: '27rem',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `all 0.2s ${QUIZ.EASE_CARD}, transform 0.15s ${QUIZ.EASE_CARD}`,
        transform: selected
          ? 'scale(1.01)'
          : showLift
            ? 'translateY(-2px)'
            : 'none',
        boxShadow: showLift ? QUIZ.SHADOW_LIFT : 'none',
        opacity: dimmed ? 0.6 : 1,
        // Stagger animation kicks in via the parent's
        // `vlounge-stagger` class + this element's animationName.
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
      <RadioIndicator selected={selected} accent={accent} />
    </button>
  );
}

function RadioIndicator({
  selected,
  accent,
}: {
  selected: boolean;
  accent: string;
}) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: 20,
        height: 20,
        borderRadius: '50%',
        border: `2px solid ${selected ? accent : QUIZ.SUBTLE_2}`,
        background: selected
          ? `radial-gradient(${accent} 55%, transparent 56%)`
          : QUIZ.SURFACE,
        transform: selected ? 'scale(1.1)' : 'scale(1)',
        transition: `all 0.2s ${QUIZ.EASE_CARD}`,
      }}
    />
  );
}

// Grid wrapper for OptionCard collections. Flex-wrap so the cards
// line up on desktop (two per row at modal width) and stack on
// mobile. Centred so a single card doesn't drift to the left.

export function OptionGrid({ children }: { children: ReactNode }) {
  return (
    <div
      className="vlounge-stagger"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 20,
        justifyContent: 'center',
        margin: '0 auto',
        maxWidth: '60rem', // two 27rem cards + gap
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card body helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// Each call site composes the inside of an OptionCard with these
// small primitives so the typography stays consistent across
// Location / Service / Axis cards.

export function OptionTitle({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        margin: '0 0 6px',
        fontSize: 19,
        fontWeight: 600,
        color: QUIZ.INK,
        letterSpacing: '-0.01em',
        lineHeight: 1.3,
      }}
    >
      {children}
    </h3>
  );
}

export function OptionDescription({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: '0',
        fontSize: 14,
        color: QUIZ.MUTED,
        lineHeight: 1.45,
      }}
    >
      {children}
    </p>
  );
}

export function OptionMeta({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: '12px 0 0',
        fontSize: 13,
        color: QUIZ.LAVENDER,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </p>
  );
}
