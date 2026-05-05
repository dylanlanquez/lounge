import {
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  forwardRef,
  useId,
  useState,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helper?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  // When true, renders a red asterisk beside the label and forwards
  // `required` to the underlying <input>. The asterisk is the in-app
  // convention for "this field can't be left blank".
  required?: boolean;
  // Locks the field to numeric input — letters and other characters
  // never reach state, even on desktop where inputMode is purely a
  // mobile-keyboard hint. Keystrokes that don't match the format are
  // dropped at keydown, and pasted values are sanitised. Also sets
  // inputMode automatically:
  //   integer  — whole numbers only (denomination counts, durations)
  //   decimal  — digits + at most one decimal point
  //   currency — decimal with at most 2 fraction digits (£ amounts)
  // The component does NOT enforce a leading zero or trim trailing
  // dots — those are presentation concerns the caller decides.
  numericFormat?: 'integer' | 'decimal' | 'currency';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    helper,
    error,
    leadingIcon,
    trailingIcon,
    fullWidth = true,
    required,
    type = 'text',
    id,
    style,
    numericFormat,
    inputMode: inputModeProp,
    onKeyDown: onKeyDownProp,
    onPaste: onPasteProp,
    onChange: onChangeProp,
    ...rest
  },
  ref
) {
  const inputMode =
    inputModeProp ??
    (numericFormat === 'integer'
      ? 'numeric'
      : numericFormat === 'decimal' || numericFormat === 'currency'
        ? 'decimal'
        : undefined);
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
          {required ? (
            <span
              aria-hidden
              style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}
            >
              {' *'}
            </span>
          ) : null}
        </label>
      ) : null}
      <div style={fieldRow}>
        {leadingIcon ? <span style={iconStyle}>{leadingIcon}</span> : null}
        <input
          {...rest}
          id={inputId}
          ref={ref}
          required={required}
          type={effectiveType}
          inputMode={inputMode}
          style={inputStyle}
          onKeyDown={(e) => {
            if (numericFormat) {
              guardNumericKey(e, numericFormat);
            }
            onKeyDownProp?.(e);
          }}
          onPaste={(e) => {
            if (numericFormat) {
              guardNumericPaste(e, numericFormat);
            }
            onPasteProp?.(e);
          }}
          onChange={(e) => {
            if (numericFormat) {
              const cleaned = sanitiseNumeric(e.target.value, numericFormat);
              if (cleaned !== e.target.value) {
                e.target.value = cleaned;
              }
            }
            onChangeProp?.(e);
          }}
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

// ─────────────────────────────────────────────────────────────────────────────
// Numeric input guards
//
// inputMode alone is a hint — desktop browsers ignore it. To make a money or
// count field genuinely impossible to corrupt with letters, we filter at three
// edges: keydown (typed characters), paste (clipboard), and change (anything
// that slips through, e.g. drag-drop or speech-to-text). Together these mean
// the value React sees is always parseable, so downstream Number(…) calls
// can't silently NaN.
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC_NAVIGATION_KEYS = new Set([
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'Enter',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

function guardNumericKey(
  e: ReactKeyboardEvent<HTMLInputElement>,
  format: 'integer' | 'decimal' | 'currency',
) {
  // Always allow navigation, modifier shortcuts (copy/paste/select-all), and
  // anything that isn't a single visible character.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (NUMERIC_NAVIGATION_KEYS.has(e.key)) return;
  if (e.key.length !== 1) return;

  const isDigit = e.key >= '0' && e.key <= '9';
  if (isDigit) {
    if (format === 'currency') {
      // Refuse a 3rd fraction digit when the caret sits past the decimal
      // point — keeps £12.345 from ever appearing.
      const target = e.currentTarget;
      const value = target.value;
      const dot = value.indexOf('.');
      if (dot !== -1) {
        const caret = target.selectionStart ?? value.length;
        const selectionEnd = target.selectionEnd ?? caret;
        const replacing = selectionEnd > caret;
        if (caret > dot && !replacing && value.length - dot - 1 >= 2) {
          e.preventDefault();
        }
      }
    }
    return;
  }
  if ((format === 'decimal' || format === 'currency') && e.key === '.') {
    // Allow at most one decimal point in the value.
    if (e.currentTarget.value.includes('.')) e.preventDefault();
    return;
  }
  e.preventDefault();
}

function guardNumericPaste(
  e: ReactClipboardEvent<HTMLInputElement>,
  format: 'integer' | 'decimal' | 'currency',
) {
  const text = e.clipboardData.getData('text');
  const cleaned = sanitiseNumeric(text, format);
  if (cleaned === text) return;
  e.preventDefault();
  // Manually splice the cleaned value into the existing input — preserves
  // selection replacement semantics that the browser would have done with the
  // raw paste.
  const target = e.currentTarget;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const next = sanitiseNumeric(
    target.value.slice(0, start) + cleaned + target.value.slice(end),
    format,
  );
  // Native setter so React picks the change up via its synthetic event.
  const proto = Object.getPrototypeOf(target);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(target, next);
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function sanitiseNumeric(raw: string, format: 'integer' | 'decimal' | 'currency'): string {
  if (format === 'integer') return raw.replace(/[^0-9]/g, '');
  // Decimal / currency — keep digits and the first decimal point, drop the
  // rest. Currency additionally caps fraction digits at 2.
  const stripped = raw.replace(/[^0-9.]/g, '');
  const dot = stripped.indexOf('.');
  if (dot === -1) return stripped;
  const intPart = stripped.slice(0, dot);
  let fracPart = stripped.slice(dot + 1).replace(/\./g, '');
  if (format === 'currency' && fracPart.length > 2) fracPart = fracPart.slice(0, 2);
  return `${intPart}.${fracPart}`;
}
