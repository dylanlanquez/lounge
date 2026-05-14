// DepositGlyph
//
// "Partial settlement" mark — a ring of 12 organic-sized dots that
// reads as a dashed circle. The hand-drawn variation in dot sizes
// gives it more character than a uniform Lucide CircleDashed and
// makes "deposit" feel like its own brand mark rather than a
// generic icon.
//
// Used wherever the staff app surfaces "a deposit has been paid":
//
//   • AppointmentHero pill ("Deposit paid")
//   • AppointmentDetail Deposit card header
//   • Ledger row PaymentLine (deposit_paid state)
//   • TimelineCard "deposit captured" event icon
//   • InClinic PaymentPill (deposit_only state)
//
// Filled in `currentColor` so each call site controls tinting
// through normal text colour. Widget bundle keeps a separate inline
// copy at src/widgets/shared/DepositGlyph.tsx to avoid dragging
// @components into the embed — if the path data ever changes here,
// change it there too.

export interface DepositGlyphProps {
  /** Pixel size of the rendered SVG. Defaults to 16 to match the
   *  rest of the staff icon family used by DetailSectionHeader /
   *  pills. */
  size?: number;
}

export function DepositGlyph({ size = 16 }: DepositGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 71.03 69.12"
      fill="currentColor"
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M63.56,18.87c3.61-.6,6.82,1.85,7.39,5.28s-1.79,6.82-5.35,7.39-6.7-1.77-7.31-5.22,1.63-6.85,5.27-7.45Z" />
      <path d="M63.7,35.22c3.51-.52,6.55,1.92,7.04,5.24s-1.85,6.5-5.18,7.01-6.48-1.75-7.06-5.04,1.64-6.68,5.19-7.21Z" />
      <path d="M55.81,49.39c3.37-.42,6.24,2,6.64,5.18s-1.94,6.25-5.18,6.66-6.2-1.87-6.65-5.06,1.75-6.36,5.19-6.78Z" />
      <path d="M41.65,57.72c3.26-.54,6.1,1.68,6.6,4.77s-1.63,6.06-4.76,6.56-5.98-1.55-6.55-4.61,1.43-6.18,4.71-6.73Z" />
      <path d="M25.43,58.15c2.97-.6,5.67,1.33,6.23,4.13s-1.28,5.68-4.16,6.24-5.56-1.23-6.18-4.06,1.1-5.7,4.11-6.31Z" />
      <path d="M12.15,50.41c2.82-.2,5.06,1.97,5.23,4.55.19,2.73-1.88,5.02-4.5,5.24s-5.05-1.8-5.29-4.42,1.7-5.17,4.56-5.37Z" />
      <path d="M3.38,36.97c2.51-.62,4.86.93,5.42,3.31s-.9,4.77-3.31,5.35-4.68-.83-5.33-3.13.69-4.91,3.21-5.53Z" />
      <path d="M3.38,21.34c2.24-.59,4.35.78,4.9,2.84s-.71,4.32-2.84,4.89-4.24-.65-4.86-2.73.54-4.41,2.81-5.01Z" />
      <path d="M11.85,7.76c2.04-.38,3.79,1,4.13,2.9s-.96,3.73-2.86,4.08-3.69-.87-4.1-2.69c-.44-1.94.75-3.9,2.83-4.29Z" />
      <path d="M26.02.03c1.84-.25,3.34,1.07,3.56,2.73s-1,3.3-2.69,3.55-3.28-.93-3.58-2.58c-.31-1.73.83-3.45,2.71-3.7Z" />
      <path d="M42.36.46c1.6-.13,2.82,1.09,2.93,2.49.11,1.52-1.03,2.79-2.45,2.92-1.51.13-2.8-.97-2.96-2.38-.17-1.51.88-2.9,2.49-3.03Z" />
      <path d="M55.83,9.09c1.26-.41,2.5.31,2.86,1.46s-.24,2.48-1.55,2.87c-1.05.31-2.32-.24-2.75-1.45-.38-1.05.14-2.46,1.44-2.88Z" />
    </svg>
  );
}
