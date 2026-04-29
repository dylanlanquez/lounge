import {
  type CSSProperties,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// In-app dropdown for single-select fields.
//
// Replaces the browser's native <select> wherever the form chrome
// matters: the kiosk needs visual consistency with the rest of the
// app's bespoke controls, and the system picker feels foreign next
// to it. Two visual variants:
//
//   - "card"   — when `label` is supplied. Mirrors EditableFieldCard's
//                silhouette (sentence-case label inside the box, value
//                shown big below). Used standalone, e.g. the sex
//                picker on the customer details step.
//   - "inline" — when `label` is omitted. Single-row input chrome.
//                Used inside a FieldBlock that already supplies its
//                own eyebrow label, e.g. the shade picker inside the
//                catalogue picker's expansion panel.
//
// The dropdown panel is anchored beneath the trigger and closes on
// outside click or Escape. Item rows are 48px tall (theme touch
// target) so they're comfortable on a kiosk.

export interface DropdownSelectOption<T extends string> {
  value: T;
  label?: string;
}

export interface DropdownSelectProps<T extends string> {
  // When provided, renders the card-style trigger with the label
  // inside. When omitted, renders the slimmer inline-style trigger
  // and `ariaLabel` is required for screen readers.
  label?: string;
  ariaLabel?: string;
  value: T | '';
  options: ReadonlyArray<DropdownSelectOption<T> | T>;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}

export function DropdownSelect<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  placeholder = 'Choose',
  disabled = false,
  onChange,
}: DropdownSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const items = options.map((o) =>
    typeof o === 'string'
      ? ({ value: o, label: o } as { value: T; label: string })
      : ({ value: o.value, label: o.label ?? o.value } as { value: T; label: string })
  );

  // Outside click / Escape close. Wired only when open so an idle
  // dropdown doesn't keep listeners attached.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasValue = value !== '';
  const selected = items.find((i) => i.value === value);
  const displayLabel = selected?.label ?? placeholder;

  const cardVariant = label !== undefined;

  const trigger: CSSProperties = cardVariant
    ? {
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: theme.color.surface,
        border: `1px solid ${open ? theme.color.ink : theme.color.border}`,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        paddingRight: theme.space[8],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        position: 'relative',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        opacity: disabled ? 0.5 : 1,
      }
    : {
        appearance: 'none',
        width: '100%',
        height: theme.layout.inputHeight,
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: theme.color.surface,
        border: `1px solid ${open ? theme.color.ink : theme.color.border}`,
        borderRadius: theme.radius.input,
        padding: `0 ${theme.space[8]}px 0 ${theme.space[3]}px`,
        display: 'flex',
        alignItems: 'center',
        position: 'relative',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        opacity: disabled ? 0.5 : 1,
      };

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={cardVariant ? undefined : ariaLabel}
        style={trigger}
      >
        {cardVariant ? (
          <>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.inkMuted,
                letterSpacing: 0,
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: hasValue ? theme.color.ink : theme.color.inkSubtle,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {displayLabel}
            </span>
          </>
        ) : (
          <span
            style={{
              fontSize: theme.type.size.base,
              color: hasValue ? theme.color.ink : theme.color.inkSubtle,
              fontWeight: hasValue ? theme.type.weight.medium : theme.type.weight.regular,
            }}
          >
            {displayLabel}
          </span>
        )}
        <ChevronDown
          size={18}
          aria-hidden
          style={{
            position: 'absolute',
            right: theme.space[4],
            top: '50%',
            color: theme.color.inkSubtle,
            transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
            transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            pointerEvents: 'none',
          }}
        />
      </button>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            margin: 0,
            padding: theme.space[1],
            listStyle: 'none',
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            boxShadow: theme.shadow.overlay,
            zIndex: 20,
            maxHeight: 320,
            overflowY: 'auto',
            animation: `lng-dropdown-enter ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
          }}
        >
          {items.map((item) => {
            const isSelected = item.value === value;
            return (
              <li key={item.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                  style={{
                    appearance: 'none',
                    width: '100%',
                    minHeight: theme.layout.minTouchTarget,
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    background: isSelected ? theme.color.accentBg : 'transparent',
                    border: 'none',
                    borderRadius: 10,
                    padding: `${theme.space[2]}px ${theme.space[3]}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.space[3],
                    fontSize: theme.type.size.base,
                    fontWeight: isSelected ? theme.type.weight.semibold : theme.type.weight.medium,
                    color: isSelected ? theme.color.accent : theme.color.ink,
                  }}
                >
                  <span>{item.label}</span>
                  {isSelected ? <Check size={16} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <style>{`
        @keyframes lng-dropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
