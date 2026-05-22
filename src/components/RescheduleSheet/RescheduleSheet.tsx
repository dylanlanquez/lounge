import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock } from 'lucide-react';
import {
  BottomSheet,
  Button,
  ConflictBlock,
  DatePicker,
  FieldTrigger,
  Input,
  ReturnSegmentHints,
  Section,
  StatusBanner,
  TimePicker,
  Toast,
} from '../index.ts';
import { theme } from '../../theme/index.ts';
import {
  type BookingServiceType,
  type ResolvedBookingTypeConfig,
  resolveBookingTypeConfig,
} from '../../lib/queries/bookingTypes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  checkBookingConflict,
  rescheduleAppointment,
} from '../../lib/queries/rescheduleAppointment.ts';
import { loadAvailableSlots } from '../../lib/queries/bookingAvailableSlots.ts';
import { properCase } from '../../lib/queries/appointments.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';
import { useAvailableDates } from '../../lib/queries/bookingAvailability.ts';
import { monthGridWindowForIso, todayIso } from '../../lib/calendarMonth.ts';
import { effectiveDayHoursForDate, useClinicSettings } from '../../lib/queries/clinicSettings.ts';

// RescheduleSheet — bottom-sheet UI for moving a native (manual /
// native-source) Lounge appointment to a different slot.
//
// What it does, top to bottom:
//
//   1. Displays the currently-booked slot in a soft summary card so
//      the operator can compare against the new one without having
//      to remember.
//   2. Loads the booking type's config (working hours per day,
//      duration_default) so it knows the new slot's window and
//      length.
//   3. Date + time field-triggers open the in-app DatePicker and
//      TimePicker. The TimePicker's range narrows to the booking
//      type's working hours for the picked day, so off-hours slots
//      can't even be reached from the picker.
//   4. Live conflict-check (debounced 250ms) hits
//      lng_booking_check_conflict, surfacing the result inline via
//      the shared ConflictBlock.
//   5. Optional reason — written to lng_appointments.cancel_reason
//      on the rescheduled-out row, surfaced on the patient's
//      timeline event.
//   6. Save calls rescheduleAppointment(...). On a server-side
//      conflict (last-millisecond race), the inline conflict block
//      re-renders with what the server actually saw.
//
// Visual language matches NewBookingSheet: title icon pill,
// Section headers with (i) tooltips, FieldTrigger inputs, InlineHint
// for dynamic state, StatusBanner for warnings / errors. All shared
// primitives so the two sheets can't drift.

export interface RescheduleSheetProps {
  open: boolean;
  onClose: () => void;
  // The appointment being rescheduled. Caller passes everything we
  // need so we don't double-fetch what they already have. Axis pins
  // (repair_variant / product_key / arch) MUST be threaded in:
  // the availability + conflict-check RPCs resolve the correct
  // per-product duration from these, and the customer-facing widget
  // already passes them. Without them, the reschedule date/time
  // picker uses the parent service's default duration and shows a
  // different set of available dates than the widget would for the
  // same booking — Dylan flagged exactly that.
  appointment: {
    id: string;
    patient_id: string;
    location_id: string;
    service_type: BookingServiceType | null;
    repair_variant: string | null;
    product_key: string | null;
    arch: 'upper' | 'lower' | 'both' | null;
    source: 'calendly' | 'manual' | 'native';
    start_at: string;
    end_at: string;
    patient_first_name: string | null;
    patient_last_name: string | null;
  };
  onRescheduled: (newAppointmentId: string) => void;
}

export function RescheduleSheet({
  open,
  onClose,
  appointment,
  onRescheduled,
}: RescheduleSheetProps) {
  const initial = useMemo(() => splitIso(appointment.start_at), [appointment.start_at]);
  const [date, setDate] = useState<string>(initial.date);
  const [time, setTime] = useState<string>(initial.time);
  const [reason, setReason] = useState<string>('');

  const [config, setConfig] = useState<ResolvedBookingTypeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RescheduleConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string } | null>(null);

  // In-app pickers replace the native <input type="date"> and
  // <input type="time"> so the experience matches the rest of the
  // form and respects the no-system-UI-dropdowns rule.
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const timeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const serviceType = appointment.service_type ?? 'other';

  // ── Load booking-type config when the sheet opens ──────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    (async () => {
      try {
        // Pass the axis pins through so the resolver returns the
        // per-(product, arch, repair-variant) override's duration,
        // not the parent service's default. Without this, a 30-min
        // retainer would resolve to the 60-min parent default and
        // the conflict check below would look for 60-min slots,
        // dimming dates that actually have plenty of 30-min slots.
        const c = await resolveBookingTypeConfig({
          service_type: serviceType,
          repair_variant: appointment.repair_variant,
          product_key: appointment.product_key,
          arch: appointment.arch,
        });
        if (cancelled) return;
        if (!c) {
          setConfigError(
            `No booking-type config for "${serviceType}". Set the parent defaults in Admin, Booking types first.`,
          );
          return;
        }
        setConfig(c);
      } catch (e) {
        if (cancelled) return;
        setConfigError(e instanceof Error ? e.message : 'Could not load booking config.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serviceType]);

  // ── Live conflict check on slot change (debounced 250ms) ───────
  useEffect(() => {
    if (!open || !config) return;
    const newStart = composeIso(date, time);
    if (!newStart) {
      setConflicts([]);
      setConflictError(null);
      return;
    }
    const newEnd = new Date(
      new Date(newStart).getTime() + config.duration_default * 60_000,
    ).toISOString();
    let cancelled = false;
    setCheckingConflicts(true);
    const t = setTimeout(async () => {
      try {
        const result = await checkBookingConflict({
          locationId: appointment.location_id,
          serviceType: serviceType as BookingServiceType,
          startAt: newStart,
          endAt: newEnd,
          // Exclude the appointment being rescheduled so it doesn't
          // conflict with itself when the new slot overlaps the old.
          excludeAppointmentId: appointment.id,
          // Axis pins so the RPC resolves the right duration AND
          // applies the correct pool/capacity constraints for this
          // specific product/variant — same parameters the widget
          // passes when computing the original booking's slots.
          repairVariant: appointment.repair_variant,
          productKey: appointment.product_key,
          arch: appointment.arch,
        });
        if (cancelled) return;
        setConflicts(result);
        setConflictError(null);
      } catch (e) {
        if (cancelled) return;
        setConflictError(e instanceof Error ? e.message : 'Could not check the slot.');
      } finally {
        if (!cancelled) setCheckingConflicts(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    open,
    config,
    date,
    time,
    appointment.id,
    appointment.location_id,
    appointment.repair_variant,
    appointment.product_key,
    appointment.arch,
    serviceType,
  ]);

  // ── Available slots for the picked day ─────────────────────────
  // Same flow as NewBookingSheet: the TimePicker only renders
  // HH:MM slots that pass the conflict check, so the operator
  // can't land on a busy time. excludeAppointmentId lets the
  // current slot still appear (the row being moved doesn't count
  // against itself).
  // Per-month availability for the date picker so closed days
  // (clinic shut on the picked weekday) and empty days (no free
  // slots in the visible window) dim out instead of being tappable.
  // Mirrors the New Booking sheet — the date picker tells us which
  // window it's currently rendering via onVisibleMonthChange and
  // we ask the server for that window's bookable set. The picker
  // already excludes the current appointment from conflict checks
  // via lng_widget_available_dates → lng_widget_available_slots →
  // lng_booking_check_conflict (which we don't pass an excludeId
  // to), so the very-edge case of "the current slot is the only
  // one free that day" lights up only when the operator picks
  // that day manually — the calendar treats it as empty. That's
  // an acceptable tradeoff: the operator can still land on the
  // current slot via the date+time fields, just not via a
  // calendar tap.
  // Seeded with the 42-cell grid window for the appointment's current
  // month so the availability fetch fires on sheet mount, not on
  // picker open. Without this seed, calendarWindow stays {null, null}
  // until the operator taps the date field; the picker then opens
  // with an empty `dates` Set, paints every cell dim, and "flashes"
  // to its real state ~100-500ms later when the RPC settles. By the
  // time the operator gets to the date field, the data is usually
  // already cached and the first paint shows the correct pill / dim
  // chrome in one frame. Picker-driven onVisibleMonthChange still
  // runs on open and on month navigation; the no-op guard inside
  // onCalendarWindow bails when the strings match, so the seeded
  // window doesn't trigger a redundant refetch.
  const [calendarWindow, setCalendarWindow] = useState<{
    fromIso: string | null;
    toIso: string | null;
  }>(() => {
    const window = monthGridWindowForIso(initial.date || todayIso());
    return { fromIso: window.firstIso, toIso: window.lastIso };
  });

  // Stabilise the callback identity so DatePicker's effect deps don't
  // re-fire on every parent render. An inline arrow would create a
  // new function each render → DatePicker's [open, year, month,
  // onVisibleMonthChange] effect re-fires → calls setCalendarWindow
  // with a new object literal → parent re-renders → new arrow → loop.
  // useCallback + functional setState makes the identity stable and
  // bails out of no-op state updates by reference-equality at the
  // window object level (a fresh window with the same strings still
  // forces a re-render; functional update avoids the closure trap
  // around stale state).
  const onCalendarWindow = useCallback((fromIso: string, toIso: string) => {
    setCalendarWindow((prev) => {
      if (prev.fromIso === fromIso && prev.toIso === toIso) return prev;
      return { fromIso, toIso };
    });
  }, []);
  const monthAvailability = useAvailableDates({
    locationId: appointment.location_id,
    serviceType: serviceType ? (serviceType as string) : null,
    // Axis pins forwarded so the date-availability RPC resolves the
    // SAME duration the widget would for this booking. Previously
    // these were hardcoded null and the calendar dimmed dates that
    // would actually accommodate the booking (because the RPC
    // looked for parent-default-duration slots, not the per-product
    // override). Dylan's flag: "must match exactly the original
    // booking layout and way it works".
    repairVariant: appointment.repair_variant,
    productKey: appointment.product_key,
    arch: appointment.arch,
    fromIso: calendarWindow.fromIso,
    toIso: calendarWindow.toIso,
  });

  const [availableSlots, setAvailableSlots] = useState<string[] | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState<boolean>(false);
  useEffect(() => {
    if (!open || !config || !date) {
      setAvailableSlots(null);
      setAvailabilityLoading(false);
      return;
    }
    let cancelled = false;
    setAvailabilityLoading(true);
    (async () => {
      try {
        const rawSlots = await loadAvailableSlots({
          locationId: appointment.location_id,
          serviceType: serviceType as BookingServiceType,
          date,
          excludeAppointmentId: appointment.id,
          // Axis pins so the per-day slot list matches what the
          // widget would render for this exact (service, product,
          // variant, arch) combination. Same RPC, same parameters.
          repairVariant: appointment.repair_variant,
          productKey: appointment.product_key,
          arch: appointment.arch,
        });
        if (cancelled) return;
        // Strip past times when the picked date is today (the
        // operator might be moving an appointment forward to later
        // today). Mirrors the new-booking sheet — the slot scanner
        // returns every working slot regardless of clock time, the
        // client filters past ones out so the picker only surfaces
        // bookable times.
        const isToday = date === todayIso();
        const slots = isToday
          ? rawSlots.filter((slot) => {
              const iso = composeIso(date, slot);
              if (!iso) return false;
              return new Date(iso).getTime() > Date.now();
            })
          : rawSlots;
        setAvailableSlots(slots);
        // If the operator moves the date to one where the current
        // time is no longer free (or out of hours), snap to the
        // first available slot rather than leaving the form on a
        // banner-warning state.
        const first = slots[0];
        if (first && !slots.includes(time)) {
          setTime(first);
        }
      } catch {
        if (!cancelled) setAvailableSlots(null);
      } finally {
        if (!cancelled) setAvailabilityLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    config,
    date,
    appointment.id,
    appointment.location_id,
    appointment.repair_variant,
    appointment.product_key,
    appointment.arch,
    serviceType,
  ]);

  // ── Working-hours derivation for the chosen date ───────────────
  // Per-booking-type hours win when set (resolver already merged
  // child → parent); otherwise the clinic-wide row supplies them.
  // Mirrors the slot RPC's fallback chain so the picker and the
  // pre-submit gate agree.
  const clinic = useClinicSettings();
  const hoursForDate = useMemo(() => {
    if (!date) return null;
    return effectiveDayHoursForDate(
      config?.working_hours ?? null,
      clinic.data.openingHours,
      date,
    );
  }, [date, clinic.data.openingHours, config?.working_hours]);

  const inWorkingHours = useMemo(() => {
    if (!hoursForDate || !time) return false;
    if (time < hoursForDate.open || time >= hoursForDate.close) return false;
    const lunch = hoursForDate.break ?? null;
    if (lunch && lunch.end > lunch.start && time >= lunch.start && time < lunch.end) {
      return false;
    }
    return true;
  }, [hoursForDate, time]);

  // Defensive end-vs-close check — picker filters past-close starts,
  // but a stale typed value or a date change could still slip
  // through. Mirrors the GREATEST(duration, block) extent the RPC
  // uses.
  const fitsBeforeClose = useMemo(() => {
    if (!config || !hoursForDate || !time) return false;
    const extent = Math.max(
      config.duration_default,
      config.block_duration_minutes ?? config.duration_default,
    );
    const [closeH, closeM] = hoursForDate.close.split(':').map(Number);
    const [startH, startM] = time.split(':').map(Number);
    if ([closeH, closeM, startH, startM].some((n) => !Number.isFinite(n))) {
      return false;
    }
    const startMin = (startH ?? 0) * 60 + (startM ?? 0);
    const closeMin = (closeH ?? 0) * 60 + (closeM ?? 0);
    return startMin + extent <= closeMin;
  }, [config, hoursForDate, time]);

  const slotIsValid =
    !!config && !!date && !!time && inWorkingHours && fitsBeforeClose;
  // A reason on the new row's cancellation note is the audit trail
  // for why the slot moved — staff sick day, patient asked, equipment
  // delay, etc. Without it the patient timeline reads "Rescheduled"
  // with no context next time anyone looks it up, which is the bit
  // that bites at the till. Mandatory so the audit trail is always
  // complete.
  const reasonGiven = reason.trim().length > 0;
  const canSave =
    slotIsValid &&
    reasonGiven &&
    conflicts.length === 0 &&
    !checkingConflicts &&
    !saving &&
    !configError &&
    !conflictError;

  const onSave = async () => {
    if (!canSave) return;
    const newStart = composeIso(date, time);
    if (!newStart) return;
    setSaving(true);
    try {
      const result = await rescheduleAppointment({
        appointmentId: appointment.id,
        newStartAt: newStart,
        reason,
      });
      onRescheduled(result.newAppointmentId);
    } catch (e) {
      if (e instanceof RescheduleConflictError) {
        // Race: another booking landed in this slot between the
        // last live-check and Save. Surface the fresh conflicts.
        setConflicts(e.conflicts);
        setToast({ tone: 'error', title: 'Slot just became unavailable' });
      } else {
        setToast({
          tone: 'error',
          title: e instanceof Error ? e.message : 'Could not reschedule',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const patientName = composePatientName(
    appointment.patient_first_name,
    appointment.patient_last_name,
  );

  return (
    <>
      <BottomSheet
        open={open}
        onClose={onClose}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3] }}>
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: theme.radius.pill,
                background: theme.color.accentBg,
                color: theme.color.accent,
                flexShrink: 0,
              }}
            >
              <CalendarClock size={18} aria-hidden />
            </span>
            Reschedule appointment
          </span>
        }
        description={
          patientName ? (
            <span>
              Moving <strong>{patientName}</strong>'s {humaniseService(serviceType)} appointment to
              a new slot. The new booking replaces the existing one.
            </span>
          ) : (
            <span>
              Moving the {humaniseService(serviceType)} appointment to a new slot. The new booking
              replaces the existing one.
            </span>
          )
        }
        footer={
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: theme.space[2],
            }}
          >
            <Button variant="tertiary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSave} disabled={!canSave} loading={saving}>
              {saving ? 'Saving…' : 'Reschedule'}
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <CurrentSlotSummary appointment={appointment} />

          {configError ? (
            <StatusBanner tone="error" title="Couldn't load booking config">
              {configError}
            </StatusBanner>
          ) : null}

          {config ? (
          <Section
            title="New slot"
            required
            info="Pick the date and start time the appointment is moving to. The slot is checked live against the service's working hours and any other bookings claiming the same resources. Save is disabled until the new slot is in hours and conflict-free."
          >
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: theme.space[3] }}>
              <FieldTrigger
                ref={dateTriggerRef}
                icon={<CalendarClock size={16} aria-hidden />}
                value={date ? formatDateLong(date) : ''}
                placeholder="Pick a date"
                open={dateOpen}
                onClick={() => {
                  setTimeOpen(false);
                  setDateOpen((v) => !v);
                }}
              />
              <FieldTrigger
                ref={timeTriggerRef}
                icon={<Clock size={16} aria-hidden />}
                value={time}
                placeholder="Pick a time"
                open={timeOpen}
                onClick={() => {
                  setDateOpen(false);
                  setTimeOpen((v) => !v);
                }}
              />
            </div>
            <DatePicker
              open={dateOpen}
              onClose={() => setDateOpen(false)}
              value={date}
              onChange={(iso) => setDate(iso)}
              anchorRef={dateTriggerRef}
              title="Pick the new date"
              minIso={todayIso()}
              // Always pass the Set, never undefined. The hook's
              // initial state is an empty Set — which correctly
              // disables every cell until the first fetch returns.
              // The previous shape (`loading ? undefined : dates`)
              // rendered as "no whitelist → all dates enabled"
              // during the load window, which silently re-opened
              // closed days whenever the loading flag stayed true
              // for any reason (slow RPC, effect loop, stale
              // cache). Dim-all initial state is the honest "we
              // don't know yet" signal.
              availableDates={monthAvailability.dates}
              availableDatesLoading={monthAvailability.loading}
              onVisibleMonthChange={onCalendarWindow}
            />
            <TimePicker
              open={timeOpen}
              onClose={() => setTimeOpen(false)}
              value={time}
              onChange={(t) => setTime(t)}
              anchorRef={timeTriggerRef}
              title="Pick the new start time"
              startHour={hoursForDate ? clampHour(hoursForDate.open) : 6}
              endHour={hoursForDate ? clampHour(hoursForDate.close, true) : 22}
              availableSlots={availableSlots ?? undefined}
              availabilityLoading={availabilityLoading}
              emptyMessage={
                hoursForDate
                  ? 'No free times that day.'
                  : 'Closed on this day.'
              }
            />
            {/* The duration/hours hint AND the "Loading available
                dates…" hint that used to live here have both been
                removed. The picker already restricts the operator
                to slots inside working hours, dims everything
                while the availability fetch is in flight, and
                lights up only the bookable dates once the data
                returns. The explicit "Loading…" message flickered
                on every fetch cycle (open / month-change); the
                dim-all-then-light-up behaviour is signal enough.
                Result: a clean reschedule sheet that visually
                matches the new-booking surface. */}
            {config && date && time ? (
              <ReturnSegmentHints
                phases={config.phases}
                startIso={composeIso(date, time)}
              />
            ) : null}
            {/* "Outside working hours" StatusBanner removed — the
                date picker's whitelist hides closed/empty days, and
                the time picker's allow-list omits past times on
                today. The state is now structurally unreachable.
                Conflicts (last-millisecond race vs another
                concurrent edit) still flow through ConflictBlock. */}
            <div style={{ marginTop: theme.space[3] }}>
              <ConflictBlock
                checking={checkingConflicts}
                conflicts={conflicts}
                error={conflictError}
                slotIsValid={slotIsValid}
                durationMinutes={config?.duration_default ?? null}
                /* silentChecking hides the in-flight "Checking
                 * availability…" banner; the picker already restricts
                 * the operator to free times, so the optimistic
                 * re-check is defence-in-depth and doesn't need a
                 * visible state. Real conflicts and RPC errors still
                 * render. The success-state banner ("Slot is free…")
                 * was removed wholesale from ConflictBlock itself
                 * — see that file for the rationale. */
                silentChecking
              />
            </div>
          </Section>
          ) : null}

          <Section
            title="Reason"
            required
            info="A short note about why the appointment is moving. It appears on the patient's timeline so anyone reading it later can see what happened, without having to ask around."
          >
            <Input
              aria-label="Reason for reschedule"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. patient asked to move, staff sick day, equipment delay"
            />
          </Section>
        </div>
      </BottomSheet>
      {toast ? (
        <Toast tone={toast.tone} title={toast.title} onDismiss={() => setToast(null)} />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

// Soft summary card showing the slot the appointment is currently
// in. Sits at the top of the sheet so the operator can compare new
// slot against old without flipping back to the schedule. Visual
// language is intentionally quieter than the input rows below: the
// appointment is read-only here, the new slot is the actionable bit.
function CurrentSlotSummary({
  appointment,
}: {
  appointment: RescheduleSheetProps['appointment'];
}) {
  const start = new Date(appointment.start_at);
  const end = new Date(appointment.end_at);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.radius.pill,
          background: theme.color.surface,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          border: `1px solid ${theme.color.border}`,
        }}
      >
        <CalendarClock size={14} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
          }}
        >
          Currently booked
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {formatLongDate(start)} · {formatTime(start)} to {formatTime(end)} {fmtTzAbbr(start.toISOString())}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// (The ISO splitters are duplicated in NewBookingSheet — a
// deliberate choice given they're tiny pure functions and
// extracting them would force both sheets to evolve in lockstep on
// what is otherwise unrelated date work.)
// ─────────────────────────────────────────────────────────────────────────────

function splitIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  // Split into clinic-time wall-clock components so the date and
  // time inputs above show UK time regardless of device timezone.
  // A booking at 10:30 BST always shows as 10:30 in the editor for
  // a Cairo-based staff member too.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function composeIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  // Interpret the typed date + time as clinic-time wall clock,
  // then back out the BST/GMT offset to produce the matching UTC
  // instant. Without this, a Cairo-based staff member typing
  // "10:30" would have stored 07:30 UTC (= 08:30 BST) instead of
  // the intended 09:30 UTC (= 10:30 BST).
  const [Y, M, D] = date.split('-').map(Number);
  const [hh, mi] = time.split(':').map(Number);
  if (!Y || !M || !D || Number.isNaN(hh) || Number.isNaN(mi)) return null;
  // Naive UTC built from the typed parts. The brief "treat as UTC"
  // step is corrected below using the London wall-clock difference.
  const naiveUtc = Date.UTC(Y, M - 1, D, hh, mi, 0);
  const offset = londonOffsetMs(new Date(naiveUtc));
  return new Date(naiveUtc - offset).toISOString();
}

// What does this instant read as in clinic time, minus what it
// reads as in UTC, expressed in milliseconds? Positive = London is
// ahead of UTC (BST → +1h). Used by composeIso to back the offset
// out of a "treat the typed parts as UTC" approximation.
function londonOffsetMs(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const londonAsUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour') % 24,
    n('minute'),
    n('second'),
  );
  return londonAsUtc - d.getTime();
}


function formatLongDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(d: Date): string {
  // Pinned to clinic time so a UK booking always reads as UK time
  // for staff in any country. Zone abbreviation (BST/GMT) is added
  // once at the end of the range by the caller, not per-time.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function humaniseService(s: string): string {
  switch (s) {
    case 'denture_repair':
      return 'denture repair';
    case 'click_in_veneers':
      return 'click-in veneers';
    case 'same_day_appliance':
      return 'same-day appliance';
    case 'impression_appointment':
      return 'impression';
    default:
      return 'appointment';
  }
}

function composePatientName(first: string | null, last: string | null): string | null {
  const f = properCase(first ?? '').trim();
  const l = properCase(last ?? '').trim();
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(' ');
}

// Working-hours strings come back as 'HH:MM'; bound them to whole
// hours for the TimePicker's startHour / endHour scrollable range.
// `endRoundUp` rounds 18:30 to 19 so the last in-hours slot is
// reachable.
function clampHour(hhmm: string, endRoundUp = false): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return endRoundUp ? 22 : 6;
  if (endRoundUp && m > 0) return Math.min(23, h + 1);
  return h;
}
