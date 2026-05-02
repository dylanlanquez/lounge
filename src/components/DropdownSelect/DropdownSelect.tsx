import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
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

export type DropdownSelectVariant = 'card' | 'inline' | 'text';

export interface DropdownSelectProps<T extends string> {
  // When provided, renders the card-style trigger with the label
  // inside. When omitted, renders the slimmer inline-style trigger
  // and `ariaLabel` is required for screen readers.
  label?: string;
  ariaLabel?: string;
  // When true (only meaningful with `label`), renders a subtle red
  // asterisk after the label. The trigger button gets aria-required
  // so assistive tech surfaces the constraint without relying on the
  // visual marker.
  required?: boolean;
  // Defaults to 'card' when `label` is set, otherwise 'inline'.
  // 'text' renders the trigger as chrome-less inline text + chevron
  // for use inside another card's value row (e.g. the three DOB
  // segments share a single outer card and read as one value line).
  variant?: DropdownSelectVariant;
  value: T | '';
  options: ReadonlyArray<DropdownSelectOption<T> | T>;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}

export function DropdownSelect<T extends string>({
  label,
  ariaLabel,
  required = false,
  variant,
  value,
  options,
  placeholder = 'Choose',
  disabled = false,
  onChange,
}: DropdownSelectProps<T>) {
  const effectiveVariant: DropdownSelectVariant =
    variant ?? (label !== undefined ? 'card' : 'inline');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLUListElement | null>(null);
  const listboxId = useId();
  // Trigger rect captured while open so the panel — rendered via a
  // portal to document.body — can anchor itself with position:fixed
  // and stay attached even when an ancestor scrolls.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  const items = options.map((o) =>
    typeof o === 'string'
      ? ({ value: o, label: o } as { value: T; label: string })
      : ({ value: o.value, label: o.label ?? o.value } as { value: T; label: string })
  );

  // Outside click / Escape close. Wired only when open so an idle
  // dropdown doesn't keep listeners attached. The portal node is
  // outside wrapperRef, so we test panelRef too — otherwise tapping
  // an option would close the dropdown before the option's own
  // mousedown→click sequence could fire.
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

  // Track the trigger's viewport rect while open so the portal panel
  // stays anchored to it. Capture-phase scroll listener catches scrolls
  // on every ancestor (e.g. the BottomSheet's content area) without
  // having to walk the parent chain.
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

  const hasValue = value !== '';
  const selected = items.find((i) => i.value === value);
  const displayLabel = selected?.label ?? placeholder;

  const trigger: CSSProperties =
    effectiveVariant === 'card'
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
      : effectiveVariant === 'inline'
        ? {
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
          }
        : {
            // 'text' variant — chrome-less inline trigger that lives
            // inside another card's value row. Reads as a tappable
            // value phrase + small chevron, no border, no background.
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            padding: 0,
            margin: 0,
            fontFamily: 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
            opacity: disabled ? 0.5 : 1,
            color: theme.color.ink,
          };

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        // inline-flex so the text variant can sit alongside siblings
        // on a single value row; for the card/inline variants the
        // parent already controls width, so this has no visual effect.
        display: effectiveVariant === 'text' ? 'inline-flex' : 'block',
        width: effectiveVariant === 'text' ? 'auto' : '100%',
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={effectiveVariant !== 'card' ? ariaLabel : undefined}
        aria-required={required || undefined}
        style={trigger}
      >
        {effectiveVariant === 'card' ? (
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
              }}
            >
              {displayLabel}
            </span>
          </>
        ) : effectiveVariant === 'inline' ? (
          <span
            style={{
              fontSize: theme.type.size.base,
              color: hasValue ? theme.color.ink : theme.color.inkSubtle,
              fontWeight: hasValue ? theme.type.weight.medium : theme.type.weight.regular,
            }}
          >
            {displayLabel}
          </span>
        ) : (
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
        )}
        {effectiveVariant === 'text' ? (
          <ChevronDown
            size={14}
            aria-hidden
            style={{
              color: theme.color.inkSubtle,
              transform: `rotate(${open ? 180 : 0}deg)`,
              transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              flexShrink: 0,
            }}
          />
        ) : (
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
        )}
      </button>

      {open && triggerRect
        ? createPortal(
            <ul
              ref={panelRef}
              id={listboxId}
              role="listbox"
              style={(() => {
                // Portal'd to document.body to escape every parent
                // overflow:hidden context (the catalogue picker's
                // expansion panel uses overflow:hidden for its grid-
                // rows animation, which would otherwise clip us).
                //
                // Flip-and-cap positioning: render below the trigger
                // when there's room, otherwise above. Cap maxHeight
                // to the available space on the chosen side so the
                // panel never extends past the viewport — without a
                // cap, a trigger near the bottom of the screen would
                // push the first options off the visible area.
                //
                // Down is the natural reading direction, so we only
                // flip up when the panel's *actual* height won't fit
                // below. Earlier this used a fixed 320px threshold,
                // which made every short dropdown (e.g. a 4-row staff
                // picker) flip upward whenever it sat mid-screen
                // because spaceBelow was < 320 even though the panel
                // was only ~200px tall and would have fit comfortably.
                const VIEWPORT_PAD = 12;
                const GAP = 6;
                const ROW_H = 48; // matches the touch-target row height below
                const PANEL_PADDING = theme.space[1] * 2; // top + bottom
                const DESIRED_MAX = 320;
                const viewportH =
                  typeof window === 'undefined' ? 800 : window.innerHeight;
                const spaceBelow = viewportH - triggerRect.bottom - GAP - VIEWPORT_PAD;
                const spaceAbove = triggerRect.top - GAP - VIEWPORT_PAD;
                const naturalHeight = Math.min(
                  items.length * ROW_H + PANEL_PADDING,
                  DESIRED_MAX,
                );
                const openDown =
                  spaceBelow >= naturalHeight || spaceBelow >= spaceAbove;
                const maxHeight = Math.max(
                  120,
                  Math.min(DESIRED_MAX, openDown ? spaceBelow : spaceAbove),
                );
                const top = openDown
                  ? triggerRect.bottom + GAP
                  : triggerRect.top - GAP - maxHeight;
                return {
                  position: 'fixed',
                  top,
                  left: triggerRect.left,
                  // Pin to the trigger's width for the card / inline
                  // variants (the field already controls width), but
                  // for the slim text variant the trigger is just a
                  // value phrase + chevron, ~60px wide. The panel
                  // needs room for the longest option, so floor at
                  // 180px.
                  width: Math.max(triggerRect.width, 180),
                  margin: 0,
                  padding: theme.space[1],
                  listStyle: 'none',
                  background: theme.color.surface,
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.input,
                  boxShadow: theme.shadow.overlay,
                  // Above BottomSheet (1000) and Toast (1100).
                  zIndex: 1200,
                  maxHeight,
                  overflowY: 'auto',
                  animation: `lng-dropdown-enter ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
                } as CSSProperties;
              })()}
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
            </ul>,
            document.body
          )
        : null}

      <style>{`
        @keyframes lng-dropdown-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
