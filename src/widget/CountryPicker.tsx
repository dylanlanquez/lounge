import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { theme } from '../theme/index.ts';
import { PHONE_COUNTRIES, type PhoneCountry } from './countries.ts';

// Phone-country picker for the widget Details step.
//
// Mirrors the visual chrome of components/DropdownSelect (panel
// rendered via a portal, anchored to the trigger via fixed
// position, click-outside / Escape close, 48px-tall rows) but uses
// a custom item shape: trigger shows flag + dial, panel rows show
// flag + name + dial. The shared DropdownSelect doesn't support
// per-item custom rendering, so we build this one locally rather
// than extend the shared component.
//
// Width-flexible. The phone field passes a fixed-width wrapper
// around it; the picker fills that wrapper.

export function CountryPicker({
  value,
  onChange,
  ariaLabel = 'Country code',
}: {
  value: string;
  onChange: (code: string) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLUListElement | null>(null);
  const listboxId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  const selected: PhoneCountry =
    PHONE_COUNTRIES.find((c) => c.code === value) ?? PHONE_COUNTRIES[0]!;

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

  const triggerStyle: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: theme.color.bg,
    height: '100%',
    padding: `0 ${theme.space[3]}px`,
    display: 'flex',
    alignItems: 'center',
    gap: theme.space[2],
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    color: theme.color.ink,
    cursor: 'pointer',
    borderRight: `1px solid ${theme.color.border}`,
    minWidth: 96,
    boxSizing: 'border-box',
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex', height: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((o) => !o)}
        style={triggerStyle}
      >
        <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>
          {selected.flag}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>+{selected.dial}</span>
        <ChevronDown size={14} aria-hidden style={{ color: theme.color.inkMuted }} />
      </button>

      {open && triggerRect
        ? createPortal(
            <ul
              ref={panelRef}
              id={listboxId}
              role="listbox"
              style={{
                position: 'fixed',
                // Align panel to the LEFT edge of the trigger and
                // size it wider than the trigger so country names
                // fit. Caps to 320px so the panel doesn't sprawl.
                top: triggerRect.bottom + 4,
                left: triggerRect.left,
                width: 320,
                maxHeight: 320,
                margin: 0,
                padding: theme.space[1],
                listStyle: 'none',
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.input,
                boxShadow: theme.shadow.overlay,
                overflowY: 'auto',
                zIndex: 1000,
              }}
            >
              {PHONE_COUNTRIES.map((c) => {
                const isSelected = c.code === selected.code;
                return (
                  <li
                    key={c.code}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.space[3],
                      padding: `0 ${theme.space[3]}px`,
                      height: 44,
                      cursor: 'pointer',
                      borderRadius: theme.radius.input,
                      fontFamily: 'inherit',
                      fontSize: theme.type.size.sm,
                      color: theme.color.ink,
                      background: isSelected ? theme.color.bg : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (isSelected) return;
                      e.currentTarget.style.background = theme.color.bg;
                    }}
                    onMouseLeave={(e) => {
                      if (isSelected) return;
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>
                      {c.flag}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.label}
                    </span>
                    <span
                      style={{
                        color: theme.color.inkMuted,
                        fontVariantNumeric: 'tabular-nums',
                        flexShrink: 0,
                      }}
                    >
                      +{c.dial}
                    </span>
                    {isSelected ? (
                      <Check size={14} aria-hidden style={{ color: theme.color.accent, flexShrink: 0 }} />
                    ) : null}
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
