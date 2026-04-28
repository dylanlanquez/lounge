import { type KeyboardEvent } from 'react';
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
  // iOS-style strip: bare numerals on the page background, with a
  // hairline-ring around the selected day and an accent-coloured
  // weekday label. No card, no shadow, no black fill — the strip is
  // navigation, not the focal point. Numbers stay ink-bold, weekdays
  // small-caps muted, except the selected one where the weekday
  // takes the brand accent so the eye lands without weight or
  // saturation. Past days dim slightly. Today not-selected gets an
  // accent weekday too so "now" is still legible at a glance.
  const dayOfMonth = Number(dateIso.split('-')[2]);
  const dimmed = isPast && !isSelected;

  const numberColor = dimmed ? theme.color.inkSubtle : theme.color.ink;
  const weekdayColor = isSelected || isToday ? theme.color.accent : theme.color.inkMuted;

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
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: theme.color.ink,
        fontFamily: 'inherit',
        padding: `${theme.space[2]}px ${theme.space[1]}px`,
        minHeight: 64,
        borderRadius: 14,
        // Hairline ring on the selected day. ink at 28% reads as a
        // confident outline against the cream bg without competing
        // with the appointment rows below for attention.
        boxShadow: isSelected
          ? `inset 0 0 0 1.5px rgba(14, 20, 20, 0.28)`
          : 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[1],
        cursor: 'pointer',
        position: 'relative',
        WebkitTapHighlightColor: 'transparent',
        transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          color: numberColor,
        }}
      >
        {dayOfMonth}
      </span>
      <span
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: weekdayColor,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {weekdayShort}
      </span>
      {/* Tiny dot under the weekday when the day has bookings. Quiet
          enough to read as metadata, not a badge. Hidden when there
          are none so empty days disappear visually. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          bottom: 4,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 4,
          height: 4,
          borderRadius: 999,
          background:
            count > 0
              ? dimmed
                ? theme.color.inkSubtle
                : theme.color.accent
              : 'transparent',
        }}
      />
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
