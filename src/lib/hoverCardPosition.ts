// Hover-card positioning shared between VisitorHeatmap and
// VisitorAddressMap. Both render a styled card above the cursor
// when the user hovers a map marker; both run into the same edge
// case — when the marker sits near the top of the visible map
// area, the card's `translate(-50%, -100%)` anchor pushes it
// above the container and out of view.
//
// computeHoverCardPosition takes the cursor coordinates (already
// container-relative), the measured card dimensions, and the
// container's inner width, and returns where to position the
// card. Two adjustments:
//
//   • Vertical flip — prefers above, falls back to below the
//     cursor when there isn't enough room above. Same pattern
//     Linear / Stripe tooltips use.
//
//   • Horizontal clamp — keeps the card inside the container's
//     width so it never overflows the right or left edge. The
//     transform-origin stays at translateX(-50%) so the card is
//     centred on the cursor when there's room, and just shifts
//     toward the constrained edge when it isn't.

export interface HoverPositionInput {
  /** Cursor x relative to the container's top-left. */
  cursorX: number;
  /** Cursor y relative to the container's top-left. */
  cursorY: number;
  /** Measured width of the rendered tooltip. */
  tipWidth: number;
  /** Measured height of the rendered tooltip. */
  tipHeight: number;
  /** Inner width of the container the tooltip sits inside. */
  containerWidth: number;
}

export interface HoverPosition {
  /** Absolute `left` to apply, in container px. */
  left: number;
  /** Absolute `top` to apply, in container px. */
  top: number;
  /** CSS transform — handles centring and the above/below anchor. */
  transform: string;
}

const GAP = 14;
const HORIZONTAL_PAD = 8;

export function computeHoverCardPosition(input: HoverPositionInput): HoverPosition {
  const { cursorX, cursorY, tipWidth, tipHeight, containerWidth } = input;

  const requiredAbove = tipHeight + GAP;
  const side: 'above' | 'below' = cursorY >= requiredAbove ? 'above' : 'below';

  // Centre the card on the cursor, but clamp so its half-width never
  // crosses the container's edge (with a small padding inset).
  const halfWidth = tipWidth / 2;
  const minLeft = halfWidth + HORIZONTAL_PAD;
  const maxLeft = Math.max(minLeft, containerWidth - halfWidth - HORIZONTAL_PAD);
  const left = Math.max(minLeft, Math.min(maxLeft, cursorX));

  const top = side === 'above' ? cursorY - GAP : cursorY + GAP;
  const transform = side === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';

  return { left, top, transform };
}
