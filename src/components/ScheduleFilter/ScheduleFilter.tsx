import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ListFilter } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentCategory,
  APPOINTMENT_CATEGORY_LABELS,
  APPOINTMENT_CATEGORY_ORDER,
} from '../../lib/queries/appointments.ts';

export interface ScheduleFilterProps {
  // Per-category booking counts for the day in view. Categories with a
  // zero count render as disabled rows so staff can see at a glance
  // which types are absent today without being able to filter to an
  // empty result by accident.
  counts: Record<AppointmentCategory, number>;
  // The categories currently shown. The full set means "no filter".
  selected: Set<AppointmentCategory>;
  onChange: (next: Set<AppointmentCategory>) => void;
}

const TOTAL = APPOINTMENT_CATEGORY_ORDER.length;
const PANEL_WIDTH = 304;

// Filter control for the schedule strip. A toolbar pill that matches the
// sibling actions (Jump to today, New booking) and opens a right-aligned
// popover listing the six booking categories, each with its palette dot
// and live count. Toggling a row shows / hides that type on the day.
export function ScheduleFilter({ counts, selected, onChange }: ScheduleFilterProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  // "Active" = at least one category is hidden. The full set is the
  // resting, no-filter state.
  const active = selected.size !== TOTAL;

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

  // Track the trigger rect while open so the portal panel stays pinned
  // to it through scroll / resize.
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

  const toggle = (cat: AppointmentCategory) => {
    const next = new Set(selected);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    onChange(next);
  };

  const showAll = () => onChange(new Set(APPOINTMENT_CATEGORY_ORDER));

  // The pill borrows the shared toolbar chrome: a 44px subtle-tint pill.
  // When a filter is applied it latches to the accent tint so a glance
  // at the strip tells you the list is scoped.
  const lit = active || open || hovered;
  const trigger: CSSProperties = {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[2],
    height: 44,
    padding: `0 ${theme.space[4]}px`,
    background: lit ? theme.color.accentBg : 'rgba(14,20,20,0.05)',
    border: 'none',
    borderRadius: theme.radius.pill,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    color: lit ? theme.color.accent : theme.color.inkMuted,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };

  // Right-align the panel to the trigger, clamped inside the viewport so
  // it never bleeds off either edge on a narrow tablet.
  const panelLeft = triggerRect
    ? Math.max(
        theme.space[2],
        Math.min(
          triggerRect.right - PANEL_WIDTH,
          window.innerWidth - PANEL_WIDTH - theme.space[2]
        )
      )
    : 0;

  return (
    <div ref={wrapperRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={active ? `Filter, ${selected.size} of ${TOTAL} types shown` : 'Filter booking types'}
        style={trigger}
      >
        <ListFilter size={16} aria-hidden />
        Filter
        {active ? (
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 20,
              height: 20,
              padding: `0 ${theme.space[1]}px`,
              borderRadius: theme.radius.pill,
              background: theme.color.accent,
              color: theme.color.surface,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {selected.size}
          </span>
        ) : null}
      </button>

      {open && triggerRect
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label="Filter booking types"
              style={{
                position: 'fixed',
                top: triggerRect.bottom + theme.space[2],
                left: panelLeft,
                width: PANEL_WIDTH,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                borderRadius: theme.radius.card,
                boxShadow: theme.shadow.overlay,
                zIndex: 1200,
                overflow: 'hidden',
                animation: `lng-schedule-filter-enter ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  borderBottom: `1px solid ${theme.color.border}`,
                }}
              >
                <span
                  style={{
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.medium,
                    color: theme.color.inkSubtle,
                    textTransform: 'uppercase',
                    letterSpacing: theme.type.tracking.wide,
                  }}
                >
                  Booking types
                </span>
                {active ? (
                  <button
                    type="button"
                    onClick={showAll}
                    style={{
                      appearance: 'none',
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.accent,
                    }}
                  >
                    Show all
                  </button>
                ) : null}
              </div>

              <div style={{ padding: theme.space[1] }}>
                {APPOINTMENT_CATEGORY_ORDER.map((cat) => {
                  const count = counts[cat] ?? 0;
                  const isSelected = selected.has(cat);
                  const disabled = count === 0;
                  return (
                    <FilterRow
                      key={cat}
                      color={theme.category[cat]}
                      label={APPOINTMENT_CATEGORY_LABELS[cat]}
                      count={count}
                      selected={isSelected}
                      disabled={disabled}
                      onClick={() => !disabled && toggle(cat)}
                    />
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null}

      <style>{`
        @keyframes lng-schedule-filter-enter {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

function FilterRow({
  color,
  label,
  count,
  selected,
  disabled,
  onClick,
}: {
  color: string;
  label: string;
  count: number;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        appearance: 'none',
        width: '100%',
        minHeight: theme.layout.minTouchTarget,
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        // Selected rows get a faint neutral wash; hover lifts unselected
        // rows the same amount so the surface feels responsive without
        // fighting the per-row colour dot.
        background:
          selected || (hovered && !disabled) ? 'rgba(14,20,20,0.04)' : 'transparent',
        border: 'none',
        borderRadius: theme.radius.input,
        padding: `0 ${theme.space[3]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        opacity: disabled ? 0.4 : 1,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {/* Palette dot — full strength when shown, dimmed when hidden, so
          the row's on/off state reads from the colour alone. */}
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: theme.radius.pill,
          background: color,
          flexShrink: 0,
          opacity: selected ? 1 : 0.3,
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: theme.type.size.base,
          fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
          color: selected ? theme.color.ink : theme.color.inkMuted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkSubtle,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {count}
      </span>
      {/* Fixed-width check column keeps every row's count digits aligned
          whether or not the row is selected. */}
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: theme.color.accent,
          opacity: selected ? 1 : 0,
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <Check size={18} strokeWidth={2.5} />
      </span>
    </button>
  );
}
