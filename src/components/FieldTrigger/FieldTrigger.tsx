import { type CSSProperties, type ReactNode, type Ref } from 'react';
import { ChevronDown } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// Inline label-on-top trigger button styled to match Input visually
// (sentence-case label, then a bordered card with leading icon +
// value + trailing chevron) but behaves as a picker opener instead
// of a real <input>. Used wherever we replace a native browser
// picker (date, time, multi-select) with an in-app one — keeps
// every form row reading consistently.
//
// `open` controls the border emphasis: ink-coloured when the
// associated picker is open, default border when closed. Same
// affordance the DateRangePicker trigger uses.

export interface FieldTriggerProps {
  ref: Ref<HTMLButtonElement>;
  label: string;
  // Leading icon — usually a Lucide glyph at size 16. Inherits
  // colour from the wrapper; pass aria-hidden inside the icon so
  // assistive tech doesn't double-announce.
  icon: ReactNode;
  // The current value to display. Empty string falls back to the
  // placeholder rendered in muted ink.
  value: string;
  placeholder: string;
  // True when the associated picker is open — drives the ink
  // border emphasis so the trigger reads as "active".
  open: boolean;
  onClick: () => void;
}

export function FieldTrigger({
  ref,
  label,
  icon,
  value,
  placeholder,
  open,
  onClick,
}: FieldTriggerProps) {
  const wrapper: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space[1],
  };
  const labelStyle: CSSProperties = {
    fontSize: theme.type.size.sm,
    color: theme.color.ink,
    fontWeight: theme.type.weight.medium,
  };
  const buttonStyle: CSSProperties = {
    appearance: 'none',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    cursor: 'pointer',
    background: theme.color.surface,
    border: `1px solid ${open ? theme.color.ink : theme.color.border}`,
    borderRadius: theme.radius.input,
    padding: `${theme.space[3]}px ${theme.space[4]}px`,
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[3],
    transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };
  const valueStyle: CSSProperties = {
    flex: 1,
    fontSize: theme.type.size.md,
    color: value ? theme.color.ink : theme.color.inkSubtle,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={wrapper}>
      <span style={labelStyle}>{label}</span>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onClick}
        style={buttonStyle}
      >
        <span aria-hidden style={{ color: theme.color.inkMuted, display: 'inline-flex' }}>
          {icon}
        </span>
        <span style={valueStyle}>{value || placeholder}</span>
        <ChevronDown size={14} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
      </button>
    </div>
  );
}
