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
  /** When true, the pill stretches to the parent's full width and
   *  the tabs scroll horizontally inside. The pill itself stays put,
   *  so its rounded edges remain visible at all scroll positions.
   *  The native horizontal scrollbar is hidden — drag, swipe, or
   *  shift-scroll to move through tabs. Use this when you have more
   *  tabs than will fit and want the pill to keep its shape. */
  scrollable?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  ariaLabel,
  scrollable = false,
}: SegmentedControlProps<T>) {
  const height = size === 'sm' ? 36 : 44;
  const padX = size === 'sm' ? theme.space[3] : theme.space[4];
  const fontSize = size === 'sm' ? theme.type.size.sm : theme.type.size.base;

  const wrap: CSSProperties = scrollable
    ? {
        display: 'block',
        background: 'rgba(14, 20, 20, 0.05)',
        borderRadius: theme.radius.pill,
        padding: 4,
        width: '100%',
        overflow: 'hidden',
      }
    : {
        display: 'inline-flex',
        background: 'rgba(14, 20, 20, 0.05)',
        borderRadius: theme.radius.pill,
        padding: 4,
        gap: 4,
        width: fullWidth ? '100%' : undefined,
      };

  const inner: CSSProperties | null = scrollable
    ? {
        display: 'flex',
        gap: 4,
        overflowX: 'auto',
        // Hide the native scrollbar in every flavour. Firefox uses
        // scrollbar-width; Edge/IE legacy uses ms-overflow-style;
        // WebKit uses ::-webkit-scrollbar (set globally for the
        // .lng-segmented-scroll class via the inline <style> below).
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        // Scroll snapping: `proximity` over `mandatory` so flicks
        // carry their full momentum and only snap when the natural
        // resting point is already near a tab. Pairs with no
        // scroll-snap-stop on the tabs themselves so a fast swipe
        // can travel several tabs at once instead of being braked
        // at every one. scroll-padding matches the pill's internal
        // padding so the snapped tab visually aligns with the
        // pill's content edge, not flush against its rounded border.
        scrollSnapType: 'x proximity',
        scrollPaddingLeft: 4,
        scrollPaddingRight: 4,
      }
    : null;

  const buttonSnap: CSSProperties = scrollable
    ? { scrollSnapAlign: 'start' }
    : {};

  const renderButtons = () =>
    options.map((opt) => {
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
        flexShrink: 0,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        boxShadow: selected ? theme.shadow.card : 'none',
        opacity: opt.disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        outline: 'none',
        ...buttonSnap,
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
    });

  if (scrollable && inner) {
    return (
      <div role="tablist" aria-label={ariaLabel} style={wrap}>
        {/* WebKit scrollbar reset — inline style props don't reach
            pseudo-elements, so the rule lives next to the markup it
            applies to. Targets the inner scroll row only. */}
        <style>{`.lng-segmented-scroll::-webkit-scrollbar{display:none}`}</style>
        <div className="lng-segmented-scroll" style={inner}>
          {renderButtons()}
        </div>
      </div>
    );
  }

  return (
    <div role="tablist" aria-label={ariaLabel} style={wrap}>
      {renderButtons()}
    </div>
  );
}
