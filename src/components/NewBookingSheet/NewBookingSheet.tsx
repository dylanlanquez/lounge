import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  CalendarPlus,
  Clock,
  User,
} from 'lucide-react';
import {
  BottomSheet,
  Button,
  Checkbox,
  ConflictBlock,
  DatePicker,
  DropdownSelect,
  FieldTrigger,
  InlineHint,
  Input,
  Section,
  StatusBanner,
  TimePicker,
  Toast,
} from '../index.ts';
import { PatientSearch } from '../PatientSearch/PatientSearch.tsx';
import { theme } from '../../theme/index.ts';
import {
  type BookingServiceType,
  type DayOfWeek,
  type ResolvedBookingTypeConfig,
  BOOKING_SERVICE_TYPES,
  resolveBookingTypeConfig,
} from '../../lib/queries/bookingTypes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  checkBookingConflict,
} from '../../lib/queries/rescheduleAppointment.ts';
import { createAppointment } from '../../lib/queries/createAppointment.ts';
import { type PatientRow, patientFullName } from '../../lib/queries/patients.ts';

// NewBookingSheet — bottom-sheet UI for creating a brand-new
// native (non-Calendly) appointment. Opened from the Schedule when
// the operator taps an empty slot on the calendar grid.
//
// Flow:
//   1. Pre-fill date + time from the tapped slot.
//   2. Patient picker (search existing patients, scoped to current
//      location via RLS).
//   3. Service picker — drives duration, working hours, and
//      conflict-check pool list via lng_booking_type_resolve.
//   4. Optional staff member.
//   5. Live conflict check against lng_booking_check_conflict.
//      Inline banner: checking / free / outside-hours / pool-conflict.
//   6. Optional notes.
//   7. "Send confirmation email" toggle — defaults on if the
//      patient has an email on file; off otherwise (with a hint).
//   8. Save → createAppointment → onCreated callback closes the sheet.
//
// Save is disabled until: patient + service picked, slot in working
// hours, conflict-check returns no conflicts, no in-flight save.

export interface NewBookingSheetProps {
  open: boolean;
  onClose: () => void;
  // Pre-filled date + time from the tapped calendar slot.
  initialIso: string;
  // Current location — RLS scopes patient search to it; the row
  // gets inserted with this location_id.
  locationId: string;
  // Fired with the new appointment id after a successful insert.
  // Caller is responsible for closing the sheet (via onClose) and
  // refreshing the schedule.
  onCreated: (newAppointmentId: string, info: { emailSent: boolean; emailReason: string | null }) => void;
}

export function NewBookingSheet({
  open,
  onClose,
  initialIso,
  locationId,
  onCreated,
}: NewBookingSheetProps) {
  // ── Form state ──────────────────────────────────────────────────
  const initial = useMemo(() => splitIso(initialIso), [initialIso]);
  const [date, setDate] = useState<string>(initial.date);
  const [time, setTime] = useState<string>(initial.time);
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [serviceType, setServiceType] = useState<BookingServiceType | ''>('');
  const [notes, setNotes] = useState<string>('');
  // Default sendEmail to true, then re-derive once a patient is
  // picked (it stays on if they have an email, off if not). The
  // operator can flip it manually either way.
  const [sendEmail, setSendEmail] = useState<boolean>(true);
  const [sendEmailUserOverride, setSendEmailUserOverride] = useState<boolean>(false);

  // ── Booking-type config + conflict state ───────────────────────
  const [config, setConfig] = useState<ResolvedBookingTypeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<RescheduleConflict[]>([]);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  // In-app date / time pickers replace the native <input type="date">
  // and <input type="time"> so the experience matches the rest of the
  // form and respects the no-system-UI-dropdowns rule.
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const timeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  // Reset form when the sheet opens at a fresh slot. We don't reset
  // on close so the operator's last patient pick survives a
  // backdrop-mistap.
  useEffect(() => {
    if (!open) return;
    const i = splitIso(initialIso);
    setDate(i.date);
    setTime(i.time);
    setPatient(null);
    setServiceType('');
    setNotes('');
    setSendEmail(true);
    setSendEmailUserOverride(false);
    setConfig(null);
    setConfigError(null);
    setConflicts([]);
    setConflictError(null);
  }, [open, initialIso]);

  // Re-derive sendEmail default from patient's email on file, but
  // only if the operator hasn't flipped it manually yet.
  useEffect(() => {
    if (sendEmailUserOverride) return;
    setSendEmail(!!patient?.email);
  }, [patient, sendEmailUserOverride]);

  // ── Resolve booking-type config when the service changes ───────
  useEffect(() => {
    if (!open || !serviceType) {
      setConfig(null);
      setConfigError(null);
      return;
    }
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    (async () => {
      try {
        const c = await resolveBookingTypeConfig({ service_type: serviceType });
        if (cancelled) return;
        if (!c) {
          setConfigError(
            `No booking config for "${serviceType}". Set the parent defaults in Admin, Booking types first.`,
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

  // ── Live conflict check — debounced 250ms ──────────────────────
  useEffect(() => {
    if (!open || !config || !serviceType) return;
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
          locationId,
          serviceType: serviceType as BookingServiceType,
          startAt: newStart,
          endAt: newEnd,
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
  }, [open, config, date, time, locationId, serviceType]);

  // ── Working-hours check ────────────────────────────────────────
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
    !!patient &&
    !!serviceType &&
    slotIsValid &&
    conflicts.length === 0 &&
    !checkingConflicts &&
    !saving &&
    !configError &&
    !conflictError;

  const onSave = async () => {
    if (!canSave || !patient || !serviceType) return;
    const newStart = composeIso(date, time);
    if (!newStart) return;
    setSaving(true);
    try {
      const result = await createAppointment({
        patientId: patient.id,
        locationId,
        serviceType: serviceType as BookingServiceType,
        startAt: newStart,
        notes,
        sendEmail,
      });
      onCreated(result.appointmentId, {
        emailSent: result.emailSent,
        emailReason: result.emailReason,
      });
    } catch (e) {
      if (e instanceof RescheduleConflictError) {
        setConflicts(e.conflicts);
        setToast({ tone: 'error', title: 'Slot just became unavailable' });
      } else {
        setToast({
          tone: 'error',
          title: e instanceof Error ? e.message : 'Could not create the booking',
        });
      }
    } finally {
      setSaving(false);
    }
  };

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
              <CalendarPlus size={18} aria-hidden />
            </span>
            New booking
          </span>
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
              {saving ? 'Saving…' : 'Book it'}
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <Section
            title="Patient"
            info="Search existing patients by phone, name, or email. Also includes Venneir.com customers who haven't been seen at this clinic yet."
          >
            {patient ? (
              <PickedPatient patient={patient} onClear={() => setPatient(null)} />
            ) : (
              <PatientSearch
                onPick={setPatient}
                placeholder="Phone, name, or email"
                enableShopifyLookup={Boolean(locationId)}
                registerLocationId={locationId}
              />
            )}
          </Section>

          <Section
            title="Service"
            required
            info="The service drives the booking's duration and which resources (chair, lab bench, room) it consumes. Working hours and conflict rules come from Admin, Booking types and Conflicts."
          >
            <DropdownSelect<BookingServiceType>
              ariaLabel="Service"
              value={serviceType}
              onChange={(v) => setServiceType(v)}
              options={BOOKING_SERVICE_TYPES}
              placeholder="Choose a service"
            />
            {configError ? (
              <div style={{ marginTop: theme.space[3] }}>
                <StatusBanner tone="error" title="Couldn't load booking config">
                  {configError}
                </StatusBanner>
              </div>
            ) : null}
          </Section>

          <Section
            title="When"
            info="The slot is checked live against the service's working hours and any other bookings claiming the same resources. Save is disabled until the slot is in hours and conflict-free."
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
              title="Pick the booking date"
            />
            <TimePicker
              open={timeOpen}
              onClose={() => setTimeOpen(false)}
              value={time}
              onChange={(t) => setTime(t)}
              anchorRef={timeTriggerRef}
              title="Pick the start time"
              startHour={hoursForDate ? clampHour(hoursForDate.open) : 6}
              endHour={hoursForDate ? clampHour(hoursForDate.close, true) : 22}
            />
            {config ? (
              <InlineHint
                tone={hoursForDate || !date ? 'muted' : 'alert'}
              >
                {config.duration_default}-minute slot
                {hoursForDate
                  ? `. Hours that day: ${hoursForDate.open} to ${hoursForDate.close}.`
                  : date
                  ? '. The clinic is closed on this day.'
                  : '.'}
              </InlineHint>
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
                freeBody="Slot is free. Saving will add it to the schedule."
              />
            </div>
          </Section>

          <Section
            title="Notes"
            info="Optional. Anything the team should know going in. Visible on the schedule card and on the patient profile."
          >
            <Input
              aria-label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. wheelchair access; bringing a translator; allergic to latex."
            />
          </Section>

          <Section
            title="Confirmation email"
            info="Sends a Lounge-branded confirmation with a calendar invite (.ics) attached. Reschedules send a CANCEL for the old slot too so calendars update instead of duplicating."
          >
            <ConfirmationToggle
              patient={patient}
              checked={sendEmail}
              onChange={(v) => {
                setSendEmail(v);
                setSendEmailUserOverride(true);
              }}
            />
            {patient ? (
              patient.email ? (
                <InlineHint>Goes to {patient.email}.</InlineHint>
              ) : (
                <InlineHint>
                  {patientFullName(patient)} has no email on file. Add one on the patient profile to enable confirmations.
                </InlineHint>
              )
            ) : (
              <InlineHint>Pick a patient first to see the email status.</InlineHint>
            )}
          </Section>
        </div>
      </BottomSheet>
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          onDismiss={() => setToast(null)}
        />
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function PickedPatient({
  patient,
  onClear,
}: {
  patient: PatientRow;
  onClear: () => void;
}) {
  const name = patientFullName(patient);
  const sub = patient.email ?? patient.phone ?? patient.internal_ref;
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
          borderRadius: '50%',
          background: theme.color.surface,
          color: theme.color.inkMuted,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <User size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </p>
        <p
          style={{
            margin: `2px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub}
        </p>
      </div>
      <Button variant="tertiary" size="sm" onClick={onClear}>
        Change
      </Button>
    </div>
  );
}

function ConfirmationToggle({
  patient,
  checked,
  onChange,
}: {
  patient: PatientRow | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hasEmail = !!patient?.email;
  return (
    <Checkbox
      checked={hasEmail && checked}
      onChange={onChange}
      disabled={!hasEmail}
      label={
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
          Send confirmation email
        </span>
      }
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (local copies of the small ISO splitters used by RescheduleSheet —
// duplicated rather than extracted because the two sheets evolve independently
// and the helpers are 5 lines each)
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


// Working hours come back as 'HH:MM' strings; bound them to whole
// hours for the TimePicker's startHour / endHour scrollable range.
// `endRoundUp` rounds 18:30 → 19 so the last in-hours slot is
// reachable.
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

function clampHour(hhmm: string, endRoundUp = false): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return endRoundUp ? 22 : 6;
  if (endRoundUp && m > 0) return Math.min(23, h + 1);
  return h;
}
