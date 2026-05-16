import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { addDaysIso, formatDateIso, todayIso } from '../../lib/calendarMonth.ts';

// DatePicker — single-date picker, distinct from DateRangePicker.
//
// Shape:
//   Desktop (≥ 720px): floating single-month popover anchored to a
//                      caller-supplied trigger ref.
//   Mobile  (< 720px): bottom sheet with the same single-month
//                      calendar.
//
// Interaction: click to commit. The picker is a navigation aid (e.g.
// "jump to this date in the schedule"), not a filter that gates
// expensive queries — Apply-only would just slow it down. If a future
// caller needs the staged-then-Apply pattern (DateRangePicker style),
// build a variant rather than retrofitting this one.
//
// API is controlled: the caller owns `open` + `onClose` and supplies
// the trigger via `anchorRef`. That's because every consumer wants a
// different trigger (the schedule wants its month label, an admin
// page might want a calendar-icon button) and bundling a default
// trigger here would make those callers fight the component.

export interface DatePickerProps {
  open: boolean;
  onClose: () => void;
  // Currently selected date as YYYY-MM-DD (local).
  value: string;
  // Fired on a calendar-cell click. Picker closes immediately after.
  onChange: (iso: string) => void;
  // Ref to whatever element triggered the picker. The popover anchors
  // its top-left under the bottom-left of this element. On mobile the
  // ref isn't used (the BottomSheet doesn't anchor).
  anchorRef: RefObject<HTMLElement | null>;
  // Optional header label shown in the popover and the mobile sheet.
  // Defaults to "Pick a date".
  title?: string;
  // Optional ISO bounds. Cells outside [minIso, maxIso] render dimmed
  // and aren't clickable. Either or both can be omitted.
  minIso?: string;
  maxIso?: string;
  // Optional whitelist. When set, ONLY cells whose iso is in this
  // set render as clickable; everything else dims regardless of
  // the min/max bounds. Used by the booking sheets to disable
  // closed days (clinic closed) and empty days (no slots free)
  // up-front instead of letting the operator tap a dead day.
  // Combined with onMonthChange so the parent can refetch the set
  // for whichever month the user navigates to. Omit to fall back
  // to min/max-only behaviour.
  availableDates?: ReadonlySet<string>;
  // Called whenever the visible month changes (initial mount, prev
  // / next month nav). The parent uses it to refetch
  // `availableDates` for the newly visible window. Args are the
  // first and last YYYY-MM-DD cells the picker is about to render
  // — wider than the calendar month itself because the grid spills
  // into the previous + next month rows.
  onVisibleMonthChange?: (firstIso: string, lastIso: string) => void;
}

const POPOVER_PAD = 16;

export function DatePicker({
  open,
  onClose,
  value,
  onChange,
  anchorRef,
  title = 'Pick a date',
  minIso,
  maxIso,
  availableDates,
  onVisibleMonthChange,
}: DatePickerProps) {
  const isMobile = useIsMobile(720);
  const today = useMemo(() => todayIso(), []);

  // Calendar viewport state — which month is currently shown.
  // Initialised from `value`; resyncs on every open so the picker
  // always lands on the month containing the selected date.
  const initial = useMemo(() => parseIso(value) ?? new Date(), [value]);
  const [year, setYear] = useState(() => initial.getFullYear());
  const [month, setMonth] = useState(() => initial.getMonth());

  useEffect(() => {
    if (!open) return;
    const d = parseIso(value) ?? new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }, [open, value]);

  // Esc to close, regardless of viewport.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Position the desktop popover relative to the trigger, clamped
  // to the viewport so it never hangs off any edge. Flips above
  // the trigger when there's not enough room below — important
  // for sheets where the picker sits near the bottom (e.g. the
  // New Booking sheet's "When" row often opens with the date
  // trigger only a couple of buttons away from the sticky footer).
  // Same approach as DateRangePicker — see that file for rationale.
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const APPROX_W = 320;
      // Approximate popover height (header + 6-row grid + Today
      // button). The exact height varies by content but never
      // exceeds this. Using a constant keeps the position stable
      // across the first paint — measuring after mount would flash
      // the picker at the wrong spot for one frame.
      const APPROX_H = 360;
      const minLeft = POPOVER_PAD;
      const maxLeft = Math.max(
        POPOVER_PAD,
        window.innerWidth - APPROX_W - POPOVER_PAD,
      );
      const desired = rect.left;
      const left = Math.max(minLeft, Math.min(desired, maxLeft));
      // Vertical flip: prefer below the trigger, but if the popover
      // would clip the viewport's bottom edge AND there's more room
      // above, anchor to the trigger's TOP instead. POPOVER_PAD
      // breathing room either side so the popover never kisses
      // the viewport edge.
      const spaceBelow = window.innerHeight - rect.bottom - POPOVER_PAD;
      const spaceAbove = rect.top - POPOVER_PAD;
      const flipUp = spaceBelow < APPROX_H && spaceAbove > spaceBelow;
      const top = flipUp
        ? Math.max(POPOVER_PAD, rect.top - APPROX_H - 6)
        : rect.bottom + 6;
      setPopoverPos({ top, left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, isMobile, anchorRef]);

  // Fire onVisibleMonthChange whenever the displayed month changes
  // (or when the picker opens). Args are the first/last day of the
  // visible 6-row grid — wider than the calendar month itself
  // because the grid spills into the previous + next month rows.
  // The parent uses this to refetch availability for the newly
  // visible window.
  useEffect(() => {
    if (!open || !onVisibleMonthChange) return;
    const cells = buildMonthCells(year, month);
    if (cells.length === 0) return;
    const firstIso = cells[0]!.iso;
    const lastIso = cells[cells.length - 1]!.iso;
    onVisibleMonthChange(firstIso, lastIso);
  }, [open, year, month, onVisibleMonthChange]);

  if (!open) return null;

  const stepMonth = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  const handlePick = (iso: string) => {
    if (minIso && iso < minIso) return;
    if (maxIso && iso > maxIso) return;
    if (availableDates && !availableDates.has(iso)) return;
    onChange(iso);
    onClose();
  };

  // ─── Desktop popover ─────────────────────────────────────────────
  if (!isMobile) {
    if (!popoverPos) return null;
    return createPortal(
      <>
        <div
          aria-hidden
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'transparent',
            zIndex: 8999,
          }}
        />
        <div
          role="dialog"
          aria-label={title}
          style={{
            position: 'fixed',
            top: popoverPos.top,
            left: popoverPos.left,
            right: popoverPos.right,
            zIndex: 9000,
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.card,
            boxShadow: theme.shadow.overlay,
            padding: theme.space[4],
            minWidth: 280,
          }}
        >
          <MonthGrid
            year={year}
            month={month}
            value={value}
            today={today}
            minIso={minIso}
            maxIso={maxIso}
            availableDates={availableDates}
            onPrev={() => stepMonth(-1)}
            onNext={() => stepMonth(+1)}
            onPick={handlePick}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: theme.space[2],
            }}
          >
            <button
              type="button"
              onClick={() => handlePick(today)}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                padding: `${theme.space[1]}px ${theme.space[2]}px`,
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.accent,
                cursor: 'pointer',
              }}
            >
              Today
            </button>
          </div>
        </div>
      </>,
      document.body,
    );
  }

  // ─── Mobile bottom sheet ─────────────────────────────────────────
  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 999,
        }}
      />
      <div
        role="dialog"
        aria-label={title}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '85vh',
          background: theme.color.surface,
          borderTopLeftRadius: theme.radius.card,
          borderTopRightRadius: theme.radius.card,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${theme.space[3]}px ${theme.space[5]}px`,
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: 'none',
              padding: theme.space[2],
              color: theme.color.inkMuted,
              cursor: 'pointer',
            }}
          >
            <X size={20} aria-hidden />
          </button>
        </header>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: `${theme.space[4]}px ${theme.space[5]}px`,
          }}
        >
          <MonthGrid
            year={year}
            month={month}
            value={value}
            today={today}
            minIso={minIso}
            maxIso={maxIso}
            // Mobile path was missing this prop — desktop passed it
            // but mobile rendered every cell as enabled because the
            // whitelist never reached MonthGrid. Result: on phones
            // the reschedule calendar showed closed days and fully-
            // booked days as clickable. Same prop, same source of
            // truth as desktop.
            availableDates={availableDates}
            onPrev={() => stepMonth(-1)}
            onNext={() => stepMonth(+1)}
            onPick={handlePick}
            mobile
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginTop: theme.space[3],
            }}
          >
            <button
              type="button"
              onClick={() => handlePick(today)}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.accent,
                cursor: 'pointer',
              }}
            >
              Today
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Calendar grid ─────────────────────────────────────────────────
//
// Mirrors the layout from DateRangePicker.MonthGrid but with single-
// selection semantics (no range tint, no half-gradient cell wrapper).
// Kept as a local component because the range picker's grid is tied to
// its own from/to state shape and extracting a shared abstraction
// would force both to evolve in lockstep, which they shouldn't.

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface DayCellModel {
  iso: string;
  day: number;
  outside: boolean;
}

function MonthGrid({
  year,
  month,
  value,
  today,
  minIso,
  maxIso,
  availableDates,
  onPrev,
  onNext,
  onPick,
  mobile = false,
}: {
  year: number;
  month: number;
  value: string;
  today: string;
  minIso?: string;
  maxIso?: string;
  /** When provided, only cells whose iso is in this set render
   *  enabled — every other cell dims. Combined with min/max bounds:
   *  a cell that fails ANY check is disabled. Omit to fall back to
   *  min/max-only behaviour. */
  availableDates?: ReadonlySet<string>;
  onPrev: () => void;
  onNext: () => void;
  onPick: (iso: string) => void;
  mobile?: boolean;
}) {
  const cells = useMemo(() => buildMonthCells(year, month), [year, month]);
  const cellSize = mobile ? 44 : 36;
  const discSize = mobile ? 38 : 32;
  const cellFont = mobile ? theme.type.size.sm : 13;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `0 ${theme.space[1]}px`,
          marginBottom: theme.space[2],
        }}
      >
        <ChevronButton ariaLabel="Previous month" onClick={onPrev}>
          <ChevronLeft size={16} aria-hidden />
        </ChevronButton>
        <h3
          style={{
            margin: 0,
            fontSize: mobile ? theme.type.size.md : theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {MONTH_NAMES[month]} {year}
        </h3>
        <ChevronButton ariaLabel="Next month" onClick={onNext}>
          <ChevronRight size={16} aria-hidden />
        </ChevronButton>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0,
        }}
      >
        {WEEKDAY_LABELS.map((d, i) => (
          <div
            key={i}
            aria-hidden
            style={{
              textAlign: 'center',
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.wide,
              color: theme.color.inkSubtle,
              padding: `${theme.space[1]}px 0`,
            }}
          >
            {d}
          </div>
        ))}
        {cells.map((cell) => (
          <DayCell
            key={cell.iso}
            cell={cell}
            value={value}
            today={today}
            cellSize={cellSize}
            discSize={discSize}
            cellFont={cellFont}
            disabled={
              cell.outside ||
              (minIso ? cell.iso < minIso : false) ||
              (maxIso ? cell.iso > maxIso : false) ||
              // availableDates whitelist: when present, anything
              // not in the set is closed/empty and shouldn't be
              // clickable. Cells outside the visible month
              // (cell.outside) already short-circuit above so we
              // don't have to special-case the gutter rows here.
              (availableDates ? !availableDates.has(cell.iso) : false)
            }
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

function buildMonthCells(year: number, month: number): DayCellModel[] {
  // Mon-anchored first-day index (Mon=0…Sun=6). JS getDay() is 0=Sun,
  // hence the (+6)%7 shift to match the Mon-first weekday header.
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells: DayCellModel[] = [];
  for (let i = 0; i < firstDow; i++) {
    const day = daysInPrev - firstDow + 1 + i;
    cells.push({
      iso: formatDateIso(new Date(year, month - 1, day)),
      day,
      outside: true,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      iso: formatDateIso(new Date(year, month, d)),
      day: d,
      outside: false,
    });
  }
  while (cells.length < 42) {
    const d = cells.length - firstDow - daysInMonth + 1;
    cells.push({
      iso: formatDateIso(new Date(year, month + 1, d)),
      day: d,
      outside: true,
    });
  }
  return cells;
}

function DayCell({
  cell,
  value,
  today,
  cellSize,
  discSize,
  cellFont,
  disabled,
  onPick,
}: {
  cell: DayCellModel;
  value: string;
  today: string;
  cellSize: number;
  discSize: number;
  cellFont: number | string;
  disabled: boolean;
  onPick: (iso: string) => void;
}) {
  const isSelected = !cell.outside && cell.iso === value;
  const isToday = !cell.outside && cell.iso === today;

  const wrapperStyle: CSSProperties = {
    height: cellSize,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: disabled ? 'none' : 'auto',
  };

  // Available cells get BOTH the brand-accent digit colour AND a
  // soft accent-tinted background pill, so they read as "tappable"
  // chrome rather than just slightly-different text. Disabled +
  // outside-month cells stay light grey with no pill — they fade
  // into the grid surface. Selected stays as the solid accent
  // disc (white text on full-accent fill). Today keeps semibold
  // weight on top of the pill so it's distinguishable from a
  // generic available cell. Earlier passes (accent text only,
  // weight bump) weren't enough visual separation for Dylan; the
  // pill is the smallest chrome that makes the contrast obvious.
  const isAvailable = !cell.outside && !disabled;
  const discBg = isSelected
    ? theme.color.accent
    : isAvailable
      ? theme.color.accentBg
      : 'transparent';
  const discFg = isSelected
    ? theme.color.surface
    : cell.outside || disabled
    ? theme.color.inkSubtle
    : theme.color.accent;
  const discWeight =
    isSelected || isToday
      ? theme.type.weight.semibold
      : isAvailable
        ? theme.type.weight.medium
        : theme.type.weight.regular;

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        disabled={disabled}
        aria-label={a11yDateLabel(cell.iso)}
        aria-pressed={isSelected}
        aria-current={isToday ? 'date' : undefined}
        onClick={() => onPick(cell.iso)}
        style={{
          width: discSize,
          height: discSize,
          borderRadius: '50%',
          background: discBg,
          color: discFg,
          fontSize: cellFont,
          fontWeight: discWeight,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer',
          appearance: 'none',
          padding: 0,
          transition: `background 100ms ${theme.motion.easing.standard}, color 100ms ${theme.motion.easing.standard}`,
        }}
      >
        {cell.day}
      </button>
    </div>
  );
}

function ChevronButton({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        padding: theme.space[1],
        color: theme.color.inkMuted,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.input,
      }}
    >
      {children}
    </button>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function parseIso(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function a11yDateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// Re-exported because other Schedule-style consumers may want to do
// their own date math after onChange fires (e.g. step ±1 day). Keeps
// a single shared implementation.
export { addDaysIso };
