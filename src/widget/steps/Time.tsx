import { useEffect, useMemo, useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import type { BookingStateApi } from '../state.ts';
import {
  firstAvailable,
  isClosedDay,
  useWidgetAvailableSlots,
  type WidgetSlot,
} from '../data.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';

// Step 4 — Date and Time.
//
// Layout:
//
//   • A "first availability" banner up top so the patient can
//     one-tap to the soonest slot without poking around.
//   • A calendar grid: two months side-by-side on desktop,
//     a single month on mobile (the second month becomes a "Show
//     more dates" expansion). Past dates and Sundays are dimmed.
//   • A time list grouped morning / afternoon / evening, only
//     populated once a date is selected.
//
// Slot generation lives in data.ts (v1 stub). The widget code here
// just consumes WidgetSlot[].

const CALENDAR_BREAKPOINT = 720;

export function TimeStep({ api }: { api: BookingStateApi }) {
  const isMobile = useIsMobile(CALENDAR_BREAKPOINT);
  const service = api.state.service;

  // The selected date is local widget state — only the picked slot
  // promotes back to the booking state. That keeps date hopping
  // cheap and avoids accidentally clobbering an already-chosen slot
  // if the user wanders to another month.
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    if (api.state.slotIso) return startOfDay(new Date(api.state.slotIso));
    const next = firstAvailable(service?.durationMinutes ?? 30);
    return next?.date ?? startOfDay(new Date());
  });
  const [monthCursor, setMonthCursor] = useState<Date>(() => startOfMonth(selectedDate));

  // First-availability banner stays in sync with the chosen service.
  const earliest = useMemo(
    () => firstAvailable(service?.durationMinutes ?? 30),
    [service?.durationMinutes],
  );

  // Live availability for the selected date — driven by the RPC
  // lng_widget_available_slots, which generates the candidate grid
  // server-side and filters each candidate through the same conflict
  // check the staff app uses. Loading state surfaces in the slot
  // list (faded out while a fetch is in flight).
  const availability = useWidgetAvailableSlots({
    locationId: api.state.location?.id ?? null,
    serviceType: service?.serviceType ?? null,
    date: selectedDate,
    repairVariant: api.state.axes.repair_variant ?? null,
    productKey: api.state.axes.product_key ?? null,
    arch: api.state.axes.arch ?? null,
  });
  const slots = availability.data ?? [];

  // When the cursor moves to a month with no in-month selected day,
  // keep the calendar visually consistent — don't move the
  // selectedDate, the time grid will update once the patient taps a
  // new day.

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      {earliest ? (
        <button
          type="button"
          onClick={() => {
            setSelectedDate(earliest.date);
            setMonthCursor(startOfMonth(earliest.date));
            api.setState((prev) => ({ ...prev, slotIso: earliest.slot.iso }));
            api.goNext();
          }}
          style={{
            appearance: 'none',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.card,
            background: theme.color.accentBg,
            border: `1px solid ${theme.color.accent}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            color: theme.color.ink,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <CalendarRange size={16} aria-hidden style={{ color: theme.color.accent }} />
            <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
              Our first opening
            </span>
          </span>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.accent,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatLong(earliest.date)} · {earliest.slot.label}
          </span>
        </button>
      ) : null}

      <CalendarGrid
        monthCursor={monthCursor}
        selectedDate={selectedDate}
        onSelectDate={(d) => setSelectedDate(d)}
        onShiftMonth={(delta) => {
          const next = new Date(monthCursor);
          next.setMonth(next.getMonth() + delta);
          setMonthCursor(next);
        }}
        twoMonths={!isMobile}
      />

      <SlotList
        slots={slots}
        loading={availability.loading}
        error={availability.error}
        selectedIso={api.state.slotIso}
        onPick={(iso) => {
          api.setState((prev) => ({ ...prev, slotIso: iso }));
          api.goNext();
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar grid
// ─────────────────────────────────────────────────────────────────────────────

function CalendarGrid({
  monthCursor,
  selectedDate,
  onSelectDate,
  onShiftMonth,
  twoMonths,
}: {
  monthCursor: Date;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  onShiftMonth: (delta: -1 | 1) => void;
  twoMonths: boolean;
}) {
  const monthA = monthCursor;
  const monthB = useMemo(() => {
    const m = new Date(monthCursor);
    m.setMonth(m.getMonth() + 1);
    return m;
  }, [monthCursor]);

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        boxShadow: theme.shadow.card,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          marginBottom: theme.space[4],
        }}
      >
        <ArrowButton dir="prev" onClick={() => onShiftMonth(-1)} />
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.inkMuted,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
          }}
        >
          {monthName(monthA)}
          {twoMonths ? ` and ${monthName(monthB)}` : ''}
        </span>
        <ArrowButton dir="next" onClick={() => onShiftMonth(1)} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: twoMonths ? '1fr 1fr' : '1fr',
          gap: theme.space[5],
        }}
      >
        <Month monthDate={monthA} selectedDate={selectedDate} onSelectDate={onSelectDate} />
        {twoMonths ? (
          <Month monthDate={monthB} selectedDate={selectedDate} onSelectDate={onSelectDate} />
        ) : null}
      </div>
    </div>
  );
}

function Month({
  monthDate,
  selectedDate,
  onSelectDate,
}: {
  monthDate: Date;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
}) {
  const cells = useMemo(() => buildMonthCells(monthDate), [monthDate]);
  const today = startOfDay(new Date());

  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
          marginBottom: theme.space[3],
        }}
      >
        {monthName(monthDate)}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 2,
          marginBottom: theme.space[2],
        }}
      >
        {DOW_LABELS.map((d) => (
          <span
            key={d}
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textAlign: 'center',
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            {d}
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((c, i) => {
          const inMonth = c.date.getMonth() === monthDate.getMonth();
          const isPast = c.date < today;
          // Closed-day check is client-side (Sunday) so the calendar
          // grid doesn't fan out one availability RPC per cell. The
          // *empty-day* case (every slot booked) shows up when the
          // patient picks the date — the SlotList renders a "no
          // openings" empty state when the live data comes back blank.
          const closed = isClosedDay(c.date);
          const disabled = isPast || closed;
          const selected = sameDay(c.date, selectedDate);
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onSelectDate(c.date)}
              aria-pressed={selected}
              aria-label={c.date.toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
              style={{
                appearance: 'none',
                border: 'none',
                background: selected ? theme.color.accent : 'transparent',
                color: selected
                  ? theme.color.surface
                  : disabled || !inMonth
                    ? theme.color.inkSubtle
                    : theme.color.ink,
                aspectRatio: '1 / 1',
                width: '100%',
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
                fontVariantNumeric: 'tabular-nums',
                borderRadius: '50%',
                cursor: disabled ? 'default' : 'pointer',
                opacity: !inMonth || disabled ? 0.5 : 1,
                transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
              onMouseEnter={(e) => {
                if (selected || disabled) return;
                e.currentTarget.style.background = theme.color.bg;
              }}
              onMouseLeave={(e) => {
                if (selected || disabled) return;
                e.currentTarget.style.background = 'transparent';
              }}
            >
              {c.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ArrowButton({ dir, onClick }: { dir: 'prev' | 'next'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'prev' ? 'Previous month' : 'Next month'}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.bg,
        width: 32,
        height: 32,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: theme.color.ink,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
      }}
    >
      {dir === 'prev' ? '‹' : '›'}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot list — grouped morning / afternoon / evening
// ─────────────────────────────────────────────────────────────────────────────

function SlotList({
  slots,
  loading,
  error,
  selectedIso,
  onPick,
}: {
  slots: WidgetSlot[];
  loading: boolean;
  error: string | null;
  selectedIso: string | null;
  onPick: (iso: string) => void;
}) {
  // Reset row scroll when the day changes so we land on top of each
  // new bucket.
  const [, forceRerender] = useState(0);
  useEffect(() => {
    forceRerender((t) => t + 1);
  }, [slots.length]);

  if (error) {
    return (
      <div
        style={{
          background: theme.color.surface,
          border: `1px solid ${theme.color.alert}`,
          borderRadius: theme.radius.card,
          padding: theme.space[5],
          textAlign: 'center',
          color: theme.color.alert,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        Couldn't load availability. Try refreshing the page.
      </div>
    );
  }

  if (slots.length === 0) {
    return (
      <div
        style={{
          background: theme.color.surface,
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.card,
          padding: theme.space[5],
          textAlign: 'center',
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
        }}
      >
        {loading ? 'Checking availability…' : 'Nothing free on this day. Pick another date.'}
      </div>
    );
  }

  const buckets = {
    morning: slots.filter((s) => s.bucket === 'morning'),
    afternoon: slots.filter((s) => s.bucket === 'afternoon'),
    evening: slots.filter((s) => s.bucket === 'evening'),
  };

  return (
    <div
      style={{
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: theme.space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
        boxShadow: theme.shadow.card,
        opacity: loading ? 0.5 : 1,
        transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <Bucket label="Morning" slots={buckets.morning} selectedIso={selectedIso} onPick={onPick} />
      <Bucket label="Afternoon" slots={buckets.afternoon} selectedIso={selectedIso} onPick={onPick} />
      <Bucket label="Evening" slots={buckets.evening} selectedIso={selectedIso} onPick={onPick} />
    </div>
  );
}

function Bucket({
  label,
  slots,
  selectedIso,
  onPick,
}: {
  label: string;
  slots: WidgetSlot[];
  selectedIso: string | null;
  onPick: (iso: string) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <div>
      <p
        style={{
          margin: 0,
          marginBottom: theme.space[2],
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        {label}
      </p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: theme.space[2],
        }}
      >
        {slots.map((s) => {
          const selected = s.iso === selectedIso;
          return (
            <button
              key={s.iso}
              type="button"
              onClick={() => onPick(s.iso)}
              aria-pressed={selected}
              style={{
                appearance: 'none',
                fontFamily: 'inherit',
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                fontVariantNumeric: 'tabular-nums',
                padding: `${theme.space[2]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.pill,
                border: `1px solid ${selected ? theme.color.accent : theme.color.border}`,
                background: selected ? theme.color.accent : theme.color.surface,
                color: selected ? theme.color.surface : theme.color.ink,
                cursor: 'pointer',
                transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
              onMouseEnter={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = theme.color.ink;
              }}
              onMouseLeave={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = theme.color.border;
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────────────

const DOW_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function startOfMonth(d: Date): Date {
  const c = new Date(d);
  c.setDate(1);
  c.setHours(0, 0, 0, 0);
  return c;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function monthName(d: Date): string {
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function formatLong(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

interface MonthCell {
  date: Date;
}

/** Build a 6-row x 7-col grid of dates centred on the given month's
 *  first day (Monday-aligned). Days from the prev/next month fill
 *  the leading and trailing slots — the caller dims them. */
function buildMonthCells(monthDate: Date): MonthCell[] {
  const first = startOfMonth(monthDate);
  // ISO-style: Monday is day 0.
  const lead = (first.getDay() + 6) % 7;
  const cells: MonthCell[] = [];
  const start = new Date(first);
  start.setDate(start.getDate() - lead);
  for (let i = 0; i < 42; i++) {
    const c = new Date(start);
    c.setDate(start.getDate() + i);
    cells.push({ date: c });
  }
  return cells;
}
