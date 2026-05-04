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
  ReturnSegmentHints,
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
  type AxisDef,
  type AxisKey,
  type AxisValueOption,
  type ArchValue,
  axesForService,
  axisValueLabel,
  loadAxisValues,
} from '../../lib/queries/bookingTypeAxes.ts';
import {
  type RescheduleConflict,
  RescheduleConflictError,
  checkBookingConflict,
} from '../../lib/queries/rescheduleAppointment.ts';
import { createAppointment } from '../../lib/queries/createAppointment.ts';
import { type PatientRow, patientFullName } from '../../lib/queries/patients.ts';
import { supabase } from '../../lib/supabase.ts';

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
  // Create-new-patient sub-flow inside the patient section. When
  // patientCreate is non-null the search box is replaced with a
  // form pre-seeded from the search term (matches NewWalkIn's
  // 'find' → 'create' step pattern, but kept inside this sheet so
  // staff don't lose their booking context). Cancelled or saved →
  // back to search / picked.
  const [patientCreate, setPatientCreate] = useState<NewPatientDraft | null>(null);
  const [creatingPatient, setCreatingPatient] = useState(false);
  const [createPatientError, setCreatePatientError] = useState<string | null>(null);
  const [serviceType, setServiceType] = useState<BookingServiceType | ''>('');
  // Axis pins for the picked service (e.g. denture variant, product key,
  // arch). Order is fixed per service via SERVICE_AXES; values are kept
  // in a single object so resetting on service change is one assignment.
  const [axisValues, setAxisValues] = useState<{
    repair_variant: string | null;
    product_key: string | null;
    arch: ArchValue | null;
  }>({ repair_variant: null, product_key: null, arch: null });
  // Loaded option lists per axis. Keyed by AxisKey so multi-axis
  // services (same_day_appliance, virtual_impression_appointment) can
  // share the cache without re-querying when a sibling axis changes.
  const [axisOptions, setAxisOptions] = useState<Partial<Record<AxisKey, AxisValueOption[]>>>({});
  const [axisOptionsLoading, setAxisOptionsLoading] = useState<boolean>(false);
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
    setPatientCreate(null);
    setCreatePatientError(null);
    setServiceType('');
    setAxisValues({ repair_variant: null, product_key: null, arch: null });
    setAxisOptions({});
    setAxisOptionsLoading(false);
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

  // ── Reset axis pins whenever the service changes ───────────────
  // The pins for "same_day_appliance" don't carry over to
  // "denture_repair", so any switch wipes the previously chosen
  // axes. Options for the new service load in the next effect.
  useEffect(() => {
    setAxisValues({ repair_variant: null, product_key: null, arch: null });
    setAxisOptions({});
  }, [serviceType]);

  // ── Load axis option lists for the picked service ──────────────
  useEffect(() => {
    if (!open || !serviceType) {
      setAxisOptionsLoading(false);
      return;
    }
    const axes = axesForService(serviceType);
    if (axes.length === 0) {
      setAxisOptionsLoading(false);
      return;
    }
    let cancelled = false;
    setAxisOptionsLoading(true);
    (async () => {
      const entries = await Promise.all(
        axes.map(async (a) => [a.key, await loadAxisValues(a)] as const),
      );
      if (cancelled) return;
      const next: Partial<Record<AxisKey, AxisValueOption[]>> = {};
      for (const [k, v] of entries) next[k] = v;
      setAxisOptions(next);
      setAxisOptionsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, serviceType]);

  // ── Effective axes for the current pick ────────────────────────
  // SERVICE_AXES declares what *could* apply for a service. We drop
  // the arch axis when the picked product's catalogue row has
  // arch_match='any' (e.g. whitening kit), so the receptionist isn't
  // asked an arch question that doesn't apply to that product.
  const effectiveAxes = useMemo<readonly AxisDef[]>(() => {
    if (!serviceType) return [];
    const axes = axesForService(serviceType);
    const productAxis = axes.find((a) => a.key === 'product_key');
    if (!productAxis || !axisValues.product_key) return axes;
    const productOptions = axisOptions.product_key ?? [];
    const picked = productOptions.find((o) => o.key === axisValues.product_key);
    if (picked?.archMatch === 'any') {
      return axes.filter((a) => a.key !== 'arch');
    }
    return axes;
  }, [serviceType, axisOptions.product_key, axisValues.product_key]);

  // Clear an arch pin that's no longer relevant (e.g. user picked
  // whitening_kit after picking aligner). Without this the row would
  // persist a stale arch that's hidden from the UI.
  useEffect(() => {
    const archIsEffective = effectiveAxes.some((a) => a.key === 'arch');
    if (!archIsEffective && axisValues.arch !== null) {
      setAxisValues((v) => ({ ...v, arch: null }));
    }
  }, [effectiveAxes, axisValues.arch]);

  const allAxesPinned = effectiveAxes.every((a) => {
    const v = axisValues[a.key];
    return v != null && v !== '';
  });

  // ── Resolve booking-type config when service / pins change ─────
  useEffect(() => {
    if (!open || !serviceType || !allAxesPinned) {
      setConfig(null);
      setConfigError(null);
      return;
    }
    let cancelled = false;
    setConfig(null);
    setConfigError(null);
    (async () => {
      try {
        const c = await resolveBookingTypeConfig({
          service_type: serviceType,
          repair_variant: axisValues.repair_variant,
          product_key: axisValues.product_key,
          arch: axisValues.arch,
        });
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
  }, [
    open,
    serviceType,
    allAxesPinned,
    axisValues.repair_variant,
    axisValues.product_key,
    axisValues.arch,
  ]);

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
          repairVariant: axisValues.repair_variant,
          productKey: axisValues.product_key,
          arch: axisValues.arch,
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
    locationId,
    serviceType,
    axisValues.repair_variant,
    axisValues.product_key,
    axisValues.arch,
  ]);

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
    allAxesPinned &&
    slotIsValid &&
    conflicts.length === 0 &&
    !checkingConflicts &&
    !saving &&
    !configError &&
    !conflictError;

  // Build the human-readable event_type_label that goes onto the row.
  // Receptionists see this on schedule cards, patients see it on
  // confirmation emails, and the catalogue picker on visit detail
  // re-infers from it. Including the axis labels (e.g. "Same-day
  // appliance · Whitening Tray · Upper") keeps every downstream
  // surface aligned with what the receptionist actually picked.
  const eventTypeLabel = useMemo(() => {
    if (!serviceType) return undefined;
    const base = BOOKING_SERVICE_TYPES.find((s) => s.value === serviceType)?.label ?? null;
    const axisLabels: string[] = [];
    for (const axis of effectiveAxes) {
      const value = axisValues[axis.key];
      if (!value) continue;
      const opts = axisOptions[axis.key] ?? [];
      const opt = opts.find((o) => o.key === value);
      axisLabels.push(opt?.label ?? axisValueLabel(axis, value));
    }
    return [base, ...axisLabels].filter(Boolean).join(' · ') || undefined;
  }, [serviceType, effectiveAxes, axisValues, axisOptions]);

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
        eventTypeLabel,
        repairVariant: axisValues.repair_variant,
        productKey: axisValues.product_key,
        arch: axisValues.arch,
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
            info="Search existing patients by phone, name, or email. Also includes Venneir.com customers who haven't been seen at this clinic yet. If there's no match, you can create the patient inline without leaving this sheet."
          >
            {patient ? (
              <PickedPatient patient={patient} onClear={() => setPatient(null)} />
            ) : patientCreate ? (
              <NewPatientForm
                draft={patientCreate}
                onChange={setPatientCreate}
                seedTerm={patientCreate.seedTerm}
                busy={creatingPatient}
                error={createPatientError}
                onCancel={() => {
                  setPatientCreate(null);
                  setCreatePatientError(null);
                }}
                onSave={async () => {
                  setCreatePatientError(null);
                  setCreatingPatient(true);
                  try {
                    const created = await createPatient({
                      locationId,
                      first_name: patientCreate.first_name,
                      last_name: patientCreate.last_name,
                      email: patientCreate.email,
                      phone: patientCreate.phone,
                    });
                    setPatient(created);
                    setPatientCreate(null);
                  } catch (e) {
                    setCreatePatientError(
                      e instanceof Error ? e.message : 'Could not create patient',
                    );
                  } finally {
                    setCreatingPatient(false);
                  }
                }}
              />
            ) : (
              <PatientSearch
                onPick={setPatient}
                onCreateNew={(term) => {
                  setPatientCreate(seedDraftFromTerm(term));
                }}
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

          {effectiveAxes.map((axis) => {
            const options = axisOptions[axis.key] ?? [];
            const value = axisValues[axis.key] ?? '';
            return (
              <Section
                key={axis.key}
                title={axis.label}
                required
                info={infoForAxis(axis.key)}
              >
                <DropdownSelect<string>
                  ariaLabel={axis.label}
                  value={value}
                  onChange={(v) => {
                    setAxisValues((prev) => ({
                      ...prev,
                      [axis.key]: axis.key === 'arch' ? (v as ArchValue) : v,
                    }));
                  }}
                  options={options.map((o) => ({ value: o.key, label: o.label }))}
                  placeholder={
                    axisOptionsLoading && options.length === 0
                      ? 'Loading…'
                      : placeholderForAxis(axis.key)
                  }
                  disabled={axisOptionsLoading && options.length === 0}
                />
              </Section>
            );
          })}

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

interface NewPatientDraft {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  // The original search term — kept around so we can show "Seeded
  // from your search for …" microcopy and so undo would be easy if
  // we ever wanted that.
  seedTerm: string;
}

// Inline create-new-patient form rendered inside the Patient
// Section when no match exists for the search. Same field set as
// NewWalkIn's create step (first / last / phone / email), seeded
// intelligently from the search term so the receptionist isn't
// re-typing what they already typed.
function NewPatientForm({
  draft,
  onChange,
  seedTerm,
  busy,
  error,
  onCancel,
  onSave,
}: {
  draft: NewPatientDraft;
  onChange: (next: NewPatientDraft) => void;
  seedTerm: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {seedTerm ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
          }}
        >
          Seeded from your search for &ldquo;{seedTerm}&rdquo;.
        </p>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="First name"
          required
          autoFocus={!draft.first_name}
          value={draft.first_name}
          onChange={(e) => onChange({ ...draft, first_name: e.target.value })}
          disabled={busy}
        />
        <Input
          label="Last name"
          required
          value={draft.last_name}
          onChange={(e) => onChange({ ...draft, last_name: e.target.value })}
          disabled={busy}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
        <Input
          label="Phone"
          type="tel"
          value={draft.phone}
          onChange={(e) => onChange({ ...draft, phone: e.target.value })}
          disabled={busy}
        />
        <Input
          label="Email"
          type="email"
          value={draft.email}
          onChange={(e) => onChange({ ...draft, email: e.target.value })}
          disabled={busy}
        />
      </div>
      {error ? (
        <StatusBanner tone="error" title="Couldn't create patient">
          {error}
        </StatusBanner>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.space[2] }}>
        <Button type="button" variant="tertiary" onClick={onCancel} disabled={busy}>
          Back to search
        </Button>
        <Button type="button" variant="primary" onClick={onSave} loading={busy} disabled={busy}>
          {busy ? 'Creating…' : 'Create patient'}
        </Button>
      </div>
    </div>
  );
}

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

// Per-axis copy. Kept inline rather than moved to the registry because
// the wording is specific to the new-booking flow's tone (other axis
// surfaces, like the admin override picker, use shorter labels).
function infoForAxis(key: AxisKey): string {
  if (key === 'repair_variant') {
    return 'Which type of repair the patient is in for. Drives slot length and resources.';
  }
  if (key === 'product_key') {
    return 'Which appliance the patient is in for. Drives slot length and which arch options apply.';
  }
  return 'Which arch the patient is having work on.';
}

function placeholderForAxis(key: AxisKey): string {
  if (key === 'repair_variant') return 'Choose a variant';
  if (key === 'product_key') return 'Choose a product';
  return 'Choose an arch';
}

function clampHour(hhmm: string, endRoundUp = false): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h)) return endRoundUp ? 22 : 6;
  if (endRoundUp && m > 0) return Math.min(23, h + 1);
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient creation (mirrors NewWalkIn's two-step pattern)
// ─────────────────────────────────────────────────────────────────────────────

// Classify a search term so the create form gets seeded into the
// right field. Anything with @ → email; phone-like digits → phone;
// otherwise treat as a name and split on whitespace.
function classifySearchTerm(term: string): 'email' | 'phone' | 'name' {
  const trimmed = term.trim();
  if (trimmed.includes('@')) return 'email';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15 && /^[\d\s+()\-]+$/.test(trimmed)) {
    return 'phone';
  }
  return 'name';
}

function seedDraftFromTerm(term: string): NewPatientDraft {
  const trimmed = term.trim();
  const draft: NewPatientDraft = {
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    seedTerm: term,
  };
  const kind = classifySearchTerm(trimmed);
  if (kind === 'email') {
    draft.email = trimmed;
  } else if (kind === 'phone') {
    draft.phone = trimmed;
  } else {
    const parts = trimmed.split(/\s+/);
    draft.first_name = parts[0] ?? '';
    draft.last_name = parts.slice(1).join(' ');
  }
  return draft;
}

function humanizePatientSaveError(err: { message?: string; code?: string } | null): string {
  const msg = err?.message ?? '';
  const code = err?.code;
  if (code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
    if (/email/i.test(msg)) {
      return 'A patient with this email is already on file at this location. Use the search to find them.';
    }
    if (/phone/i.test(msg)) {
      return 'A patient with this phone number is already on file at this location. Use the search to find them.';
    }
    return 'This person is already on file at this location. Use the search to find them.';
  }
  return msg || 'Could not create patient.';
}

async function createPatient(args: {
  locationId: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}): Promise<PatientRow> {
  if (!args.first_name.trim() || !args.last_name.trim()) {
    throw new Error('First name and last name are required.');
  }
  // patients.account_id is a legacy NOT NULL column — resolve from
  // the signed-in user. Same path NewWalkIn uses.
  const { data: accountId, error: accErr } = await supabase.rpc('auth_account_id');
  if (accErr || !accountId) {
    throw new Error(
      accErr?.message ??
        'Could not resolve your account. Make sure your accounts row is set up in Meridian.',
    );
  }
  const { data, error } = await supabase
    .from('patients')
    .insert({
      account_id: accountId,
      location_id: args.locationId,
      first_name: args.first_name.trim(),
      last_name: args.last_name.trim(),
      email: args.email.trim() || null,
      phone: args.phone.trim() || null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(humanizePatientSaveError(error));
  return data as PatientRow;
}
