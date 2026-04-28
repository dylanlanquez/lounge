import { type CSSProperties, type KeyboardEvent } from 'react';
import { theme } from '../../theme/index.ts';
import { addDaysIso, getWeekDays } from '../../lib/calendarMonth.ts';

export interface WeekStripProps {
  // Any date in the week to render. The strip resolves to the Monday-Sunday
  // week containing this date.
  anchorIso: string;
  selectedIso: string;
  todayIso: string;
  counts: Map<string, number>;
  onSelect: (dateIso: string) => void;
  loading?: boolean;
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export function WeekStrip({
  anchorIso,
  selectedIso,
  todayIso,
  counts,
  onSelect,
  loading = false,
}: WeekStripProps) {
  const days = getWeekDays(anchorIso);

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, dateIso: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(dateIso);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSelect(addDaysIso(dateIso, -1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSelect(addDaysIso(dateIso, 1));
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Pick a day"
      aria-busy={loading || undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: theme.space[2],
        opacity: loading ? 0.6 : 1,
        transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {days.map((dateIso, i) => (
        <DayPill
          key={dateIso}
          dateIso={dateIso}
          weekdayShort={WEEKDAY_SHORT[i] ?? ''}
          weekdayLong={WEEKDAY_LONG[i] ?? ''}
          isSelected={dateIso === selectedIso}
          isToday={dateIso === todayIso}
          isPast={dateIso < todayIso}
          count={counts.get(dateIso) ?? 0}
          onSelect={onSelect}
          onKeyDown={(e) => handleKeyDown(e, dateIso)}
        />
      ))}
    </div>
  );
}

interface DayPillProps {
  dateIso: string;
  weekdayShort: string;
  weekdayLong: string;
  isSelected: boolean;
  isToday: boolean;
  isPast: boolean;
  count: number;
  onSelect: (dateIso: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

function DayPill({
  dateIso,
  weekdayShort,
  weekdayLong,
  isSelected,
  isToday,
  isPast,
  count,
  onSelect,
  onKeyDown,
}: DayPillProps) {
  const dayOfMonth = Number(dateIso.split('-')[2]);
  // Past day pills (when not selected) dim to match the faded treatment on
  // past appointment rows. Selected stays full-strength even when past so
  // the receptionist's focused day is unambiguous.
  const dimmed = isPast && !isSelected;
  const styles: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: isSelected ? theme.color.ink : theme.color.surface,
    color: isSelected ? theme.color.surface : theme.color.ink,
    fontFamily: 'inherit',
    paddingTop: theme.space[2],
    paddingBottom: theme.space[2],
    minHeight: 76,
    borderRadius: 16,
    boxShadow: isSelected
      ? theme.shadow.card
      : `inset 0 0 0 1px ${theme.color.border}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: 'pointer',
    position: 'relative',
    outline: 'none',
    opacity: dimmed ? 0.55 : 1,
    WebkitTapHighlightColor: 'transparent',
    transition: `background ${theme.motion.duration.base}ms ${theme.motion.easing.spring}, color ${theme.motion.duration.base}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.base}ms ${theme.motion.easing.standard}, opacity ${theme.motion.duration.base}ms ${theme.motion.easing.standard}`,
  };

  const dayNameColor = isSelected
    ? 'rgba(255, 255, 255, 0.7)'
    : theme.color.inkSubtle;
  const dotColor = isSelected
    ? theme.color.surface
    : isPast
      ? theme.color.inkSubtle
      : theme.color.accent;
  const todayMark = isToday && !isSelected;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={a11yLabel(dateIso, weekdayLong, count, isToday)}
      tabIndex={isSelected ? 0 : -1}
      onClick={() => onSelect(dateIso)}
      onKeyDown={onKeyDown}
      onMouseEnter={(e) => {
        if (isSelected) return;
        (e.currentTarget as HTMLElement).style.boxShadow = `inset 0 0 0 1px ${theme.color.ink}`;
      }}
      onMouseLeave={(e) => {
        if (isSelected) return;
        (e.currentTarget as HTMLElement).style.boxShadow = `inset 0 0 0 1px ${theme.color.border}`;
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = isSelected
          ? theme.shadow.card
          : `inset 0 0 0 1px ${theme.color.ink}`;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = isSelected
          ? theme.shadow.card
          : `inset 0 0 0 1px ${theme.color.border}`;
      }}
      style={styles}
    >
      <span
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: dayNameColor,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {weekdayShort}
      </span>
      <span
        style={{
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {dayOfMonth}
      </span>
      <span
        aria-hidden
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: count > 0 ? dotColor : 'transparent',
          marginTop: 2,
        }}
      />
      {todayMark ? (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            bottom: 6,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 16,
            height: 2,
            borderRadius: 2,
            background: theme.color.accent,
          }}
        />
      ) : null}
    </button>
  );
}

function a11yLabel(
  dateIso: string,
  weekdayLong: string,
  count: number,
  isToday: boolean
): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const formatted = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const todayPart = isToday ? ', today' : '';
  const countPart =
    count === 0 ? ', no appointments' : `, ${count} appointment${count === 1 ? '' : 's'}`;
  return `${weekdayLong} ${formatted}${todayPart}${countPart}`;
}
