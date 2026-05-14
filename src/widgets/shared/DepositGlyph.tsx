// DepositGlyph (widget twin)
//
// Customer-facing copy of the staff app's DepositGlyph — a dashed-arc
// circle wrapping a checkmark, used wherever the booking widget needs
// to mark "deposit". Path data mirrors
// src/components/DepositGlyph/DepositGlyph.tsx; the file is duplicated
// inside the widget bundle so the embed stays self-contained and does
// not drag @components from the staff side into the widget output.
// If the visual ever changes there, change it here too.

export function DepositGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="currentColor"
      aria-hidden
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M9.58,0l.16.03c4.38.34,7.89,3.85,8.23,8.23l.03.16v1.12s-.03.19-.03.19c-.4,4.86-4.65,8.53-9.51,8.21l-.99-.11c-.45-.05-.76-.44-.68-.89.07-.4.47-.67.87-.6,4.65.85,8.86-2.73,8.85-7.38S12.3.78,7.65,1.62c-.41.07-.82-.22-.87-.63-.06-.46.27-.82.72-.87l.75-.09.25-.03h1.09Z" />
      <path d="M4.74,10.23c-.3-.32-.27-.78.02-1.06s.77-.28,1.06.03l1.79,1.89,4.58-4.85c.3-.32.78-.34,1.08-.04s.29.77-.02,1.1l-4.73,5.01c-.52.55-1.31.55-1.83,0l-1.96-2.08Z" />
      <path d="M5.26,15.46c.39.23.5.68.28,1.04s-.68.47-1.06.24c-1.22-.73-2.26-1.7-3.02-2.9-.22-.35-.07-.79.24-.99.34-.22.8-.14,1.03.21.65.98,1.49,1.8,2.52,2.4Z" />
      <path d="M2.76,4.88c-.24.37-.68.46-1.03.25s-.48-.66-.25-1.03c.76-1.19,1.78-2.14,2.98-2.87.38-.23.83-.15,1.07.21s.13.83-.26,1.06c-1.01.59-1.86,1.38-2.51,2.38Z" />
      <path d="M.26,10.99c-.3-1.43-.29-2.6,0-4,.09-.42.46-.69.87-.62s.7.47.61.9c-.26,1.13-.26,2.28,0,3.42.1.42-.18.81-.58.89s-.8-.16-.89-.6Z" />
    </svg>
  );
}
