import type { SVGProps } from 'react';

// Receipt-shaped Financials icon with a £ on its face. We roll our
// own because Lucide's Receipt icon prints a $ glyph, which reads as
// wrong in a UK clinic, and Lucide's PoundSterling is just the £
// character with no receipt context. Visual style matches the rest
// of the lucide-react family (24×24 viewBox, currentColor strokes,
// 2px round caps) so it sits next to the other top-bar icons
// without looking out of place.

export interface ReceiptPoundIconProps
  extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

export function ReceiptPoundIcon({ size = 16, ...rest }: ReceiptPoundIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {/* Receipt body — flat top, notched bottom edge so the silhouette
          reads as a torn receipt strip. */}
      <path d="M5 2 H19 V20.5 L17.5 21.5 L16 20.5 L14.5 21.5 L13 20.5 L11.5 21.5 L10 20.5 L8.5 21.5 L7 20.5 L5.5 21.5 L5 20.5 Z" />
      {/* £ symbol drawn from strokes so its weight matches the body
          outline at every render size. Top hook + stem in one path,
          mid cross-stroke and base rule as separate paths. */}
      <path d="M13.5 8.2 C 12.8 6.9, 10.8 7, 10.2 8.5 C 9.9 9.3, 10 10.3, 10 11.3 V 17" />
      <path d="M9 12.5 H 13" />
      <path d="M8 17 H 15.5" />
    </svg>
  );
}
