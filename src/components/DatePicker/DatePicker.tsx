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

  // Position the desktop popover relative to the trigger; right-align
  // when it would overflow. Same approach as DateRangePicker.
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
      const fitsOnRight = rect.left + APPROX_W <= window.innerWidth - POPOVER_PAD;
      setPopoverPos(
        fitsOnRight
          ? { top: rect.bottom + 6, left: rect.left }
          : { top: rect.bottom + 6, right: window.innerWidth - rect.right },
      );
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, isMobile, anchorRef]);

  if (!open) return null;

  const stepMonth = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  const handlePick = (iso: string) => {
    if (minIso && iso < minIso) return;
    if (maxIso && iso > maxIso) return;
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
              (maxIso ? cell.iso > maxIso : false)
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

  const discBg = isSelected ? theme.color.accent : 'transparent';
  const discFg = isSelected
    ? theme.color.surface
    : cell.outside || disabled
    ? theme.color.inkSubtle
    : isToday
    ? theme.color.accent
    : theme.color.ink;
  const discWeight =
    isSelected || isToday
      ? theme.type.weight.semibold
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
