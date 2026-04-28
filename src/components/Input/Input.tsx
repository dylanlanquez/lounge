import { type InputHTMLAttributes, type CSSProperties, type ReactNode, forwardRef, useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helper?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helper, error, leadingIcon, trailingIcon, fullWidth = true, type = 'text', id, style, ...rest },
  ref
) {
  const reactId = useId();
  const inputId = id ?? `lng-input-${reactId}`;
  const [focused, setFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';
  const effectiveType = isPassword && showPassword ? 'text' : type;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = errorId ?? helperId;

  const wrapper: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space[2],
    width: fullWidth ? '100%' : 'auto',
  };

  const fieldRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    height: theme.layout.inputHeight,
    background: theme.color.surface,
    borderRadius: theme.radius.input,
    paddingLeft: leadingIcon ? theme.space[4] : theme.space[5],
    paddingRight: trailingIcon || isPassword ? theme.space[4] : theme.space[5],
    // Quiet 1px border in normal state. Focus tightens to a darker
    // ink ring so the field reads as live without the green halo.
    // Error always wins regardless of focus.
    boxShadow: error
      ? `inset 0 0 0 1px ${theme.color.alert}`
      : focused
        ? `inset 0 0 0 1px ${theme.color.ink}`
        : `inset 0 0 0 1px ${theme.color.border}`,
    transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    gap: theme.space[3],
  };

  const inputStyle: CSSProperties = {
    flex: 1,
    border: 'none',
    background: 'transparent',
    outline: 'none',
    fontFamily: 'inherit',
    fontSize: theme.type.size.base,
    color: theme.color.ink,
    minWidth: 0,
  };

  const iconStyle: CSSProperties = {
    color: theme.color.inkMuted,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  return (
    <div style={{ ...wrapper, ...style }}>
      {label ? (
        <label
          htmlFor={inputId}
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.ink,
          }}
        >
          {label}
        </label>
      ) : null}
      <div style={fieldRow}>
        {leadingIcon ? <span style={iconStyle}>{leadingIcon}</span> : null}
        <input
          {...rest}
          id={inputId}
          ref={ref}
          type={effectiveType}
          style={inputStyle}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            style={{
              ...iconStyle,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: theme.space[2],
            }}
          >
            {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        ) : trailingIcon ? (
          <span style={iconStyle}>{trailingIcon}</span>
        ) : null}
      </div>
      {error ? (
        <span id={errorId} style={{ fontSize: theme.type.size.sm, color: theme.color.alert }}>
          {error}
        </span>
      ) : helper ? (
        <span id={helperId} style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {helper}
        </span>
      ) : null}
    </div>
  );
});
