import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Checkbox } from '../Checkbox/Checkbox.tsx';

// Multi-select sibling of DropdownSelect. Same trigger chrome (card
// variant only, since multi-select needs a label) but the panel
// renders Checkbox rows so the receptionist can tick several options
// in one open. The panel stays open across ticks; outside-click or
// Escape closes it.
//
// Trigger value display:
//   0 selected     → placeholder
//   1 to N-1       → labels joined with ", " (truncated by overflow)
//   N (= all)      → "All N <noun>" when totalNoun is supplied,
//                    otherwise the label list

export interface MultiSelectDropdownOption<T extends string> {
  value: T;
  label?: string;
}

export interface MultiSelectDropdownProps<T extends string> {
  label: string;
  required?: boolean;
  values: T[];
  options: ReadonlyArray<MultiSelectDropdownOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  onChange: (values: T[]) => void;
  // Optional plural noun for the "all selected" summary, e.g. "items"
  // produces "All 4 items". When omitted the trigger lists labels.
  totalNoun?: string;
}

export function MultiSelectDropdown<T extends string>({
  label,
  required = false,
  values,
  options,
  placeholder = 'Choose',
  disabled = false,
  onChange,
  totalNoun,
}: MultiSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  const items = options.map((o) => ({ value: o.value, label: o.label ?? o.value }));
  const valueSet = new Set(values);
  const selectedItems = items.filter((i) => valueSet.has(i.value));

  // Close on outside pointer / Escape, scoped while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
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

  useLayoutEffect(() => {
    if (!open) {
      setTriggerRect(null);
      return;
    }
    const update = () => {
      if (triggerRef.current) {
        setTriggerRect(triggerRef.current.getBoundingClientRect());
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const toggle = (value: T, checked: boolean) => {
    if (checked) {
      if (!valueSet.has(value)) onChange([...values, value]);
    } else {
      onChange(values.filter((v) => v !== value));
    }
  };

  const hasValue = selectedItems.length > 0;
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const displayLabel = !hasValue
    ? placeholder
    : allSelected && totalNoun
      ? `All ${items.length} ${totalNoun}`
      : selectedItems.map((i) => i.label).join(', ');

  const trigger: CSSProperties = {
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
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required={required || undefined}
        style={trigger}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkMuted,
            letterSpacing: 0,
          }}
        >
          {label}
          {required ? (
            <span
              aria-hidden
              style={{
                color: theme.color.alert,
                marginLeft: 4,
                fontWeight: theme.type.weight.semibold,
              }}
            >
              *
            </span>
          ) : null}
        </span>
        <span
          style={{
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: hasValue ? theme.color.ink : theme.color.inkSubtle,
            letterSpacing: theme.type.tracking.tight,
            // Long comma lists shouldn't push the chevron off the
            // trigger or wrap onto two lines; truncate with an
            // ellipsis instead.
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {displayLabel}
        </span>
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

      {open && triggerRect
        ? createPortal(
            <div
              ref={panelRef}
              id={listboxId}
              role="listbox"
              aria-multiselectable="true"
              style={{
                position: 'fixed',
                top: triggerRect.bottom + 6,
                left: triggerRect.left,
                width: triggerRect.width,
                margin: 0,
                padding: theme.space[1],
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                boxShadow: theme.shadow.overlay,
                zIndex: 1200,
                maxHeight: 320,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                animation: `lng-multidropdown-enter ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
              }}
            >
              {items.map((item) => {
                const isChecked = valueSet.has(item.value);
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={isChecked}
                    onClick={() => toggle(item.value, !isChecked)}
                    style={{
                      appearance: 'none',
                      width: '100%',
                      minHeight: theme.layout.minTouchTarget,
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      background: isChecked ? theme.color.accentBg : 'transparent',
                      border: 'none',
                      borderRadius: 10,
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.space[3],
                      fontSize: theme.type.size.base,
                      fontWeight: isChecked ? theme.type.weight.semibold : theme.type.weight.medium,
                      color: isChecked ? theme.color.accent : theme.color.ink,
                    }}
                  >
                    <Checkbox
                      checked={isChecked}
                      onChange={(v) => toggle(item.value, v)}
                      ariaLabel={item.label}
                      size={20}
                    />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}

      <style>{`
        @keyframes lng-multidropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
