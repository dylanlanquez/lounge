import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, LayoutGrid, ListFilter } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentCategory,
  APPOINTMENT_CATEGORY_LABELS,
  APPOINTMENT_CATEGORY_ORDER,
} from '../../lib/queries/appointments.ts';

export interface ScheduleFilterProps {
  // Per-category booking counts for the day in view. Only categories
  // with at least one booking today are offered — an empty type would
  // just be a dead row, and filtering to it could only ever blank the
  // list.
  counts: Record<AppointmentCategory, number>;
  // The categories the operator has picked to show. The EMPTY set is
  // the default "All booking types" state — no filter. Ticking a type
  // narrows the day to just the ticked types.
  selected: Set<AppointmentCategory>;
  onChange: (next: Set<AppointmentCategory>) => void;
}

const PANEL_WIDTH = 340;

// Filter control for the schedule strip. A toolbar pill that matches the
// sibling actions (Jump to today, New booking) and opens a right-aligned
// popover. Model: nothing ticked = All booking types (the default).
// Ticking one or more types shows only those; "All booking types" clears
// back to the default.
export function ScheduleFilter({ counts, selected, onChange }: ScheduleFilterProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  // Only the types that actually occur today are shown / counted.
  const present = APPOINTMENT_CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) > 0);
  const all = selected.size === 0;
  // What's effectively on screen: everything when nothing is ticked,
  // otherwise the ticked types that exist today.
  const shownPresent = all ? present : present.filter((c) => selected.has(c));
  // "Active" means a type that exists today is being hidden — the only
  // case where the filter changes what's on screen.
  const active = shownPresent.length < present.length;
  const total = present.reduce((n, c) => n + (counts[c] ?? 0), 0);

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

  // Clear back to the default "show everything" state.
  const clear = () => onChange(new Set());

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
        aria-label={
          active
            ? `Filter on, ${shownPresent.length} of ${present.length} booking types shown`
            : 'Filter booking types'
        }
        style={trigger}
      >
        <ListFilter size={16} aria-hidden />
        {active ? 'Filter on' : 'Filter'}
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
            {shownPresent.length}
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
                  padding: `${theme.space[3]}px ${theme.space[4]}px ${theme.space[2]}px`,
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
              </div>

              <div style={{ padding: `0 ${theme.space[1]}px ${theme.space[1]}px` }}>
                {/* Default row — ticked when no type filter is set. Tap to
                    clear back to showing the whole day. */}
                <AllRow total={total} allSelected={all} onClick={clear} />
                <div
                  aria-hidden
                  style={{
                    height: 1,
                    background: theme.color.border,
                    margin: `${theme.space[1]}px ${theme.space[2]}px`,
                  }}
                />
                {present.map((cat) => (
                  <FilterRow
                    key={cat}
                    color={theme.category[cat]}
                    label={APPOINTMENT_CATEGORY_LABELS[cat]}
                    count={counts[cat] ?? 0}
                    selected={selected.has(cat)}
                    onToggle={() => toggle(cat)}
                  />
                ))}
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

// Square, category-tinted checkbox. Checked fills with the row's colour
// so the control carries the same identity as the strip's colour bar;
// unchecked is a hollow outline. Accent green stands in as the colour
// for the "All" row.
function TickBox({ checked, color }: { checked: boolean; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        borderRadius: 7,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: checked ? color : 'transparent',
        border: checked ? `1.5px solid ${color}` : '1.5px solid rgba(14,20,20,0.22)',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <Check
        size={14}
        strokeWidth={3}
        color={theme.color.surface}
        style={{
          opacity: checked ? 1 : 0,
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      />
    </span>
  );
}

function Row({
  checked,
  onClick,
  ariaLabel,
  box,
  label,
  bold,
  count,
}: {
  checked: boolean;
  onClick: () => void;
  ariaLabel?: string;
  box: ReactNode;
  label: string;
  bold?: boolean;
  count: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        appearance: 'none',
        width: '100%',
        minHeight: theme.layout.minTouchTarget,
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: 'pointer',
        background: checked || hovered ? 'rgba(14,20,20,0.04)' : 'transparent',
        border: 'none',
        borderRadius: theme.radius.input,
        padding: `0 ${theme.space[3]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {box}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: theme.type.size.base,
          fontWeight: bold || checked ? theme.type.weight.semibold : theme.type.weight.medium,
          color: bold || checked ? theme.color.ink : theme.color.inkMuted,
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
    </button>
  );
}

function AllRow({
  total,
  allSelected,
  onClick,
}: {
  total: number;
  allSelected: boolean;
  onClick: () => void;
}) {
  return (
    <Row
      checked={allSelected}
      onClick={onClick}
      label="All booking types"
      bold
      count={total}
      box={
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: 7,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: allSelected ? theme.color.accent : 'transparent',
            border: allSelected
              ? `1.5px solid ${theme.color.accent}`
              : '1.5px solid rgba(14,20,20,0.22)',
          }}
        >
          <LayoutGrid
            size={13}
            color={allSelected ? theme.color.surface : theme.color.inkSubtle}
          />
        </span>
      }
    />
  );
}

function FilterRow({
  color,
  label,
  count,
  selected,
  onToggle,
}: {
  color: string;
  label: string;
  count: number;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <Row
      checked={selected}
      onClick={onToggle}
      label={label}
      count={count}
      box={<TickBox checked={selected} color={color} />}
    />
  );
}
