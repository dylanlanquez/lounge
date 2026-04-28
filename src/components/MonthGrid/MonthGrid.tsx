import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { theme } from '../../theme/index.ts';
import { getMonthGridDays, nextGridIndex } from '../../lib/calendarMonth.ts';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const WEEKDAYS_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export interface MonthGridProps {
  year: number;
  month: number; // 0-11
  selectedIso: string; // YYYY-MM-DD
  todayIso: string; // YYYY-MM-DD
  counts: Map<string, number>; // dateIso → appointment count (post-cancellation filter)
  onSelect: (dateIso: string) => void;
  loading?: boolean;
}

export function MonthGrid({
  year,
  month,
  selectedIso,
  todayIso,
  counts,
  onSelect,
  loading = false,
}: MonthGridProps) {
  const days = getMonthGridDays(year, month);
  const gridRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    index: number,
    dateIso: string
  ) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(dateIso);
      return;
    }
    const next = nextGridIndex(index, e.key, days.length);
    if (next === null) return;
    e.preventDefault();
    const nextCell = days[next];
    if (!nextCell) return;
    onSelect(nextCell.dateIso);
    // Focus the newly-selected cell after the parent re-renders.
    requestAnimationFrame(() => {
      const cells = gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-grid-cell]');
      cells?.[next]?.focus();
    });
  };

  return (
    <div
      role="grid"
      aria-label="Month calendar"
      aria-busy={loading || undefined}
      style={{ width: '100%' }}
    >
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 6,
          paddingBottom: theme.space[2],
        }}
      >
        {WEEKDAYS.map((d, i) => (
          <div
            key={i}
            role="columnheader"
            aria-label={WEEKDAYS_LONG[i]}
            style={{
              textAlign: 'center',
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkSubtle,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            {d}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        role="rowgroup"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 6,
          opacity: loading ? 0.6 : 1,
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        {days.map((cell, i) => {
          const isSelected = cell.dateIso === selectedIso;
          const isToday = cell.dateIso === todayIso;
          const isPast = cell.dateIso < todayIso;
          const count = counts.get(cell.dateIso) ?? 0;
          return (
            <DayCell
              key={cell.dateIso + '-' + i}
              dateIso={cell.dateIso}
              dayOfMonth={cell.dayOfMonth}
              isCurrentMonth={cell.isCurrentMonth}
              isSelected={isSelected}
              isToday={isToday}
              isPast={isPast}
              count={count}
              onSelect={onSelect}
              onKeyDown={(e) => handleKeyDown(e, i, cell.dateIso)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface DayCellProps {
  dateIso: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
  isPast: boolean;
  count: number;
  onSelect: (dateIso: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

function DayCell({
  dateIso,
  dayOfMonth,
  isCurrentMonth,
  isSelected,
  isToday,
  isPast,
  count,
  onSelect,
  onKeyDown,
}: DayCellProps) {
  const styles: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: isSelected ? theme.color.ink : 'transparent',
    color: isSelected
      ? theme.color.surface
      : isCurrentMonth
        ? theme.color.ink
        : theme.color.inkSubtle,
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: isToday || isSelected ? theme.type.weight.semibold : theme.type.weight.medium,
    fontVariantNumeric: 'tabular-nums',
    minHeight: 44,
    aspectRatio: '1 / 1',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    cursor: 'pointer',
    position: 'relative',
    boxShadow: isToday && !isSelected ? `inset 0 0 0 1.5px ${theme.color.ink}` : 'none',
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
  };
  const dotColor = isSelected
    ? theme.color.surface
    : isPast
      ? theme.color.inkSubtle
      : theme.color.accent;
  return (
    <button
      type="button"
      role="gridcell"
      data-grid-cell
      tabIndex={isSelected ? 0 : -1}
      aria-selected={isSelected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={a11yLabel(dateIso, count)}
      onClick={() => onSelect(dateIso)}
      onKeyDown={onKeyDown}
      onMouseEnter={(e) => {
        if (isSelected) return;
        (e.currentTarget as HTMLElement).style.background = 'rgba(14, 20, 20, 0.04)';
      }}
      onMouseLeave={(e) => {
        if (isSelected) return;
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = isSelected
          ? `0 0 0 3px ${theme.color.focus}`
          : isToday
            ? `inset 0 0 0 1.5px ${theme.color.ink}, 0 0 0 3px ${theme.color.focus}`
            : `0 0 0 3px ${theme.color.focus}`;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow =
          isToday && !isSelected ? `inset 0 0 0 1.5px ${theme.color.ink}` : 'none';
      }}
      style={styles}
    >
      <span>{dayOfMonth}</span>
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: count > 0 && isCurrentMonth ? dotColor : 'transparent',
        }}
      />
    </button>
  );
}

function a11yLabel(dateIso: string, count: number): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const formatted = d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  if (count === 0) return `${formatted}, no appointments`;
  return `${formatted}, ${count} appointment${count === 1 ? '' : 's'}`;
}
