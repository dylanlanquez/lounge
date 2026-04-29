import { type CSSProperties, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// Standard checkbox primitive used across Lounge. Square with a small
// rounded corner, ink-filled when checked, white check glyph at a
// thicker stroke (3) so the tick reads clearly at the kiosk's
// viewing distance.
//
// Backed by a real <input type="checkbox"> kept in the DOM (visually
// hidden but focusable) so keyboard users, screen readers, browser
// autofill and form serialisation all work as expected. Visual state
// is rendered by the sibling <span> we draw ourselves.

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  // Optional label rendered to the right of the box. When omitted,
  // pass an `ariaLabel` so the input is still announced.
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  // Visual size in pixels. Defaults to 22 (matches the previous
  // arrival/waiver checkboxes). Tick scales with the box.
  size?: number;
}

export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  size = 22,
}: CheckboxProps) {
  const wrapper: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[2],
    cursor: disabled ? 'not-allowed' : 'pointer',
    userSelect: 'none',
    opacity: disabled ? 0.5 : 1,
    position: 'relative',
  };

  const box: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    borderRadius: 5,
    background: checked ? theme.color.ink : theme.color.surface,
    border: `1.5px solid ${checked ? theme.color.ink : theme.color.border}`,
    color: theme.color.surface,
    flexShrink: 0,
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };

  return (
    <label style={wrapper}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        disabled={disabled}
        aria-label={!label && ariaLabel ? ariaLabel : undefined}
        // Visually hidden but kept in the DOM so keyboard users can
        // tab into it; the sibling <span> renders the visual state.
        style={{
          position: 'absolute',
          opacity: 0,
          width: 0,
          height: 0,
          pointerEvents: 'none',
          margin: 0,
        }}
      />
      <span aria-hidden style={box}>
        {checked ? <Check size={Math.round(size * 0.65)} strokeWidth={3} /> : null}
      </span>
      {label ? (
        <span
          style={{
            fontSize: theme.type.size.base,
            color: theme.color.ink,
            fontWeight: theme.type.weight.medium,
          }}
        >
          {label}
        </span>
      ) : null}
    </label>
  );
}
