// DepositGlyph (widget twin)
//
// Customer-facing copy of the staff app's DepositGlyph — a 1.5px
// solid ring wrapping a Lucide CircleDashed, signalling "deposit
// secured, balance still to settle". Visual mirrors
// src/components/DepositGlyph/DepositGlyph.tsx; the file is
// duplicated inside the widget bundle so the embed stays
// self-contained and doesn't drag @components from the staff side
// into widget output. If the visual ever changes there, change it
// here too.

import { CircleDashed } from 'lucide-react';

export function DepositGlyph({ size = 18 }: { size?: number }) {
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
