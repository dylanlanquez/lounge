// DepositGlyph
//
// "Partial settlement" mark — a 1.5px solid ring wrapping a Lucide
// CircleDashed. The double-stroke (solid outer + dashed inner) reads
// as "money is in, but not all of it", distinguishing deposits from
// the solid BadgeCheck used for fully-settled visits.
//
// Used wherever the staff app surfaces "a deposit has been paid":
//
//   • AppointmentHero pill ("Deposit paid")
//   • AppointmentDetail Deposit card header
//   • Ledger row PaymentLine (deposit_paid state)
//   • TimelineCard "deposit captured" event icon
//
// Visual mirrors Schedule.tsx's DepositLine glyph. Both the ring and
// the inner dashed circle pick up `currentColor` from the host
// surface, so each call site controls tinting through normal text
// colour. Widget bundle keeps a separate inline copy at
// src/widgets/shared/DepositGlyph.tsx to avoid dragging @components
// into the embed — if the visual ever changes here, change it there
// too.

import { CircleDashed } from 'lucide-react';

export interface DepositGlyphProps {
  /** Pixel size of the outer ring. Inner CircleDashed is sized
   *  proportionally. Defaults to 16 to match the rest of the staff
   *  icon family used by DetailSectionHeader / pills. */
  size?: number;
}

export function DepositGlyph({ size = 16 }: DepositGlyphProps) {
  // Inner dashed circle leaves a 3.5px gap on each side of the outer
  // ring at the canonical 20px size (matches Schedule.tsx). Clamped
  // to 8px so the dashes still resolve at the 14px hero-pill size.
  const innerSize = Math.max(8, size - 7);
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 999,
        border: '1.5px solid currentColor',
        flexShrink: 0,
      }}
    >
      <CircleDashed size={innerSize} strokeWidth={2.5} aria-hidden />
    </span>
  );
}
