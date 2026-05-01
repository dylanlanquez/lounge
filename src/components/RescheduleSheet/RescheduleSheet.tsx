import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Check } from 'lucide-react';
import { Button, BottomSheet, Input, Toast } from '../index.ts';
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

// RescheduleSheet — bottom-sheet UI for rescheduling a native
// (manual / native) Lounge appointment. Calendly-sourced rows are
// guarded out by the caller; the helper would refuse anyway with a
// clear message.
//
// What it does:
//   1. Loads the booking type config for the appointment's service
//      so it knows the working hours window per day-of-week and the
//      duration to apply to the new slot.
//   2. Renders a date input + time input. The day/time the user
//      picks together compose the new start_at; new end_at is
//      derived from the booking type's duration_default.
//   3. Live-checks for slot conflicts (pool capacity / max
//      concurrent) every time the slot or duration changes,
//      surfacing them inline.
//   4. On Save, calls rescheduleAppointment(...). On a conflict
//      error from the server (last-minute race), the inline
//      conflict block re-renders with what the server saw.

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
  // Initial date + time pulled from the existing slot so the form
  // opens in a sensible default state — typically the staff member
  // is shifting it by a day or by an hour, not booking from
  // scratch.
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

  // ── Load booking type config once when the sheet opens ──────────
  const serviceType = appointment.service_type ?? 'other';
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
            `No booking-type config for "${serviceType}". Set the parent defaults in Admin → Booking types first.`,
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

  // ── Live conflict check on slot change ─────────────────────────
  // Debounced via the closure timer so rapid typing in the time
  // input doesn't fire a query per keystroke.
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

  // ── Working-hours validation for the chosen date ────────────────
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
        title="Reschedule appointment"
        description={
          patientName ? (
            <span>
              Moving <strong>{patientName}</strong>'s {humaniseService(serviceType)} appointment.
              The new slot will replace the existing one.
            </span>
          ) : (
            <span>
              Moving the {humaniseService(serviceType)} appointment to a new slot.
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
            <ErrorBanner title="Couldn't load booking config" body={configError} />
          ) : null}

          <SlotPicker
            date={date}
            time={time}
            onDateChange={setDate}
            onTimeChange={setTime}
            config={config}
            hoursForDate={hoursForDate}
            inWorkingHours={inWorkingHours}
          />

          <ConflictBlock
            checking={checkingConflicts}
            conflicts={conflicts}
            error={conflictError}
            slotIsValid={slotIsValid}
            durationMinutes={config?.duration_default ?? null}
          />

          <Input
            label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. patient asked to move; staff sick day; equipment delay."
          />
        </div>
      </BottomSheet>
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

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
          width: 28,
          height: 28,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
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
            margin: `2px 0 0`,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatLongDate(start)} · {formatTime(start)}–{formatTime(end)}
        </p>
      </div>
    </div>
  );
}

function SlotPicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  config,
  hoursForDate,
  inWorkingHours,
}: {
  date: string;
  time: string;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  config: ResolvedBookingTypeConfig | null;
  hoursForDate: { open: string; close: string } | null;
  inWorkingHours: boolean;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <header>
        <span
          style={{
            fontSize: theme.type.size.xs,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          New slot
        </span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Date"
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
        />
        <Input
          label="Start time"
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
        />
      </div>
      {config ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: 1.5,
          }}
        >
          Duration: <strong style={{ color: theme.color.ink }}>{config.duration_default} minutes</strong>
          {hoursForDate ? (
            <>
              {' · '}
              {date ? `Hours that day: ${hoursForDate.open}–${hoursForDate.close}` : null}
            </>
          ) : date && config ? (
            <span style={{ color: theme.color.alert }}>
              {' · The clinic is closed on this day.'}
            </span>
          ) : null}
        </p>
      ) : null}
      {!inWorkingHours && date && time && hoursForDate ? (
        <ErrorBanner
          title="Outside working hours"
          body={`This service runs ${hoursForDate.open}–${hoursForDate.close} on the day you picked.`}
          subtle
        />
      ) : null}
    </section>
  );
}

function ConflictBlock({
  checking,
  conflicts,
  error,
  slotIsValid,
  durationMinutes,
}: {
  checking: boolean;
  conflicts: RescheduleConflict[];
  error: string | null;
  slotIsValid: boolean;
  durationMinutes: number | null;
}) {
  if (error) return <ErrorBanner title="Couldn't check the slot" body={error} />;
  if (!slotIsValid) return null;
  if (checking) {
    return (
      <Banner tone="info">
        Checking availability… ({durationMinutes ?? '–'} min slot)
      </Banner>
    );
  }
  if (conflicts.length === 0) {
    return (
      <Banner tone="success">
        Slot is free. Saving will move the appointment and notify nobody (we'll wire emails next).
      </Banner>
    );
  }
  return (
    <ErrorBanner
      title="Slot conflicts"
      body={
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          {conflicts.map((c, i) => (
            <li key={i} style={{ fontSize: theme.type.size.sm, lineHeight: 1.5 }}>
              {c.conflict_kind === 'pool_at_capacity'
                ? `${c.pool_id} is at capacity (${c.current_count}/${c.pool_capacity}).`
                : `Service hits its max-concurrent cap (${c.current_count}/${c.pool_capacity}).`}
            </li>
          ))}
        </ul>
      }
    />
  );
}

function ErrorBanner({
  title,
  body,
  subtle = false,
}: {
  title: string;
  body: React.ReactNode;
  subtle?: boolean;
}) {
  const tone = subtle ? theme.color.warn : theme.color.alert;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: subtle ? theme.color.bg : theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${tone}`,
      }}
    >
      <AlertTriangle size={16} aria-hidden style={{ color: tone, flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {title}
        </p>
        <div style={{ marginTop: 2, fontSize: theme.type.size.xs, color: theme.color.inkMuted, lineHeight: 1.5 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'success' | 'info'; children: React.ReactNode }) {
  const colour = tone === 'success' ? theme.color.accent : theme.color.inkMuted;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: tone === 'success' ? theme.color.accentBg : theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{ color: colour, marginTop: 2, flexShrink: 0, display: 'inline-flex' }}
      >
        {tone === 'success' ? <Check size={16} aria-hidden /> : <CalendarClock size={16} aria-hidden />}
      </span>
      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: 1.5 }}>
        {children}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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
  // JavaScript: 0=Sunday … 6=Saturday. Map to our keys.
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
