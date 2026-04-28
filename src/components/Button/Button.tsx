import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// No focus ring on buttons. The green halo we used previously read as
// an "active" state to staff and confused them — receptionists asked
// "why is this still selected?" after clicking. Keyboard users still
// get the browser's default focus outline (we no longer suppress it
// via `outline: none`), which is enough for kiosk use.

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  showArrow?: boolean;
  loading?: boolean;
  bottomAnchored?: boolean;
}

const HEIGHTS: Record<ButtonSize, number> = {
  sm: 36,
  md: 44,
  lg: theme.layout.primaryButtonHeight,
};

const PADDING_X: Record<ButtonSize, number> = {
  sm: theme.space[4],
  md: theme.space[5],
  lg: theme.space[6],
};

const FONT_SIZE: Record<ButtonSize, number> = {
  sm: theme.type.size.sm,
  md: theme.type.size.base,
  lg: theme.type.size.md,
};

export function Button({
  children,
  variant = 'primary',
  size = 'lg',
  fullWidth = false,
  showArrow = false,
  loading = false,
  bottomAnchored = false,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const isDisabled = disabled || loading;

  const base: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: theme.color.ink,
    fontFamily: 'inherit',
    fontWeight: theme.type.weight.medium,
    fontSize: FONT_SIZE[size],
    height: HEIGHTS[size],
    padding: `0 ${PADDING_X[size]}px`,
    borderRadius: theme.radius.pill,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[2],
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled && !loading ? 0.5 : 1,
    transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    transform: pressed && !isDisabled ? 'scale(0.97)' : 'scale(1)',
    width: fullWidth ? '100%' : 'auto',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    ...(bottomAnchored && {
      position: 'absolute',
      left: theme.space[4],
      right: theme.space[4],
      bottom: `calc(${theme.space[4]}px + env(safe-area-inset-bottom, 0px))`,
      width: 'auto',
    }),
  };

  const variantStyle: CSSProperties =
    variant === 'primary'
      ? {
          background: hover && !isDisabled ? '#000000' : theme.color.ink,
          color: theme.color.surface,
        }
      : variant === 'secondary'
        ? {
            background: hover && !isDisabled ? 'rgba(14,20,20,0.04)' : theme.color.surface,
            color: theme.color.ink,
            boxShadow: `inset 0 0 0 1px ${theme.color.ink}`,
          }
        : {
            background: 'transparent',
            color: theme.color.ink,
            padding: `0 ${theme.space[2]}px`,
            textDecoration: pressed ? 'underline' : 'none',
            textUnderlineOffset: '3px',
          };

  return (
    <button
      type="button"
      disabled={isDisabled}
      style={{ ...base, ...variantStyle, ...style }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onTouchStart={() => setPressed(true)}
      onTouchEnd={() => setPressed(false)}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'lg' ? 20 : 16} style={{ animation: 'lng-spin 0.8s linear infinite' }} /> : null}
      <span>{children}</span>
      {showArrow && !loading ? <ArrowRight size={size === 'lg' ? 20 : 16} /> : null}
      <SpinKeyframes />
    </button>
  );
}

function SpinKeyframes() {
  return (
    <style>{`
      @keyframes lng-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `}</style>
  );
}
