import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  firstAvailable,
  generateSlots,
  toIsoDate,
  useWidgetAvailableDates,
  useWidgetAvailableSlots,
  useWidgetFirstAvailable,
  type WidgetSlot,
} from './data.ts';
import {
  useClinicSettings,
  type OpeningHoursWeek,
} from '../../lib/queries/clinicSettings.ts';

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
// Visual tokens — pulled from quizTokens so the calendar reads as
// part of the same retainer-cart-style chrome as the rest of the
// modal.
// ─────────────────────────────────────────────────────────────────────────────

import { QUIZ } from './quizTokens.ts';
const ACCENT = QUIZ.ACCENT;
const BORDER = QUIZ.BORDER;
const BORDER_STRONG = QUIZ.SUBTLE_2;
const INK = QUIZ.INK;
const MUTED = QUIZ.MUTED;
const SUBTLE = QUIZ.SUBTLE;
const SURFACE = QUIZ.SURFACE;
const BG_SUBTLE = QUIZ.SOFT_BG;
const SHADOW_LIFT = QUIZ.SHADOW_LIFT;
const SHADOW_CARD = QUIZ.SHADOW_SOFT;
const EASE_CARD = QUIZ.EASE_CARD;

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
  onPick: (iso: string | null) => void;
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
  // selectedDate is nullable on purpose. Earlier revisions seeded it
  // synchronously from a stub generator and then "auto-jumped" to
  // the live first-available date once the RPC resolved — the
  // patient saw the dot leap from today to tomorrow (and sometimes
  // back, when intermediate state updates interleaved). The picker
  // now refuses to commit to a starting date until the server has
  // told us where the first real opening is; while waiting, the
  // body renders a single calm loading card with no calendar dot
  // to bounce around. One paint, one final position.
  const [selectedDate, setSelectedDate] = useState<Date | null>(() => {
    if (selectedIso) return startOfDay(new Date(selectedIso));
    return null;
  });
  const [monthCursor, setMonthCursor] = useState<Date>(() => {
    if (selectedIso) return startOfMonth(new Date(selectedIso));
    return startOfMonth(new Date());
  });
  // Once the patient manually picks a date (calendar cell click or
  // "Our first opening" banner tap) their choice is authoritative
  // even if the live first-available query later resolves to a
  // different day. The init-pin effect below checks this ref.
  const userPickedRef = useRef(false);

  // Clinic opening hours from lng_settings — single source of truth
  // for which days of the week are closed. The calendar reads this
  // to dim + disable closed days (Saturdays, Sundays, whatever the
  // admin has configured) without needing one availability RPC per
  // cell. Live conflict-driven dimming still happens via the slot
  // list once a date is picked.
  const clinic = useClinicSettings();
  const openingHours = clinic.data.openingHours;

  const stubEarliest = useMemo(() => firstAvailable(durationMinutes), [durationMinutes]);
  const liveFirstAvailable = useWidgetFirstAvailable({
    locationId,
    serviceType,
    repairVariant,
    productKey,
    arch,
  });
  const earliest = liveFirstAvailable.data ?? stubEarliest;

  // Per-day availability window for the visible 42-cell grid.
  // Calls lng_widget_available_dates which loops the slot scanner
  // server-side and returns the subset of dates in [from, to] that
  // have at least one bookable slot. The calendar uses this to
  // disable cells whose date has no slots, so the patient can't tap
  // a day and then see the "Nothing free on this day" empty state.
  const visibleWindow = useMemo(() => {
    const first = startOfMonth(monthCursor);
    const lead = (first.getDay() + 6) % 7;
    const fromDate = new Date(first);
    fromDate.setDate(first.getDate() - lead);
    fromDate.setHours(0, 0, 0, 0);
    const toDate = new Date(fromDate);
    toDate.setDate(fromDate.getDate() + 41);
    toDate.setHours(0, 0, 0, 0);
    return { fromDate, toDate };
  }, [monthCursor]);
  const availableDates = useWidgetAvailableDates({
    locationId,
    serviceType,
    repairVariant,
    productKey,
    arch,
    fromDate: visibleWindow.fromDate,
    toDate: visibleWindow.toDate,
  });

  // Init-pin: the FIRST time the live first-available RPC settles,
  // commit selectedDate. Only runs while selectedDate is still null
  // (unset) and the patient hasn't picked — both conditions prevent
  // a second jump.
  //
  // Source-of-truth priority:
  //
  //   1. Live RPC, IF its returned slot iso is genuinely in the
  //      future. As of 20260514000011_lng_widget_slots_past_filter
  //      the underlying `lng_widget_available_slots` function skips
  //      past-time candidates server-side, so `lng_widget_first_
  //      available` naturally returns the next genuinely-bookable
  //      day. This is the hot path.
  //
  //   2. Stub firstAvailable() — past-filtered + opening-hours-
  //      aware. Belt-and-suspenders fallback when the live RPC
  //      returns null (e.g. a service has no availability in the
  //      next 60 days) or somehow surfaces a past slot.
  //
  //   3. Today, as a last resort if both above failed.
  useEffect(() => {
    if (userPickedRef.current) return;
    if (selectedDate !== null) return;
    if (liveFirstAvailable.loading) return;
    const nowMs = Date.now();
    const live = liveFirstAvailable.data;
    const liveDate =
      live && new Date(live.slot.iso).getTime() > nowMs ? live.date : null;
    const targetDate =
      liveDate ?? stubEarliest?.date ?? startOfDay(new Date());
    setSelectedDate(startOfDay(targetDate));
    setMonthCursor(startOfMonth(targetDate));
  }, [
    liveFirstAvailable.loading,
    liveFirstAvailable.data,
    selectedDate,
    stubEarliest,
  ]);

  const availability = useWidgetAvailableSlots({
    locationId,
    serviceType,
    date: selectedDate,
    repairVariant,
    productKey,
    arch,
    excludeAppointmentId,
  });
  // Past-time filter — when the selected day is today, the server's
  // candidate grid contains every opening from clinic-open to
  // clinic-close. Anything already in the past has to be hidden so
  // a 4pm patient can't tap an 11am pill. Comparing on a fresh
  // `Date.now()` per render is enough; we don't need to tick every
  // second (the patient either clicks within a minute or two, or
  // the server's past-slot guard rejects on submit). When ALL of
  // today's openings have passed, the slot list collapses to an
  // empty state with a more specific copy line.
  const filteredAvailability = useMemo(() => {
    const raw = availability.data ?? [];
    const nowMs = Date.now();
    const filtered = raw.filter((s) => new Date(s.iso).getTime() > nowMs);
    return {
      slots: filtered,
      allTodaysSlotsPassed: raw.length > 0 && filtered.length === 0,
    };
  }, [availability.data]);
  const slots = filteredAvailability.slots;
  const allTodaysSlotsPassed = filteredAvailability.allTodaysSlotsPassed;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 560,
        margin: '0 auto',
        width: '100%',
        // No extra marginTop — StepTitle's own bottom margin
        // (STEP_TITLE_BOTTOM_SPACE) provides the gap. Previous
        // marginTop:32 was doubling that gap and pushing the time
        // slots below the fold on phones.
        marginTop: 0,
      }}
    >
      {showFirstAvailableBanner && earliest ? (
        <button
          type="button"
          onClick={() => {
            userPickedRef.current = true;
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

      {selectedDate ? (
        <>
          <CalendarGrid
            monthCursor={monthCursor}
            selectedDate={selectedDate}
            openingHours={openingHours}
            durationMinutes={durationMinutes}
            availableDates={availableDates.dates}
            availableDatesLoading={availableDates.loading}
            onSelectDate={(d) => {
              userPickedRef.current = true;
              setSelectedDate(d);
              // If the patient had already locked in a time on a
              // different day, clear it so they're forced to pick
              // one on the new day. Without this, state.slotIso
              // silently stays on the previous date's slot and
              // Continue advances with a stale ISO that doesn't
              // match the calendar choice on screen. (No-op when
              // there's no selection, or when they re-tap the same
              // day.)
              if (selectedIso && !sameDay(new Date(selectedIso), d)) {
                onPick(null);
              }
            }}
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
            allTodaysSlotsPassed={allTodaysSlotsPassed}
          />
        </>
      ) : (
        // Loading state — shown until liveFirstAvailable resolves
        // and the init-pin effect commits selectedDate. By gating
        // the calendar entirely here we guarantee the first paint
        // with a date selected IS the correct one; the dot never
        // shifts on screen because there was no dot to shift from.
        <SlotPickerLoading />
      )}
    </div>
  );
}

function SlotPickerLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: 32,
        textAlign: 'center',
        color: MUTED,
        fontSize: 14,
        boxShadow: SHADOW_CARD,
        // Minimum height so the layout doesn't pop when the real
        // calendar lands — the Time step's footer position should
        // not shift between the loading state and the loaded one.
        minHeight: 320,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      Finding our next opening…
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar grid
// ─────────────────────────────────────────────────────────────────────────────

function CalendarGrid({
  monthCursor,
  selectedDate,
  openingHours,
  durationMinutes,
  availableDates,
  availableDatesLoading,
  onSelectDate,
  onShiftMonth,
}: {
  monthCursor: Date;
  selectedDate: Date;
  openingHours: OpeningHoursWeek;
  durationMinutes: number;
  /** Server-resolved set of YYYY-MM-DD strings that have at least
   *  one bookable slot. Cells whose date isn't in the set get the
   *  disabled treatment. While loading the set is empty — see
   *  `availableDatesLoading` for that case. */
  availableDates: ReadonlySet<string>;
  /** True while the per-day availability scan is still in flight.
   *  During this window the grid stays optimistic — cells default
   *  to enabled rather than disabled — so the patient never sees
   *  a "everything looks closed" flash before the data lands. Once
   *  loading flips false the set is authoritative. */
  availableDatesLoading: boolean;
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
      <Month
        monthDate={monthCursor}
        selectedDate={selectedDate}
        openingHours={openingHours}
        durationMinutes={durationMinutes}
        availableDates={availableDates}
        availableDatesLoading={availableDatesLoading}
        onSelectDate={onSelectDate}
      />
    </div>
  );
}

function Month({
  monthDate,
  selectedDate,
  openingHours,
  durationMinutes,
  availableDates,
  availableDatesLoading,
  onSelectDate,
}: {
  monthDate: Date;
  selectedDate: Date;
  openingHours: OpeningHoursWeek;
  durationMinutes: number;
  availableDates: ReadonlySet<string>;
  availableDatesLoading: boolean;
  onSelectDate: (d: Date) => void;
}) {
  const cells = useMemo(() => buildMonthCells(monthDate), [monthDate]);
  const today = startOfDay(new Date());
  // Whether today still has a slot the customer could pick. We
  // compute against the same stub generator the init logic uses so
  // the calendar's "today disabled" state always agrees with the
  // auto-selected starting date — if firstAvailable() decided to
  // skip today, the calendar shouldn't offer it back. The check
  // happens once per Month render; sub-minute drift between mount
  // and click is acceptable (server's past-slot guard catches it).
  const todayHasOpening = useMemo(() => {
    const nowMs = Date.now();
    return generateSlots(today, durationMinutes).some(
      (s) => new Date(s.iso).getTime() > nowMs,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMinutes, today.getTime()]);

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
              fontSize: 12,
              fontWeight: 500,
              color: SUBTLE,
              textAlign: 'center',
              padding: '4px 0 8px',
            }}
          >
            {d}
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: 2 }}>
        {cells.map((c, i) => {
          const inMonth = c.date.getMonth() === monthDate.getMonth();
          const isPast = c.date < today;
          const isToday = sameDay(c.date, today);
          const closed = isClinicClosedOn(c.date, openingHours);
          // Today is treated as past once its remaining openings
          // can no longer fit a slot of this duration before
          // clinic close.
          const todayExhausted = isToday && !todayHasOpening;
          // Per-day live availability: once the scan has resolved,
          // cells whose date isn't in the returned set have no
          // bookable slot (fully booked, pool exhausted, or the
          // catalogue row doesn't apply). Disable them so the
          // patient can't tap a day and then see the empty state.
          // While the scan is still loading we treat every
          // otherwise-valid day as enabled — the optimistic state
          // is fine because the init-pin already anchors the
          // selectedDate to the first genuinely-bookable day, so
          // the *initial* click target is correct even before the
          // grid-wide disable refines.
          const hasNoLiveSlots =
            !availableDatesLoading &&
            inMonth &&
            !isPast &&
            !todayExhausted &&
            !closed &&
            !availableDates.has(toIsoDate(c.date));
          const disabled =
            isPast || todayExhausted || closed || !inMonth || hasNoLiveSlots;
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
                background: 'transparent',
                width: '100%',
                height: 40,
                padding: 0,
                fontFamily: 'inherit',
                cursor: disabled ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => {
                if (selected || disabled) return;
                const inner = e.currentTarget.firstElementChild as HTMLElement | null;
                if (inner) inner.style.background = '#eef1f4';
              }}
              onMouseLeave={(e) => {
                if (selected || disabled) return;
                const inner = e.currentTarget.firstElementChild as HTMLElement | null;
                if (inner) inner.style.background = 'transparent';
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: selected ? ACCENT : 'transparent',
                  // Available cells render their digit in the brand
                  // accent (navy) so they stand visually apart from
                  // the muted disabled cells. Selected stays as the
                  // solid-disc treatment with white text. Disabled
                  // keeps the existing subtle-grey + 55% opacity
                  // fade so the visual hierarchy is unambiguous.
                  // Matches the staff DatePicker's tint approach.
                  color: selected
                    ? '#FFFFFF'
                    : disabled
                      ? SUBTLE
                      : ACCENT,
                  fontSize: 14,
                  fontWeight: selected ? 600 : 500,
                  fontVariantNumeric: 'tabular-nums',
                  opacity: disabled && !selected ? 0.55 : 1,
                  transition: `background 0.15s ${EASE_CARD}, color 0.15s ${EASE_CARD}`,
                }}
              >
                {c.date.getDate()}
              </span>
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
  allTodaysSlotsPassed,
}: {
  slots: WidgetSlot[];
  loading: boolean;
  error: string | null;
  selectedIso: string | null;
  onPick: (iso: string | null) => void;
  /** True when the server returned slots for this date but every
   *  one is in the past (selected date is today, current time is
   *  past the last opening). Used to swap the empty-state copy from
   *  the generic "Nothing free" line to a more specific message. */
  allTodaysSlotsPassed: boolean;
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
          border: `1px solid ${QUIZ.ALERT}`,
          borderRadius: 12,
          padding: 18,
          textAlign: 'center',
          color: QUIZ.ALERT,
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        Couldn't load availability. Try refreshing the page.
      </div>
    );
  }

  if (slots.length === 0) {
    const emptyMessage = loading
      ? 'Checking availability…'
      : allTodaysSlotsPassed
        ? "Today's slots have all passed. Pick another date."
        : 'Nothing free on this day. Pick another date.';
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
        {emptyMessage}
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
  onPick: (iso: string | null) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <div>
      <h4
        style={{
          margin: 0,
          marginBottom: 12,
          fontSize: 15,
          fontWeight: 700,
          color: INK,
          letterSpacing: '-0.01em',
        }}
      >
        {label}
      </h4>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
          gap: 10,
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
                height: 44,
                padding: '0 12px',
                borderRadius: 999,
                border: `1px solid ${selected ? ACCENT : 'rgba(0, 0, 0, 0.08)'}`,
                background: selected ? ACCENT : SURFACE,
                color: selected ? '#FFFFFF' : INK,
                cursor: 'pointer',
                textAlign: 'center',
                boxSizing: 'border-box',
                boxShadow: selected
                  ? '0 2px 6px rgba(8, 55, 88, 0.22)'
                  : 'none',
                transition: `border-color 0.15s ${EASE_CARD}, background 0.15s ${EASE_CARD}, color 0.15s ${EASE_CARD}, box-shadow 0.15s ${EASE_CARD}, transform 0.15s ${EASE_CARD}`,
              }}
              onMouseEnter={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = ACCENT;
                e.currentTarget.style.color = ACCENT;
                e.currentTarget.style.boxShadow = '0 4px 10px rgba(15, 23, 42, 0.08)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                if (selected) return;
                e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.08)';
                e.currentTarget.style.color = INK;
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'none';
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

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

// Closed-day predicate keyed on the live clinic.opening_hours
// shape. The opening-hours array is Mon-first (Mon=0..Sun=6); the
// JS Date.getDay() is Sun-first (Sun=0..Sat=6). Convert and read
// the `closed: true` flag set by the admin in Settings → Opening
// times. Replaces the old hardcoded "Sunday only" rule.
function isClinicClosedOn(date: Date, week: OpeningHoursWeek): boolean {
  const monFirst = (date.getDay() + 6) % 7;
  const entry = week[monFirst];
  if (!entry) return true;
  if (entry.closed === true) return true;
  // Defensive — a day with no open/close also reads as closed.
  if (!entry.open || !entry.close) return true;
  return false;
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
