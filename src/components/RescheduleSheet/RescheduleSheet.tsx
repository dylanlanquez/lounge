import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock } from 'lucide-react';
import {
  BottomSheet,
  Button,
  ConflictBlock,
  DatePicker,
  FieldTrigger,
  InlineHint,
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
  type DayOfWeek,
  type ResolvedBookingTypeConfig,
  resolveBookingTypeConfig,
} from '../../lib/queries/bookingTypes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  checkBookingConflict,
  rescheduleAppointment,
} from '../../lib/queries/rescheduleAppointment.ts';

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
  // need so we don't double-fetch what they already have.
  appointment: {
    id: string;
    patient_id: string;
    location_id: string;
    service_type: BookingServiceType | null;
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
        const c = await resolveBookingTypeConfig({ service_type: serviceType });
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
  }, [open, config, date, time, appointment.id, appointment.location_id, serviceType]);

  // ── Working-hours derivation for the chosen date ───────────────
  const hoursForDate = useMemo(() => {
    if (!date || !config) return null;
    const dow = dayOfWeekFromIsoDate(date);
    if (!dow) return null;
    return config.working_hours[dow] ?? null;
  }, [date, config]);

  const inWorkingHours = useMemo(() => {
    if (!hoursForDate || !time) return false;
    return time >= hoursForDate.open && time < hoursForDate.close;
  }, [hoursForDate, time]);

  const slotIsValid = !!config && !!date && !!time && inWorkingHours;
  const canSave =
    slotIsValid &&
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

          <Section
            title="New slot"
            required
            info="Pick the date and start time the appointment is moving to. The slot is checked live against the service's working hours and any other bookings claiming the same resources. Save is disabled until the new slot is in hours and conflict-free."
          >
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: theme.space[3] }}>
              <FieldTrigger
                ref={dateTriggerRef}
                label="Date"
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
                label="Start time"
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
            />
            {config ? (
              <InlineHint tone={hoursForDate || !date ? 'muted' : 'alert'}>
                {config.duration_default}-minute slot
                {hoursForDate
                  ? `. Hours that day: ${hoursForDate.open} to ${hoursForDate.close}.`
                  : date
                  ? '. The clinic is closed on this day.'
                  : '.'}
              </InlineHint>
            ) : null}
            {config && date && time ? (
              <ReturnSegmentHints
                phases={config.phases}
                startIso={composeIso(date, time)}
              />
            ) : null}
            {!inWorkingHours && date && time && hoursForDate ? (
              <div style={{ marginTop: theme.space[3] }}>
                <StatusBanner tone="warning" title="Outside working hours">
                  This service runs {hoursForDate.open} to {hoursForDate.close} on the day you picked.
                </StatusBanner>
              </div>
            ) : null}
            <div style={{ marginTop: theme.space[3] }}>
              <ConflictBlock
                checking={checkingConflicts}
                conflicts={conflicts}
                error={conflictError}
                slotIsValid={slotIsValid}
                durationMinutes={config?.duration_default ?? null}
                freeBody="Slot is free. Saving will move the appointment and email a calendar update to the patient if they have one on file."
              />
            </div>
          </Section>

          <Section
            title="Reason"
            info="Optional. Stored on the rescheduled-out row's cancel_reason and surfaced on the patient's timeline event so the team has context next time they look the appointment up."
          >
            <Input
              aria-label="Reason for reschedule"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. patient asked to move; staff sick day; equipment delay."
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
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          Currently booked
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatLongDate(start)} · {formatTime(start)} to {formatTime(end)}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// (The ISO splitters and dayOfWeekFromIsoDate are duplicated in
// NewBookingSheet — a deliberate choice given they're 5-line pure
// functions and extracting them would force both sheets to evolve
// in lockstep on what is otherwise unrelated date work.)
// ─────────────────────────────────────────────────────────────────────────────

function splitIso(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

function composeIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}


function dayOfWeekFromIsoDate(isoDate: string): DayOfWeek | null {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const map: Record<number, DayOfWeek> = {
    0: 'sun',
    1: 'mon',
    2: 'tue',
    3: 'wed',
    4: 'thu',
    5: 'fri',
    6: 'sat',
  };
  return map[d.getDay()] ?? null;
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
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
  const f = first?.trim();
  const l = last?.trim();
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
