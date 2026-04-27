import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  ariaLabel?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  ariaLabel,
}: SegmentedControlProps<T>) {
  const height = size === 'sm' ? 36 : 44;
  const padX = size === 'sm' ? theme.space[3] : theme.space[4];
  const fontSize = size === 'sm' ? theme.type.size.sm : theme.type.size.base;

  const wrap: CSSProperties = {
    display: 'inline-flex',
    background: 'rgba(14, 20, 20, 0.05)',
    borderRadius: theme.radius.pill,
    padding: 4,
    gap: 4,
    width: fullWidth ? '100%' : undefined,
  };

  return (
    <div role="tablist" aria-label={ariaLabel} style={wrap}>
      {options.map((opt) => {
        const selected = opt.value === value;
        const button: CSSProperties = {
          appearance: 'none',
          border: 'none',
          background: selected ? theme.color.surface : 'transparent',
          color: opt.disabled ? theme.color.inkSubtle : selected ? theme.color.ink : theme.color.inkMuted,
          fontFamily: 'inherit',
          fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
          fontSize,
          height,
          padding: `0 ${padX}px`,
          borderRadius: theme.radius.pill,
          cursor: opt.disabled ? 'not-allowed' : 'pointer',
          flex: fullWidth ? 1 : undefined,
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          boxShadow: selected ? theme.shadow.card : 'none',
          opacity: opt.disabled ? 0.5 : 1,
          whiteSpace: 'nowrap',
          outline: 'none',
        };
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-disabled={opt.disabled}
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            style={button}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
