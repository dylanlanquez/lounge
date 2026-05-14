import { useEffect, useMemo, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  firstAvailable,
  isClosedDay,
  useWidgetAvailableSlots,
  useWidgetFirstAvailable,
  type WidgetSlot,
} from './data.ts';

// Reusable date+time picker for the booking flow AND the
// patient-side reschedule flow on /widget/manage.
//
// Layout (post-2026-05-14 redesign):
//   • Optional "first availability" banner at the top (default on
//     for booking; the manage page can switch it off).
//   • Single-month calendar — the modal column is too narrow to
//     show two months without horizontal clipping, and the
//     "← / →" chevrons are right there for the patient who needs
//     next month.
//   • Time list grouped morning / afternoon / evening as pills.
//
// Visual tokens line up with the venneir.com retainer-cart quiz
// modal so the embed reads as continuous with the storefront the
// patient just came from: white surface, 2px transparent border
// going to navy on hover / select, 12px radius, cubic-bezier(0.4,0,
// 0.2,1) transitions, soft (0,0,0,0.08) shadow on lift.

// ─────────────────────────────────────────────────────────────────────────────
// Visual tokens
// ─────────────────────────────────────────────────────────────────────────────
//
// Hard-coded rather than threaded via brand props because both the
// venneir.com and (eventually) denture-services.co.uk pages use the
// same navy-on-white card system. If denture diverges visually,
// these become props on SlotPicker and the per-brand bundles pass
// their own values.

const ACCENT = '#083758';
const BORDER = '#e5e5e5';
const BORDER_STRONG = '#cfd4d8';
const INK = '#1F2937';
const MUTED = '#555';
const SUBTLE = '#9CA3AF';
const SURFACE = '#FFFFFF';
const BG_SUBTLE = '#F8F9FA';
const SHADOW_LIFT = '0 4px 12px rgba(0,0,0,0.08)';
const SHADOW_CARD = '0 1px 3px rgba(0,0,0,0.04)';
const EASE_CARD = 'cubic-bezier(0.4, 0, 0.2, 1)';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface SlotPickerProps {
  locationId: string | null;
  serviceType: string | null;
  durationMinutes: number;
  repairVariant?: string | null;
  productKey?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  selectedIso: string | null;
  onPick: (iso: string) => void;
  /** Show the "Our first opening" suggestion banner above the
   *  calendar. Default true. The manage / reschedule flow turns
   *  it off because the patient is moving an existing booking
   *  and probably doesn't want to be nudged at the soonest slot
   *  on the system. */
  showFirstAvailableBanner?: boolean;
  /** When set the availability lookup excludes this appointment
   *  from its conflict count. The reschedule flow passes the
   *  patient's current booking so the slot they're sitting on
   *  remains pickable (no self-conflict). */
  excludeAppointmentId?: string | null;
}

export function SlotPicker({
  locationId,
  serviceType,
  durationMinutes,
  repairVariant = null,
  productKey = null,
  arch = null,
  selectedIso,
  onPick,
  showFirstAvailableBanner = true,
  excludeAppointmentId = null,
}: SlotPickerProps) {
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    if (selectedIso) return startOfDay(new Date(selectedIso));
    const next = firstAvailable(durationMinutes);
    return next?.date ?? startOfDay(new Date());
  });
  const [monthCursor, setMonthCursor] = useState<Date>(() => startOfMonth(selectedDate));

  const stubEarliest = useMemo(() => firstAvailable(durationMinutes), [durationMinutes]);
  const liveFirstAvailable = useWidgetFirstAvailable({
    locationId,
    serviceType,
    repairVariant,
    productKey,
    arch,
  });
  const earliest = liveFirstAvailable.data ?? stubEarliest;

  const availability = useWidgetAvailableSlots({
    locationId,
    serviceType,
    date: selectedDate,
    repairVariant,
    productKey,
    arch,
    excludeAppointmentId,
  });
  const slots = availability.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showFirstAvailableBanner && earliest ? (
        <button
          type="button"
          onClick={() => {
            setSelectedDate(earliest.date);
            setMonthCursor(startOfMonth(earliest.date));
            onPick(earliest.slot.iso);
          }}
          style={{
            appearance: 'none',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: '14px 18px',
            borderRadius: 12,
            background: SURFACE,
            border: `2px solid ${ACCENT}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            color: INK,
            boxShadow: SHADOW_CARD,
            transition: `all 0.2s ${EASE_CARD}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = SHADOW_LIFT;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = SHADOW_CARD;
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <CalendarRange size={18} aria-hidden style={{ color: ACCENT }} />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Our first opening</span>
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: ACCENT,
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
      />

      <SlotList
        slots={slots}
        loading={availability.loading}
        error={availability.error}
        selectedIso={selectedIso}
        onPick={onPick}
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
}: {
  monthCursor: Date;
  selectedDate: Date;
  onSelectDate: (d: Date) => void;
  onShiftMonth: (delta: -1 | 1) => void;
}) {
  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: 16,
        boxShadow: SHADOW_CARD,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <ArrowButton dir="prev" onClick={() => onShiftMonth(-1)} />
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: INK,
            letterSpacing: '-0.01em',
          }}
        >
          {monthName(monthCursor)}
        </span>
        <ArrowButton dir="next" onClick={() => onShiftMonth(1)} />
      </div>
      <Month monthDate={monthCursor} selectedDate={selectedDate} onSelectDate={onSelectDate} />
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 2,
          marginBottom: 6,
        }}
      >
        {DOW_LABELS.map((d) => (
          <span
            key={d}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: SUBTLE,
              textAlign: 'center',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
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
          const closed = isClosedDay(c.date);
          const disabled = isPast || closed || !inMonth;
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
                border: `2px solid ${selected ? ACCENT : 'transparent'}`,
                background: selected ? ACCENT : 'transparent',
                color: selected
                  ? '#FFFFFF'
                  : disabled
                    ? SUBTLE
                    : INK,
                aspectRatio: '1 / 1',
                width: '100%',
                fontFamily: 'inherit',
                fontSize: 14,
                fontWeight: selected ? 600 : 500,
                fontVariantNumeric: 'tabular-nums',
                borderRadius: 12,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                transition: `all 0.18s ${EASE_CARD}`,
              }}
              onMouseEnter={(e) => {
                if (selected || disabled) return;
                e.currentTarget.style.borderColor = ACCENT;
                e.currentTarget.style.background = SURFACE;
                e.currentTarget.style.boxShadow = SHADOW_LIFT;
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                if (selected || disabled) return;
                e.currentTarget.style.borderColor = 'transparent';
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'none';
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
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        width: 36,
        height: 36,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: INK,
        fontFamily: 'inherit',
        transition: `all 0.15s ${EASE_CARD}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = ACCENT;
        e.currentTarget.style.color = ACCENT;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = BORDER;
        e.currentTarget.style.color = INK;
      }}
    >
      {dir === 'prev' ? <ChevronLeft size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}
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
  const [, forceRerender] = useState(0);
  useEffect(() => {
    forceRerender((t) => t + 1);
  }, [slots.length]);

  if (error) {
    return (
      <div
        role="alert"
        style={{
          background: SURFACE,
          border: `1px solid ${theme.color.alert}`,
          borderRadius: 12,
          padding: 18,
          textAlign: 'center',
          color: theme.color.alert,
          fontSize: 14,
          fontWeight: 600,
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
          background: BG_SUBTLE,
          border: `1px dashed ${BORDER_STRONG}`,
          borderRadius: 12,
          padding: 24,
          textAlign: 'center',
          color: MUTED,
          fontSize: 14,
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
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxShadow: SHADOW_CARD,
        opacity: loading ? 0.5 : 1,
        transition: `opacity 0.15s ${EASE_CARD}`,
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
          marginBottom: 8,
          fontSize: 12,
          fontWeight: 600,
          color: SUBTLE,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
          gap: 8,
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
                fontSize: 14,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                padding: '10px 12px',
                borderRadius: 10,
                border: `2px solid ${selected ? ACCENT : BORDER}`,
                background: selected ? ACCENT : SURFACE,
                color: selected ? '#FFFFFF' : INK,
                cursor: 'pointer',
                textAlign: 'center',
                transition: `all 0.18s ${EASE_CARD}`,
              }}
              onMouseEnter={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = ACCENT;
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = SHADOW_LIFT;
              }}
              onMouseLeave={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = BORDER;
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.boxShadow = 'none';
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

function buildMonthCells(monthDate: Date): MonthCell[] {
  const first = startOfMonth(monthDate);
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
