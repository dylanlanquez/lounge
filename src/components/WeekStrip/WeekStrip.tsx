import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { theme } from '../../theme/index.ts';
import { addDaysIso } from '../../lib/calendarMonth.ts';

export interface WeekStripProps {
  // The selected day. Drives both the highlighted pill and the
  // strip's scroll position. The strip will smooth-scroll the
  // matching day to centre whenever this prop changes externally
  // (arrow nav, "Today" button, etc.).
  selectedIso: string;
  todayIso: string;
  counts: Map<string, number>;
  onSelect: (dateIso: string) => void;
  loading?: boolean;
}

// How many days each side of today the strip materialises in the
// DOM. ~60 each side covers normal clinic planning horizons; the
// chevron buttons in the parent still let staff jump by full
// weeks beyond that.
const WINDOW_RADIUS_DAYS = 60;

// Each pill is a fixed-width flex item. 88 is large enough for the
// number + weekday + dot to read on a kiosk and small enough that
// 7-9 days are visible at once on the typical 720-1024px schedule
// width.
const PILL_WIDTH = 88;

// Debounce window for the scroll-end → onSelect hand-off. Long
// enough to ride out a single rubber-band frame, short enough that
// a quick swipe reads as snappy. Native `scrollend` would be the
// preferred signal but Safari's support lags, so we settle the
// last `scroll` event manually.
const SCROLL_SETTLE_MS = 140;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function WeekStrip({
  selectedIso,
  todayIso,
  counts,
  onSelect,
  loading = false,
}: WeekStripProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track whether we've done the initial scroll-into-view yet, so
  // the very first paint lands without animation but every
  // subsequent prop change scrolls smoothly.
  const initialisedRef = useRef(false);
  // Holds the date we most recently emitted via onSelect from a
  // scroll settle, so we don't feed back into our own selectedIso
  // effect and trigger a redundant scroll-to-self.
  const lastEmittedRef = useRef<string | null>(null);

  // Fixed window anchored at today. Re-rendering this every time
  // selectedIso moves would shift the pills under the user's
  // scroll position; instead the window stays put and the user
  // scrolls inside it. todayIso ticks at midnight (parent) so the
  // window walks forward with the date naturally.
  const days = useMemo(() => {
    const out: string[] = [];
    for (let delta = -WINDOW_RADIUS_DAYS; delta <= WINDOW_RADIUS_DAYS; delta++) {
      out.push(addDaysIso(todayIso, delta));
    }
    return out;
  }, [todayIso]);

  // Centre the selected day in the viewport whenever the prop
  // changes externally. The < 4px guard avoids a no-op smooth
  // scroll right after a user-driven scroll already left us at
  // the right position — that tiny jitter would re-trigger our
  // own scroll-end handler in a loop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (lastEmittedRef.current === selectedIso) {
      // We just emitted this; the user already scrolled to it.
      // Don't overwrite their scroll position.
      lastEmittedRef.current = null;
      return;
    }
    const pill = container.querySelector<HTMLElement>(
      `[data-date="${selectedIso}"]`
    );
    if (!pill) return;
    const target = pill.offsetLeft + pill.clientWidth / 2 - container.clientWidth / 2;
    if (Math.abs(container.scrollLeft - target) < 4) return;
    container.scrollTo({
      left: target,
      behavior: initialisedRef.current ? 'smooth' : 'auto',
    });
    initialisedRef.current = true;
  }, [selectedIso]);

  // Detect the centred pill after the user stops scrolling and
  // promote it to selectedIso. Listening to plain `scroll` and
  // resetting a debounce gives parity with browsers that don't yet
  // ship the `scrollend` event.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      const center = container.scrollLeft + container.clientWidth / 2;
      let bestDate: string | null = null;
      let bestDelta = Infinity;
      const pills = container.querySelectorAll<HTMLElement>('[data-date]');
      pills.forEach((el) => {
        const pillCenter = el.offsetLeft + el.clientWidth / 2;
        const delta = Math.abs(pillCenter - center);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestDate = el.dataset['date'] ?? null;
        }
      });
      if (bestDate && bestDate !== selectedIso) {
        lastEmittedRef.current = bestDate;
        onSelect(bestDate);
      }
    };
    const onScroll = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(settle, SCROLL_SETTLE_MS);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timeout) clearTimeout(timeout);
    };
  }, [onSelect, selectedIso]);

  return (
    <>
      <div
        ref={containerRef}
        role="radiogroup"
        aria-label="Pick a day"
        aria-busy={loading || undefined}
        className="lng-week-strip"
        style={{
          display: 'flex',
          gap: theme.space[2],
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollSnapType: 'x mandatory',
          // -webkit-overflow-scrolling: touch keeps inertial
          // scrolling enabled on iOS Safari (still respected on
          // older versions). Modern engines ignore it harmlessly.
          WebkitOverflowScrolling: 'touch',
          // Hide the native scrollbar without disabling scroll. The
          // -webkit selector lives in the <style> below; these
          // values handle Firefox + legacy Edge.
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          opacity: loading ? 0.6 : 1,
          transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          // Pad the ends so the very first / very last pill can
          // still snap to centre — without padding, the scroll
          // container can't move them past its own edge.
          paddingLeft: `calc(50% - ${PILL_WIDTH / 2}px)`,
          paddingRight: `calc(50% - ${PILL_WIDTH / 2}px)`,
        }}
      >
        {days.map((dateIso) => {
          const dow = new Date(`${dateIso}T00:00:00`).getDay();
          return (
            <DayPill
              key={dateIso}
              dateIso={dateIso}
              weekdayShort={WEEKDAY_SHORT[dow] ?? ''}
              weekdayLong={WEEKDAY_LONG[dow] ?? ''}
              isSelected={dateIso === selectedIso}
              isToday={dateIso === todayIso}
              isPast={dateIso < todayIso}
              count={counts.get(dateIso) ?? 0}
              onSelect={onSelect}
            />
          );
        })}
      </div>
      {/* Hide the WebKit scrollbar without breaking the underlying
          scroll. Firefox / Edge use the inline scrollbarWidth
          property above. */}
      <style>{`.lng-week-strip::-webkit-scrollbar { display: none; }`}</style>
    </>
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
}: DayPillProps) {
  // iOS-style strip: bare numerals on the page background, with a
  // hairline-ring around the selected day and an accent-coloured
  // weekday label. No card, no shadow, no black fill — the strip is
  // navigation, not the focal point. Past days dim slightly. Today
  // not-selected gets an accent weekday too so "now" is still
  // legible at a glance.
  const dayOfMonth = Number(dateIso.split('-')[2]);
  const dimmed = isPast && !isSelected;

  const numberColor = dimmed ? theme.color.inkSubtle : theme.color.ink;
  const weekdayColor = isSelected || isToday ? theme.color.accent : theme.color.inkMuted;

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
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
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={a11yLabel(dateIso, weekdayLong, count, isToday)}
      tabIndex={isSelected ? 0 : -1}
      data-date={dateIso}
      onClick={() => onSelect(dateIso)}
      onKeyDown={handleKeyDown}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: theme.color.ink,
        fontFamily: 'inherit',
        padding: `${theme.space[2]}px ${theme.space[1]}px`,
        width: PILL_WIDTH,
        flexShrink: 0,
        scrollSnapAlign: 'center',
        // Default scrollSnapStop ('normal') is exactly the desired
        // feel — gentle scrolls land on the next pill, hard flicks
        // coast past several before settling. We deliberately do
        // not set 'always' here.
        minHeight: 64,
        borderRadius: 14,
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
