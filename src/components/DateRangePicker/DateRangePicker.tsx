import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import {
  DATE_RANGE_PRESETS,
  type DateRange,
  type DateRangePresetId,
  dateRangeLabel,
  makeCustomRange,
  resolvePreset,
} from '../../lib/dateRange.ts';
import { addDaysIso, formatDateIso, todayIso } from '../../lib/calendarMonth.ts';

// Universal date-range picker, ported from the Meridian spec at
// /Users/dylan/Desktop/meridian-app/docs/date-range-picker-spec.md.
//
// Two surfaces, switched on viewport width:
//   Desktop (≥ 720px): floating two-month popover with a preset
//                      sidebar on the left, calendars on the right,
//                      and a footer with selection summary + Apply.
//                      Position fixed so it escapes ancestor
//                      overflow:hidden. Outside-click via an invisible
//                      backdrop (the spec explains why this is sturdier
//                      than a document-level mousedown listener).
//   Mobile  (< 720px): bottom sheet with preset chips + a single
//                      calendar (two months won't fit) + sticky Apply.
//
// Selection model is the spec's two-stage click pattern: first click
// sets `from`, second click sets `to`. If the second click is earlier
// than the first, they auto-swap. Same-day click sets a single-day
// range. The pending selection is internal to the picker and only
// fires `onChange` on Apply or preset-click.
//
// API note: value is nullable so a caller can model "no date filter
// selected" honestly — we don't lie with a sentinel range. When value
// is null the trigger shows `placeholder`; clicking opens the picker
// landed on today's month with no pre-selected dates. Pass `onClear`
// to enable an inline X on the trigger that fires the callback so the
// caller can flip back to null. Reports and Financials still pass a
// concrete DateRange and never opt into onClear, so their behaviour
// is unchanged.

export interface DateRangePickerProps {
  value: DateRange | null;
  onChange: (range: DateRange) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Trigger label when value is null. Defaults to 'Choose dates'. */
  placeholder?: string;
  /** When set, an inline X on the trigger calls this to clear the
   * range back to null. Without it, the trigger has no clear affordance
   * — the caller is signalling that the range is always required. */
  onClear?: () => void;
}

const PILL_PADDING_DESKTOP = 8;
const PILL_PADDING_MOBILE = 12;
const SIDEBAR_MIN_WIDTH = 168;
const POPOVER_PAD = 16;

export function DateRangePicker({
  value,
  onChange,
  size = 'md',
  disabled = false,
  placeholder = 'Choose dates',
  onClear,
}: DateRangePickerProps) {
  const isMobile = useIsMobile(720);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);

  // Pending selection — independent of `value` until Apply.
  // `selFrom` / `selTo` are ISO local YYYY-MM-DD or null.
  // `selPreset` tracks whether the pending selection matches a preset
  // (drives sidebar highlight + Apply's resulting DateRange.preset).
  // Set to a preset id on preset click; flipped to 'custom' on any
  // calendar click so the user sees their selection switch to custom.
  const [selFrom, setSelFrom] = useState<string | null>(null);
  const [selTo, setSelTo] = useState<string | null>(null);
  const [selPreset, setSelPreset] = useState<DateRangePresetId>('custom');

  // Calendar viewport state. lYear/lMonth = left calendar, rYear/rMonth
  // = right calendar (desktop only). Independent so users can navigate
  // each side freely, see the spec §5.
  const today = useMemo(() => todayIso(), []);
  const [lYear, setLYear] = useState(() => new Date().getFullYear());
  const [lMonth, setLMonth] = useState(() => new Date().getMonth());
  const [rYear, setRYear] = useState(() => {
    const m = new Date().getMonth();
    return m === 11 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  });
  const [rMonth, setRMonth] = useState(() => (new Date().getMonth() + 1) % 12);

  // ─── Open / close ────────────────────────────────────────────────
  const openPicker = useCallback(() => {
    if (disabled) return;
    if (value === null) {
      // No active range: open with no pending selection, calendars
      // land on the current month + one month ahead so the user has
      // an immediate two-month view without committing to anything.
      setSelFrom(null);
      setSelTo(null);
      setSelPreset('custom');
      const now = new Date();
      setLYear(now.getFullYear());
      setLMonth(now.getMonth());
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      setRYear(next.getFullYear());
      setRMonth(next.getMonth());
      setOpen(true);
      return;
    }
    // Seed the pending selection from current value so the calendar
    // opens already showing the chosen range.
    setSelFrom(value.start);
    setSelTo(value.end);
    setSelPreset(value.preset);
    // Land the calendars on the months that contain the range.
    const startD = new Date(`${value.start}T00:00:00`);
    const endD = new Date(`${value.end}T00:00:00`);
    setLYear(startD.getFullYear());
    setLMonth(startD.getMonth());
    if (
      startD.getFullYear() === endD.getFullYear() &&
      startD.getMonth() === endD.getMonth()
    ) {
      // Same-month range: bump the right calendar one month so two
      // distinct months are always visible (spec §12 edge case 1).
      const next = new Date(endD.getFullYear(), endD.getMonth() + 1, 1);
      setRYear(next.getFullYear());
      setRMonth(next.getMonth());
    } else {
      setRYear(endD.getFullYear());
      setRMonth(endD.getMonth());
    }
    setOpen(true);
  }, [disabled, value]);

  const closePicker = useCallback(() => setOpen(false), []);

  // Position the desktop popover relative to the trigger. Right-align
  // when the popover would overflow the viewport (spec §5).
  useLayoutEffect(() => {
    if (!open || isMobile || !triggerRef.current) return;
    const update = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const APPROX_W = 700;
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
  }, [open, isMobile]);

  // ─── Calendar interactions ───────────────────────────────────────
  const handleDateClick = (dateIso: string) => {
    // A calendar click means the user is composing a custom range,
    // even if they got here via a preset; flip the pending preset so
    // the sidebar highlight follows.
    setSelPreset('custom');
    if (!selFrom || (selFrom && selTo)) {
      // Either nothing selected yet, or a complete range already exists.
      // Either way, start a fresh range on this click.
      setSelFrom(dateIso);
      setSelTo(null);
      return;
    }
    // selFrom is set, selTo is not. Decide whether the click is earlier,
    // later, or same-day, and place selTo accordingly. Auto-swap on
    // backwards selection (spec §5).
    if (dateIso === selFrom) {
      setSelTo(dateIso);
    } else if (dateIso < selFrom) {
      setSelTo(selFrom);
      setSelFrom(dateIso);
    } else {
      setSelTo(dateIso);
    }
  };

  const handlePresetClick = (id: DateRangePresetId) => {
    // Preset click only stages the pending selection — no commit, no
    // close. Apply is the single commit point. This avoids triggering
    // a parent refetch on every preset-shopping click and keeps the
    // popover steady so the user can compare presets visually before
    // committing.
    const next = resolvePreset(id);
    setSelPreset(id);
    setSelFrom(next.start);
    setSelTo(next.end);
    const startD = new Date(`${next.start}T00:00:00`);
    const endD = new Date(`${next.end}T00:00:00`);
    setLYear(startD.getFullYear());
    setLMonth(startD.getMonth());
    if (
      startD.getFullYear() === endD.getFullYear() &&
      startD.getMonth() === endD.getMonth()
    ) {
      const bumped = new Date(endD.getFullYear(), endD.getMonth() + 1, 1);
      setRYear(bumped.getFullYear());
      setRMonth(bumped.getMonth());
    } else {
      setRYear(endD.getFullYear());
      setRMonth(endD.getMonth());
    }
  };

  const canApply = !!selFrom && !!selTo;
  const handleApply = () => {
    if (!canApply || !selFrom || !selTo) return;
    try {
      // Preserve the pending preset id when the selection still matches
      // a preset (so the trigger label keeps reading "Last 30 days"
      // rather than "12 Apr to 11 May"). On any custom calendar click
      // selPreset was already flipped to 'custom' — see handleDateClick.
      const next: DateRange =
        selPreset === 'custom'
          ? makeCustomRange(selFrom, selTo)
          : { start: selFrom, end: selTo, preset: selPreset };
      onChange(next);
      closePicker();
    } catch {
      // Defensive — selFrom and selTo are constrained by the click logic
      // above so this branch shouldn't fire in practice.
    }
  };

  // ─── Trigger ─────────────────────────────────────────────────────
  const triggerLabel = value === null ? placeholder : dateRangeLabel(value);
  const showClear = onClear !== undefined && value !== null && !disabled;
  return (
    <>
      <span
        ref={triggerRef}
        style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}
      >
        <Button
          variant="tertiary"
          size={size}
          onClick={() => (open ? closePicker() : openPicker())}
          disabled={disabled}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <Calendar size={size === 'sm' ? 14 : 16} aria-hidden />
            {triggerLabel}
            <ChevronDown size={size === 'sm' ? 12 : 14} aria-hidden />
          </span>
        </Button>
        {showClear ? (
          <button
            type="button"
            aria-label="Clear date range"
            onClick={(e) => {
              e.stopPropagation();
              onClear?.();
            }}
            style={{
              appearance: 'none',
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.inkSubtle,
              cursor: 'pointer',
              padding: 0,
              width: size === 'sm' ? 26 : 30,
              height: size === 'sm' ? 26 : 30,
              borderRadius: theme.radius.pill,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'inherit',
            }}
          >
            <X size={size === 'sm' ? 12 : 14} aria-hidden />
          </button>
        ) : null}
      </span>

      {open && !isMobile ? (
        <DesktopPopover
          pos={popoverPos}
          activePreset={selPreset}
          selFrom={selFrom}
          selTo={selTo}
          today={today}
          lYear={lYear}
          lMonth={lMonth}
          rYear={rYear}
          rMonth={rMonth}
          onPrevLeft={() => stepMonth(setLYear, setLMonth, lYear, lMonth, -1)}
          onNextLeft={() => stepMonth(setLYear, setLMonth, lYear, lMonth, +1)}
          onPrevRight={() => stepMonth(setRYear, setRMonth, rYear, rMonth, -1)}
          onNextRight={() => stepMonth(setRYear, setRMonth, rYear, rMonth, +1)}
          onPresetClick={handlePresetClick}
          onDateClick={handleDateClick}
          canApply={canApply}
          onCancel={closePicker}
          onApply={handleApply}
        />
      ) : null}

      {open && isMobile ? (
        <MobileSheet
          activePreset={selPreset}
          selFrom={selFrom}
          selTo={selTo}
          today={today}
          year={lYear}
          month={lMonth}
          onPrev={() => stepMonth(setLYear, setLMonth, lYear, lMonth, -1)}
          onNext={() => stepMonth(setLYear, setLMonth, lYear, lMonth, +1)}
          onPresetClick={handlePresetClick}
          onDateClick={handleDateClick}
          canApply={canApply}
          onClose={closePicker}
          onApply={handleApply}
        />
      ) : null}
    </>
  );
}

// ─── Desktop popover ───────────────────────────────────────────────

function DesktopPopover({
  pos,
  activePreset,
  selFrom,
  selTo,
  today,
  lYear,
  lMonth,
  rYear,
  rMonth,
  onPrevLeft,
  onNextLeft,
  onPrevRight,
  onNextRight,
  onPresetClick,
  onDateClick,
  canApply,
  onCancel,
  onApply,
}: {
  pos: { top: number; left?: number; right?: number } | null;
  activePreset: DateRangePresetId;
  selFrom: string | null;
  selTo: string | null;
  today: string;
  lYear: number;
  lMonth: number;
  rYear: number;
  rMonth: number;
  onPrevLeft: () => void;
  onNextLeft: () => void;
  onPrevRight: () => void;
  onNextRight: () => void;
  onPresetClick: (id: DateRangePresetId) => void;
  onDateClick: (dateIso: string) => void;
  canApply: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  // Esc to close. Spec uses an invisible backdrop for outside-click
  // (sturdier than a document mousedown listener under re-renders).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (!pos) return null;

  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onCancel}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'transparent',
          zIndex: 8999,
        }}
      />
      <div
        role="dialog"
        aria-label="Pick a date range"
        style={{
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          right: pos.right,
          zIndex: 9000,
          display: 'flex',
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.card,
          boxShadow: theme.shadow.overlay,
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <PresetSidebar
          activePreset={activePreset}
          onPresetClick={onPresetClick}
          variant="desktop"
        />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: theme.space[6],
              padding: `${theme.space[4]}px ${theme.space[5]}px`,
            }}
          >
            <MonthGrid
              year={lYear}
              month={lMonth}
              selFrom={selFrom}
              selTo={selTo}
              today={today}
              onPrev={onPrevLeft}
              onNext={onNextLeft}
              onDateClick={onDateClick}
            />
            <MonthGrid
              year={rYear}
              month={rMonth}
              selFrom={selFrom}
              selTo={selTo}
              today={today}
              onPrev={onPrevRight}
              onNext={onNextRight}
              onDateClick={onDateClick}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[3],
              padding: `${theme.space[3]}px ${theme.space[5]}px`,
              borderTop: `1px solid ${theme.color.border}`,
              flexWrap: 'wrap',
            }}
          >
            <SelectionSummary selFrom={selFrom} selTo={selTo} />
            <div style={{ display: 'inline-flex', gap: theme.space[2] }}>
              <Button variant="tertiary" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canApply}
                onClick={onApply}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Mobile sheet ──────────────────────────────────────────────────

function MobileSheet({
  activePreset,
  selFrom,
  selTo,
  today,
  year,
  month,
  onPrev,
  onNext,
  onPresetClick,
  onDateClick,
  canApply,
  onClose,
  onApply,
}: {
  activePreset: DateRangePresetId;
  selFrom: string | null;
  selTo: string | null;
  today: string;
  year: number;
  month: number;
  onPrev: () => void;
  onNext: () => void;
  onPresetClick: (id: DateRangePresetId) => void;
  onDateClick: (dateIso: string) => void;
  canApply: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  // Body scroll lock while the sheet is open (spec §5).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        aria-label="Pick a date range"
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
        <div
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
            Date range
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              padding: theme.space[2],
              cursor: 'pointer',
              color: theme.color.inkMuted,
            }}
          >
            <X size={20} aria-hidden />
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: `${theme.space[4]}px ${theme.space[5]}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[5],
          }}
        >
          <PresetSidebar
            activePreset={activePreset}
            onPresetClick={onPresetClick}
            variant="mobile"
          />
          <div
            aria-hidden
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
              color: theme.color.inkMuted,
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.medium,
              letterSpacing: theme.type.tracking.wide,
              textTransform: 'uppercase',
            }}
          >
            <span style={{ flex: 1, height: 1, background: theme.color.border }} />
            <span>or pick custom</span>
            <span style={{ flex: 1, height: 1, background: theme.color.border }} />
          </div>
          <MonthGrid
            year={year}
            month={month}
            selFrom={selFrom}
            selTo={selTo}
            today={today}
            onPrev={onPrev}
            onNext={onNext}
            onDateClick={onDateClick}
            mobile
          />
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            padding: `${theme.space[3]}px ${theme.space[5]}px max(${theme.space[3]}px, env(safe-area-inset-bottom, ${theme.space[4]}px)) ${theme.space[5]}px`,
            borderTop: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <SelectionSummary selFrom={selFrom} selTo={selTo} />
          </div>
          <Button variant="primary" disabled={!canApply} onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Preset list ───────────────────────────────────────────────────

function PresetSidebar({
  activePreset,
  onPresetClick,
  variant,
}: {
  activePreset: DateRangePresetId;
  onPresetClick: (id: DateRangePresetId) => void;
  variant: 'desktop' | 'mobile';
}) {
  if (variant === 'mobile') {
    return (
      <div
        role="group"
        aria-label="Preset ranges"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: theme.space[2],
        }}
      >
        {DATE_RANGE_PRESETS.map((preset) => (
          <PresetButton
            key={preset.id}
            label={preset.label}
            active={preset.id === activePreset}
            onClick={() => onPresetClick(preset.id)}
            variant="mobile"
          />
        ))}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label="Preset ranges"
      style={{
        minWidth: SIDEBAR_MIN_WIDTH,
        background: theme.color.bg,
        borderRight: `1px solid ${theme.color.border}`,
        padding: `${theme.space[3]}px ${theme.space[2]}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {DATE_RANGE_PRESETS.map((preset) => (
        <PresetButton
          key={preset.id}
          label={preset.label}
          active={preset.id === activePreset}
          onClick={() => onPresetClick(preset.id)}
          variant="desktop"
        />
      ))}
    </div>
  );
}

function PresetButton({
  label,
  active,
  onClick,
  variant,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  variant: 'desktop' | 'mobile';
}) {
  if (variant === 'mobile') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        style={{
          appearance: 'none',
          padding: PILL_PADDING_MOBILE,
          borderRadius: theme.radius.input,
          border: `1.5px solid ${active ? theme.color.accent : theme.color.border}`,
          background: active ? theme.color.accentBg : theme.color.surface,
          color: active ? theme.color.accent : theme.color.ink,
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
          cursor: 'pointer',
          textAlign: 'center',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: 'none',
        padding: `${PILL_PADDING_DESKTOP}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        border: 'none',
        background: active ? theme.color.accentBg : 'transparent',
        color: active ? theme.color.accent : theme.color.inkMuted,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: active ? theme.type.weight.semibold : theme.type.weight.regular,
        cursor: 'pointer',
        textAlign: 'left',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {label}
    </button>
  );
}

// ─── Calendar grid ─────────────────────────────────────────────────

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

function MonthGrid({
  year,
  month,
  selFrom,
  selTo,
  today,
  onPrev,
  onNext,
  onDateClick,
  mobile = false,
}: {
  year: number;
  month: number;
  selFrom: string | null;
  selTo: string | null;
  today: string;
  onPrev: () => void;
  onNext: () => void;
  onDateClick: (dateIso: string) => void;
  mobile?: boolean;
}) {
  // Construct the 42-cell grid so the layout never jumps between
  // months. firstDow uses Monday=0 to match our Mon-first weekday
  // header. Outside-month cells render dimmed and are not clickable.
  const cells = useMemo(() => buildMonthCells(year, month), [year, month]);

  const cellSize = mobile ? 44 : 36;
  const discSize = mobile ? 38 : 32;
  const cellFont = mobile ? theme.type.size.sm : 13;

  return (
    <div style={{ minWidth: mobile ? 'auto' : 248 }}>
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
            selFrom={selFrom}
            selTo={selTo}
            today={today}
            cellSize={cellSize}
            discSize={discSize}
            cellFont={cellFont}
            onDateClick={onDateClick}
          />
        ))}
      </div>
    </div>
  );
}

interface DayCellModel {
  iso: string;
  day: number;
  outside: boolean;
}

function buildMonthCells(year: number, month: number): DayCellModel[] {
  // First-day-of-month weekday, Monday-anchored (Mon=0…Sun=6) to match
  // the Mon-first header. JS Date.getDay() returns 0=Sun, hence the
  // (+6)%7 shift.
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells: DayCellModel[] = [];
  for (let i = 0; i < firstDow; i++) {
    const day = daysInPrev - firstDow + 1 + i;
    const d = new Date(year, month - 1, day);
    cells.push({ iso: formatDateIso(d), day, outside: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ iso: formatDateIso(new Date(year, month, d)), day: d, outside: false });
  }
  while (cells.length < 42) {
    const d = cells.length - firstDow - daysInMonth + 1;
    const date = new Date(year, month + 1, d);
    cells.push({ iso: formatDateIso(date), day: d, outside: true });
  }
  return cells;
}

function DayCell({
  cell,
  selFrom,
  selTo,
  today,
  cellSize,
  discSize,
  cellFont,
  onDateClick,
}: {
  cell: DayCellModel;
  selFrom: string | null;
  selTo: string | null;
  today: string;
  cellSize: number;
  discSize: number;
  cellFont: number | string;
  onDateClick: (dateIso: string) => void;
}) {
  const isFrom = !cell.outside && cell.iso === selFrom;
  const isTo = !cell.outside && cell.iso === selTo;
  const isSelected = isFrom || isTo;
  const inRange =
    !cell.outside &&
    !!selFrom &&
    !!selTo &&
    selFrom !== selTo &&
    cell.iso > selFrom &&
    cell.iso < selTo;
  const isToday = !cell.outside && cell.iso === today;
  const sameDay = !!selFrom && selFrom === selTo;

  // Range-tint background on the cell wrapper (not the disc). The from
  // and to cells get half-tinted gradients so the in-range tint reads as
  // a continuous bar bounded by the solid discs.
  let bg: string = 'transparent';
  if (inRange) {
    bg = theme.color.accentBg;
  } else if (isFrom && selTo && !sameDay) {
    // From cell with a to selected: tint the right half so the in-range
    // bar appears to start from the solid disc.
    bg = `linear-gradient(to right, transparent 50%, ${theme.color.accentBg} 50%)`;
  } else if (isTo && selFrom && !sameDay) {
    bg = `linear-gradient(to left, transparent 50%, ${theme.color.accentBg} 50%)`;
  }

  // Disc colours
  const discBg = isSelected ? theme.color.accent : 'transparent';
  const discFg = isSelected
    ? theme.color.surface
    : cell.outside
    ? theme.color.inkSubtle
    : isToday
    ? theme.color.accent
    : theme.color.ink;
  const discWeight =
    isSelected || isToday ? theme.type.weight.semibold : theme.type.weight.regular;

  const wrapperStyle: CSSProperties = {
    height: cellSize,
    background: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: cell.outside ? 'none' : 'auto',
  };

  const discStyle: CSSProperties = {
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
    cursor: cell.outside ? 'default' : 'pointer',
    appearance: 'none',
    padding: 0,
    transition: `background 100ms ${theme.motion.easing.standard}, color 100ms ${theme.motion.easing.standard}`,
  };

  return (
    <div style={wrapperStyle}>
      <button
        type="button"
        disabled={cell.outside}
        aria-label={a11yDateLabel(cell.iso)}
        aria-pressed={isSelected}
        aria-current={isToday ? 'date' : undefined}
        onClick={() => onDateClick(cell.iso)}
        style={discStyle}
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
        cursor: 'pointer',
        color: theme.color.inkMuted,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.input,
      }}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </button>
  );
}

// ─── Footer summary ────────────────────────────────────────────────

function SelectionSummary({
  selFrom,
  selTo,
}: {
  selFrom: string | null;
  selTo: string | null;
}) {
  let text: string;
  if (selFrom && selTo) {
    text = selFrom === selTo
      ? formatDayLong(selFrom)
      : `${formatDayShort(selFrom)} to ${formatDayShort(selTo)}`;
  } else if (selFrom) {
    text = `${formatDayShort(selFrom)}, pick the end date`;
  } else {
    text = 'Pick a date range';
  }
  return (
    <span
      style={{
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {text}
    </span>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function stepMonth(
  setYear: (y: number) => void,
  setMonth: (m: number) => void,
  year: number,
  month: number,
  delta: number,
) {
  const next = new Date(year, month + delta, 1);
  setYear(next.getFullYear());
  setMonth(next.getMonth());
}

function formatDayShort(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function formatDayLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function a11yDateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// addDaysIso is imported because the DateRange resolver is shared with
// the rest of the app; re-export from here for any caller that wants
// to do its own date math after onChange fires.
export { addDaysIso };
