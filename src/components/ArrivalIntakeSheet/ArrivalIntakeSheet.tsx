import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import {
  appointmentRequiresJbRef,
  checkJbAvailability,
  readIntakeSnapshot,
  submitArrivalIntake,
  type ArrivalIntakeSnapshot,
  type JbAvailabilityResult,
} from '../../lib/queries/arrivalIntake.ts';

// Pre-arrival intake gate. Opened by the receptionist when they tap
// "Mark as arrived" on an in-person appointment. Walks through the
// compliance fields the appointment cannot proceed without:
//
//   - missing patient identity (first/last/dob/sex/email/phone)
//   - postal address (kept on patient so we don't ask each visit)
//   - allergies & sensitivities
//   - emergency contact name + phone
//   - JB ref (when the event label suggests an impression goes to lab)
//
// The waiver is required-when-applicable but lives outside this sheet —
// the parent (Schedule) opens WaiverSheet between intake submit and
// markAppointmentArrived. Splitting the two keeps each sheet focused
// and lets the receptionist re-enter the waiver flow from the visit
// page if they bail out mid-signature.
//
// Virtual impression appointments do NOT use this sheet. They keep
// flowing through markVirtualMeetingJoined() — see Schedule.

const SEX_OPTIONS = ['Female', 'Male', 'Other', 'Prefer not to say'] as const;

export interface ArrivalIntakeSheetProps {
  open: boolean;
  onClose: () => void;
  // Booked-appointment id when intake is gating a Schedule arrival.
  // Omitted for walk-ins — the lng_walk_ins row doesn't exist yet at
  // intake time, so the parent (NewWalkIn) creates it after submit.
  appointmentId?: string;
  patientId: string;
  // Used by the JB gate. When the label suggests an impression / repair /
  // veneer / aligner, JB ref is required; otherwise it's hidden.
  // Walk-ins pass the chosen service type so the JB requirement still
  // fires for impression-style services.
  eventTypeLabel: string | null;
  // Called after submitArrivalIntake resolves. The parent then runs
  // any required waiver flow and finally markAppointmentArrived (or,
  // for walk-ins, createWalkInVisit with these refs baked in).
  onSubmitted: (result: { appointment_ref: string; jb_ref: string | null }) => void;
}

interface FormState {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  email: string;
  phone: string;
  address: string;
  allergies: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  jb_ref: string;
}

const EMPTY_FORM: FormState = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  sex: '',
  email: '',
  phone: '',
  address: '',
  allergies: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  jb_ref: '',
};

export function ArrivalIntakeSheet({
  open,
  onClose,
  appointmentId,
  patientId,
  eventTypeLabel,
  onSubmitted,
}: ArrivalIntakeSheetProps) {
  const [snapshot, setSnapshot] = useState<ArrivalIntakeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jbCheck, setJbCheck] = useState<JbAvailabilityResult | null>(null);
  const [jbChecking, setJbChecking] = useState(false);
  const [jbError, setJbError] = useState<string | null>(null);

  const jbRequired = useMemo(() => appointmentRequiresJbRef(eventTypeLabel), [eventTypeLabel]);

  // Re-load the patient snapshot every time the sheet opens. The
  // snapshot drives the on-file vs editable rendering, so we must read
  // fresh state — another tab might have edited the profile between
  // arrivals.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setJbCheck(null);
    setJbError(null);
    (async () => {
      try {
        const snap = await readIntakeSnapshot(patientId);
        if (cancelled) return;
        setSnapshot(snap);
        setForm({
          first_name: snap.first_name ?? '',
          last_name: snap.last_name ?? '',
          date_of_birth: snap.date_of_birth ?? '',
          sex: snap.sex ?? '',
          email: snap.email ?? '',
          phone: snap.phone ?? '',
          address: snap.address ?? '',
          allergies: snap.allergies ?? '',
          emergency_contact_name: snap.emergency_contact_name ?? '',
          emergency_contact_phone: snap.emergency_contact_phone ?? '',
          jb_ref: '',
        });
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Could not load patient details');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, patientId]);

  // Required-fields gating. A field is required when it's currently
  // blank on the patient record (we need to fill it) AND the form has
  // not been filled in yet. Allergies is the exception — there is no
  // sensible "blank" so we always require an explicit answer (the
  // receptionist can write "None known").
  const missing = useMemo(() => {
    if (!snapshot) return [] as string[];
    const list: string[] = [];
    const need = (label: string, current: string | null, value: string) => {
      if ((current === null || current === '') && value.trim() === '') list.push(label);
    };
    need('First name', snapshot.first_name, form.first_name);
    need('Last name', snapshot.last_name, form.last_name);
    need('Date of birth', snapshot.date_of_birth, form.date_of_birth);
    need('Sex', snapshot.sex, form.sex);
    need('Email', snapshot.email, form.email);
    need('Phone', snapshot.phone, form.phone);
    need('Address', snapshot.address, form.address);
    if (form.allergies.trim() === '' && (snapshot.allergies ?? '') === '') {
      list.push('Allergies & sensitivities');
    }
    need('Emergency contact name', snapshot.emergency_contact_name, form.emergency_contact_name);
    need('Emergency contact phone', snapshot.emergency_contact_phone, form.emergency_contact_phone);
    if (jbRequired) {
      if (form.jb_ref.trim() === '') list.push('JB ref');
      else if (!jbCheck || !jbCheck.available) list.push('JB ref availability');
    }
    return list;
  }, [snapshot, form, jbRequired, jbCheck]);

  const ready = !loading && !loadError && missing.length === 0;

  const update = (key: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'jb_ref') {
      // JB inputs invalidate any previous availability check.
      setJbCheck(null);
      setJbError(null);
    }
  };

  const runJbCheck = async () => {
    const raw = form.jb_ref.trim();
    if (!raw) {
      setJbError('Enter a JB number first');
      return;
    }
    setJbChecking(true);
    setJbError(null);
    try {
      const res = await checkJbAvailability(raw);
      setJbCheck(res);
    } catch (e) {
      setJbError(e instanceof Error ? e.message : 'Could not check JB');
    } finally {
      setJbChecking(false);
    }
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const jbRef = jbRequired ? form.jb_ref.trim() || null : null;
      const result = await submitArrivalIntake({
        appointmentId,
        patientId,
        patient: {
          first_name: form.first_name,
          last_name: form.last_name,
          date_of_birth: form.date_of_birth,
          sex: form.sex,
          email: form.email,
          phone: form.phone,
          address: form.address,
          allergies: form.allergies,
          emergency_contact_name: form.emergency_contact_name,
          emergency_contact_phone: form.emergency_contact_phone,
        },
        jbRef,
      });
      onSubmitted({ appointment_ref: result.appointment_ref, jb_ref: jbRef });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not save intake');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Arrival intake"
      description="Confirm the details we need before opening the appointment."
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: missing.length > 0 ? theme.color.alert : theme.color.inkMuted,
            }}
          >
            {loading
              ? 'Loading…'
              : missing.length === 0
                ? 'All required fields complete'
                : `${missing.length} required ${missing.length === 1 ? 'field' : 'fields'} remaining`}
          </span>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" showArrow disabled={!ready || busy} loading={busy} onClick={submit}>
              {busy ? 'Saving…' : 'Continue to arrival'}
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <p style={{ color: theme.color.inkMuted, padding: `${theme.space[4]}px 0` }}>Loading patient…</p>
      ) : loadError ? (
        <p style={{ color: theme.color.alert }}>{loadError}</p>
      ) : snapshot ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
          <Section title="Patient details">
            <FillField
              label="First name"
              current={snapshot.first_name}
              value={form.first_name}
              onChange={(v) => update('first_name', v)}
            />
            <FillField
              label="Last name"
              current={snapshot.last_name}
              value={form.last_name}
              onChange={(v) => update('last_name', v)}
            />
            <FillField
              label="Date of birth"
              current={snapshot.date_of_birth}
              value={form.date_of_birth}
              onChange={(v) => update('date_of_birth', v)}
              type="date"
            />
            <SexField
              current={snapshot.sex}
              value={form.sex}
              onChange={(v) => update('sex', v)}
            />
            <FillField
              label="Email"
              current={snapshot.email}
              value={form.email}
              onChange={(v) => update('email', v)}
              type="email"
            />
            <FillField
              label="Phone"
              current={snapshot.phone}
              value={form.phone}
              onChange={(v) => update('phone', v)}
              type="tel"
            />
            <FillField
              label="Address"
              helper="In case we need to send anything to the patient."
              current={snapshot.address}
              value={form.address}
              onChange={(v) => update('address', v)}
              multiline
            />
          </Section>

          <Section title="Medical & emergency">
            <FillField
              label="Allergies & sensitivities"
              helper="Write 'None known' if not applicable."
              current={snapshot.allergies}
              value={form.allergies}
              onChange={(v) => update('allergies', v)}
              multiline
              alwaysEditable
            />
            <FillField
              label="Emergency contact name"
              current={snapshot.emergency_contact_name}
              value={form.emergency_contact_name}
              onChange={(v) => update('emergency_contact_name', v)}
            />
            <FillField
              label="Emergency contact phone"
              current={snapshot.emergency_contact_phone}
              value={form.emergency_contact_phone}
              onChange={(v) => update('emergency_contact_phone', v)}
              type="tel"
            />
          </Section>

          {jbRequired ? (
            <Section title="Job box">
              <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                The JB number on the box where the patient's impression will sit. We check Checkpoint to make
                sure another patient isn't already in this box.
              </p>
              <div style={{ display: 'flex', gap: theme.space[3], alignItems: 'flex-end' }}>
                <Input
                  label="JB ref"
                  placeholder="e.g. 33"
                  value={form.jb_ref}
                  onChange={(e) => update('jb_ref', e.currentTarget.value)}
                  inputMode="numeric"
                  fullWidth
                />
                <Button
                  variant="secondary"
                  onClick={runJbCheck}
                  disabled={jbChecking || form.jb_ref.trim() === ''}
                  loading={jbChecking}
                >
                  {jbChecking ? 'Checking…' : 'Check'}
                </Button>
              </div>
              {jbError ? <Banner tone="alert">{jbError}</Banner> : null}
              {jbCheck ? (
                jbCheck.available ? (
                  <Banner tone="ok">
                    <CheckCircle2 size={16} /> {jbCheck.formatted} is free.
                  </Banner>
                ) : (
                  <Banner tone="alert">
                    <AlertTriangle size={16} />
                    {jbCheck.formatted} is taken
                    {jbCheck.conflict?.customer_name ? ` by ${jbCheck.conflict.customer_name}` : ''}
                    {jbCheck.conflict?.order_name ? ` (${jbCheck.conflict.order_name})` : ''}. Pick a different
                    box.
                  </Banner>
                )
              ) : null}
            </Section>
          ) : null}

          {submitError ? <Banner tone="alert">{submitError}</Banner> : null}
        </div>
      ) : null}
    </BottomSheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          letterSpacing: theme.type.tracking.tight,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

// One row in the intake form. If the patient already has a value for
// this column, render an "On file" pill so the receptionist can see
// what we've got. Otherwise render an input. `alwaysEditable` overrides
// the on-file shortcut for fields like allergies that the receptionist
// should re-confirm at every visit.
function FillField({
  label,
  current,
  value,
  onChange,
  helper,
  type = 'text',
  multiline = false,
  alwaysEditable = false,
}: {
  label: string;
  current: string | null;
  value: string;
  onChange: (v: string) => void;
  helper?: string;
  type?: string;
  multiline?: boolean;
  alwaysEditable?: boolean;
}) {
  const onFile = !alwaysEditable && current !== null && current !== '';
  if (onFile) {
    return <OnFileRow label={label} value={current} />;
  }
  if (multiline) {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <span style={labelStyle}>{label}</span>
        {helper ? <span style={helperStyle}>{helper}</span> : null}
        <textarea
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          rows={3}
          style={textareaStyle}
        />
      </label>
    );
  }
  return (
    <Input
      label={label}
      helper={helper}
      type={type}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

function SexField({
  current,
  value,
  onChange,
}: {
  current: string | null;
  value: string;
  onChange: (v: string) => void;
}) {
  if (current !== null && current !== '') {
    return <OnFileRow label="Sex" value={current} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <span style={labelStyle}>Sex</span>
      <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
        {SEX_OPTIONS.map((opt) => {
          const selected = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                padding: `${theme.space[2]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.pill,
                border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
                background: selected ? theme.color.ink : theme.color.surface,
                color: selected ? theme.color.surface : theme.color.ink,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                cursor: 'pointer',
              }}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OnFileRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {label} on file
      </span>
      <span style={{ fontSize: theme.type.size.base, color: theme.color.ink }}>{value}</span>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'ok' | 'alert';
  children: React.ReactNode;
}) {
  const palette =
    tone === 'ok'
      ? { fg: theme.color.accent, bg: theme.color.bg, border: theme.color.accent }
      : { fg: theme.color.alert, bg: theme.color.bg, border: theme.color.alert };
  return (
    <p
      role={tone === 'alert' ? 'alert' : undefined}
      style={{
        margin: 0,
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
        fontSize: theme.type.size.sm,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
      }}
    >
      {children}
    </p>
  );
}

const labelStyle: CSSProperties = {
  fontSize: theme.type.size.sm,
  fontWeight: theme.type.weight.medium,
  color: theme.color.ink,
};

const helperStyle: CSSProperties = {
  fontSize: theme.type.size.sm,
  color: theme.color.inkMuted,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 80,
  padding: `${theme.space[3]}px ${theme.space[4]}px`,
  borderRadius: theme.radius.input,
  border: 'none',
  boxShadow: `inset 0 0 0 1px ${theme.color.border}`,
  fontSize: theme.type.size.base,
  fontFamily: 'inherit',
  color: theme.color.ink,
  background: theme.color.surface,
  resize: 'vertical',
  outline: 'none',
};

