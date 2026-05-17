import { useState } from 'react';
import { QUIZ } from './quizTokens.ts';
import { useCanHover } from './useCanHover.ts';

// Shared arch-picker tile. Used by every step that asks "which arch?"
// — denture_repair, same_day_appliance, click_in_veneers, and any
// future same-day product that flags arch_match='single' in its
// catalogue row. Replaces the OptionCard + radio rendering the
// non-denture arch steps previously used, so every service's arch
// question reads the same: centred title, short subtitle, no radio
// indicator, selection conveyed by the accent border and a faint
// scale-up.
//
// The component is intentionally arch-axis-specific: it accepts a
// fixed `upper | lower | both` enum and a 3-tile grid. Generalising
// further (arbitrary option counts) would re-introduce the
// inconsistency between this picker and OptionCard — by keeping the
// API tight we ensure every arch surface produces the same DOM.

export type ArchKey = 'upper' | 'lower' | 'both';

export interface ArchTileOption {
  value: ArchKey;
  title: string;
  subtitle: string;
}

export interface ArchTilePickerProps {
  /** The three options to render. Order is preserved; callers
   *  typically pass upper / lower / both in that left-to-right
   *  reading order. Subtitle is per-service copy. */
  options: ReadonlyArray<ArchTileOption>;
  /** Currently selected arch — drives the accent border, scale,
   *  and the dim treatment on the other tiles. */
  selectedValue: ArchKey | null | undefined;
  /** Brand accent (navy for venneir, brand colour for denture). */
  accent: string;
  /** Fired on tile tap. */
  onSelect: (value: ArchKey) => void;
}

export function ArchTilePicker({
  options,
  selectedValue,
  accent,
  onSelect,
}: ArchTilePickerProps) {
  return (
    <div
      className="vlounge-stagger"
      style={{
        display: 'grid',
        // 220px min-cell keeps three tiles in a single row on most
        // phones (≥660px width inside the modal) while still
        // collapsing cleanly to a stacked column on very narrow
        // screens. 800px cap stops the trio stretching across
        // ultra-wide desktops where the tiles would otherwise
        // become disproportionately large.
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
        margin: '0 auto',
        maxWidth: 800,
        width: '100%',
      }}
    >
      {options.map((opt) => (
        <ArchTile
          key={opt.value}
          title={opt.title}
          subtitle={opt.subtitle}
          selected={selectedValue === opt.value}
          anySelected={!!selectedValue}
          accent={accent}
          onSelect={() => onSelect(opt.value)}
        />
      ))}
    </div>
  );
}

function ArchTile({
  title,
  subtitle,
  selected,
  anySelected,
  accent,
  onSelect,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  anySelected: boolean;
  accent: string;
  onSelect: () => void;
}) {
  const canHover = useCanHover();
  const [hovered, setHovered] = useState(false);
  const dimmed = anySelected && !selected;
  // Hover state only engages on devices with a real hovering pointer
  // (mouse / trackpad). Touch devices skip it entirely — iOS Safari's
  // sticky hover state would otherwise paint a tapped-but-not-selected
  // tile with the accent border, which reads as a false selection.
  const showLift = canHover && hovered && !selected;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${title}, ${subtitle}`}
      onMouseEnter={canHover ? () => setHovered(true) : undefined}
      onMouseLeave={canHover ? () => setHovered(false) : undefined}
      style={{
        position: 'relative',
        background: QUIZ.SURFACE,
        // Border ONLY follows selected (or mouse-hover on desktop).
        // canHover gates the hover branch so touch devices never
        // paint an accent border without a real selection.
        border: `2px solid ${selected ? accent : canHover && hovered ? accent : 'transparent'}`,
        borderRadius: QUIZ.R_CARD,
        // Shorter tiles so three of them fit above the fold on phones
        // alongside the step heading. Padding tightens proportionally
        // so the title + subtitle still breathe inside.
        padding: '16px 16px',
        minHeight: 86,
        textAlign: 'center',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: `all 0.2s ${QUIZ.EASE_CARD}, transform 0.15s ${QUIZ.EASE_CARD}`,
        transform: selected ? 'scale(1.01)' : showLift ? 'translateY(-2px)' : 'none',
        boxShadow: showLift ? QUIZ.SHADOW_LIFT : 'none',
        opacity: dimmed ? 0.6 : 1,
        animation: `vlounge-fadeInUp 0.3s ${QUIZ.EASE_BOUNCE} backwards`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 19,
          fontWeight: 600,
          color: QUIZ.INK,
          letterSpacing: '-0.01em',
          lineHeight: 1.2,
        }}
      >
        {title}
      </span>
      <span
        style={{
          fontSize: 13,
          color: selected ? accent : QUIZ.MUTED,
          fontWeight: 500,
          lineHeight: 1.4,
        }}
      >
        {subtitle}
      </span>
    </button>
  );
}
