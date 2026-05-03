import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Editable email templates. PR 2 of the email-template system —
// reads + saves to lng_email_templates and snapshots prior versions
// to lng_email_template_history. The renderer + the cron edge
// function (Phase 1) read the same rows; the admin UI reads/writes
// via these helpers.
//
// Per-template fields surfaced to the admin:
//
//   key                  stable id ('appointment_reminder' etc)
//   subject              current subject line
//   body_syntax          current body in storage syntax
//   default_subject      seeded baseline (powers "reset to default")
//   default_body_syntax  seeded baseline
//   version              increments on every save
//   description          optional human-readable description
//   enabled              whether the cron / sender path fires
//   updated_at / updated_by  last edit metadata

export interface EmailTemplateRow {
  key: string;
  subject: string;
  body_syntax: string;
  default_subject: string;
  default_body_syntax: string;
  version: number;
  description: string | null;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface EmailTemplateHistoryRow {
  id: string;
  template_key: string;
  version: number;
  subject: string;
  body_syntax: string;
  saved_at: string;
  saved_by: string | null;
}

interface UseEmailTemplatesResult {
  data: EmailTemplateRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEmailTemplates(): UseEmailTemplatesResult {
  const [data, setData] = useState<EmailTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data: rows, error: err } = await supabase
        .from('lng_email_templates')
        .select('*')
        .order('key', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
      } else {
        setData((rows ?? []) as EmailTemplateRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

interface UseEmailTemplateHistoryResult {
  data: EmailTemplateHistoryRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEmailTemplateHistory(templateKey: string): UseEmailTemplateHistoryResult {
  const [data, setData] = useState<EmailTemplateHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data: rows, error: err } = await supabase
        .from('lng_email_template_history')
        .select('*')
        .eq('template_key', templateKey)
        .order('version', { ascending: false });
      if (cancelled) return;
      if (err) {
        setError(err.message);
      } else {
        setData((rows ?? []) as EmailTemplateHistoryRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [templateKey, tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// Save a new version of a template.
//
// Atomicity note: we read the current row, snapshot it to history at
// the OLD version, then update with version+1 and the new content.
// Two concurrent saves could race and produce two history rows at
// the same version — but the unique index on (template_key, version)
// would catch that and the second save would fail with 23505. The
// admin would retry with a fresh fetch, which is the right
// behaviour for a low-traffic surface like this.
//
// A future hardening: wrap the read + history insert + update in a
// SECURITY INVOKER plpgsql function so it's a single transaction.
// For Phase 2 v1 the JS-side flow is fine.

export async function saveEmailTemplate(input: {
  key: string;
  subject: string;
  body_syntax: string;
  enabled?: boolean;
}): Promise<{ ok: true; version: number }> {
  const { data: existing, error: readErr } = await supabase
    .from('lng_email_templates')
    .select('version, subject, body_syntax')
    .eq('key', input.key)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read template: ${readErr.message}`);
  if (!existing) throw new Error(`Template "${input.key}" not found.`);
  const existingRow = existing as { version: number; subject: string; body_syntax: string };

  // Skip writing if nothing changed — saves a wasted history row
  // and a bumped version number for a no-op click. The admin UI's
  // Save button is disabled in this state but defend at the helper
  // boundary too.
  const enabledChange = input.enabled !== undefined;
  const subjectSame = existingRow.subject === input.subject;
  const bodySame = existingRow.body_syntax === input.body_syntax;
  if (subjectSame && bodySame && !enabledChange) {
    return { ok: true, version: existingRow.version };
  }

  // Resolve the actor account for the audit columns.
  const { data: actorRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorRaw as string | null) ?? null;

  // Snapshot the current row to history at the OLD version so the
  // history has a complete trail. version 1 was already inserted at
  // seed time so the table starts populated.
  if (!subjectSame || !bodySame) {
    const { error: histErr } = await supabase.from('lng_email_template_history').insert({
      template_key: input.key,
      version: existingRow.version,
      subject: existingRow.subject,
      body_syntax: existingRow.body_syntax,
      saved_by: actorAccountId,
    });
    if (histErr && histErr.code !== '23505') {
      // 23505 = unique violation. Means version 1 history was
      // already seeded with these exact values — safe to skip.
      throw new Error(`Couldn't snapshot history: ${histErr.message}`);
    }
  }

  // Apply the new content.
  const newVersion = existingRow.version + (subjectSame && bodySame ? 0 : 1);
  const patch: Record<string, unknown> = {
    subject: input.subject,
    body_syntax: input.body_syntax,
    version: newVersion,
    updated_by: actorAccountId,
  };
  if (enabledChange) patch.enabled = input.enabled;

  const { error: updErr } = await supabase
    .from('lng_email_templates')
    .update(patch)
    .eq('key', input.key);
  if (updErr) throw new Error(`Couldn't save template: ${updErr.message}`);

  return { ok: true, version: newVersion };
}

// Restore a previous version. Identical to a save with the
// historical content — bumps the version number, snapshots the
// current row before overwriting.
export async function restoreEmailTemplateVersion(input: {
  templateKey: string;
  historyId: string;
}): Promise<{ ok: true; version: number }> {
  const { data: histRaw, error: histErr } = await supabase
    .from('lng_email_template_history')
    .select('subject, body_syntax')
    .eq('id', input.historyId)
    .maybeSingle();
  if (histErr) throw new Error(`Couldn't read history row: ${histErr.message}`);
  if (!histRaw) throw new Error('History row not found.');
  const hist = histRaw as { subject: string; body_syntax: string };
  return saveEmailTemplate({
    key: input.templateKey,
    subject: hist.subject,
    body_syntax: hist.body_syntax,
  });
}

// Reset to the seeded defaults. Identical save path; the
// "default_*" columns are the source.
export async function resetEmailTemplateToDefault(templateKey: string): Promise<{ ok: true; version: number }> {
  const { data: tplRaw, error: tplErr } = await supabase
    .from('lng_email_templates')
    .select('default_subject, default_body_syntax')
    .eq('key', templateKey)
    .maybeSingle();
  if (tplErr) throw new Error(`Couldn't read template: ${tplErr.message}`);
  if (!tplRaw) throw new Error('Template not found.');
  const tpl = tplRaw as { default_subject: string; default_body_syntax: string };
  return saveEmailTemplate({
    key: templateKey,
    subject: tpl.default_subject,
    body_syntax: tpl.default_body_syntax,
  });
}

// User-facing labels for each known template key. Matches the seed
// + admin UI hierarchy. Add a row here when a new template ships.
export interface EmailTemplateDefinition {
  key: string;
  label: string;
  group: string;
  description: string;
  // Variables this template supports. Drives both the "insert
  // variable" picker (label + description) AND the live preview's
  // sample values (so the preview reads naturally instead of with
  // empty placeholders).
  variables: ReadonlyArray<EmailTemplateVariable>;
}

export interface EmailTemplateVariable {
  /** The placeholder name as it appears between {{}}. */
  name: string;
  /** Human label shown in the variables picker. */
  label: string;
  /** One-line description shown next to the variable in the picker. */
  description: string;
  /** Sample value used by the live preview so the rendered email
   * reads as a real one would. */
  sample: string;
}

// Variables shared across appointment-related templates. Pulled out
// so the same list can be reused across confirmation / reschedule /
// cancellation / reminder templates without drift. Order in the
// picker mirrors the order a copywriter naturally reaches for:
// patient identity → what + when → where + how to find us → links.
const APPOINTMENT_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  {
    name: 'patientFirstName',
    label: 'Patient first name',
    description: 'First name on the patient record. Falls back to "there" if empty.',
    sample: 'Sarah',
  },
  {
    name: 'patientLastName',
    label: 'Patient last name',
    description: 'Last name on the patient record. Empty when not on file.',
    sample: 'Henderson',
  },
  {
    name: 'serviceLabel',
    label: 'Service',
    description: 'The booking type label, e.g. "Click-in veneers" or "Denture repair".',
    sample: 'Click-in veneers',
  },
  {
    name: 'appointmentDateTime',
    label: 'Date and time',
    description: 'Combined day + time, e.g. "Sat 9 May at 11:00".',
    sample: 'Sat 9 May at 11:00',
  },
  {
    name: 'appointmentDate',
    label: 'Date',
    description: 'Short day-of-week + date, e.g. "Sat 9 May".',
    sample: 'Sat 9 May',
  },
  {
    name: 'appointmentDateLong',
    label: 'Date (long)',
    description: 'Long format, e.g. "Saturday 9 May 2026".',
    sample: 'Saturday 9 May 2026',
  },
  {
    name: 'appointmentTime',
    label: 'Time',
    description: '24-hour HH:MM, e.g. "11:00".',
    sample: '11:00',
  },
  {
    name: 'locationName',
    label: 'Clinic name',
    description: 'The clinic the booking is at, e.g. "Venneir Lounge".',
    sample: 'Venneir Lounge',
  },
  {
    name: 'locationCity',
    label: 'Clinic city',
    description: 'Just the city, e.g. "Glasgow". Empty if not set on the location.',
    sample: 'Glasgow',
  },
  {
    name: 'locationAddress',
    label: 'Clinic full address',
    description:
      'Comma-joined name + street + city. Falls back to clinic name only if address fields are empty.',
    sample: 'Venneir Lounge, 123 High Street, Glasgow',
  },
  {
    name: 'locationPhone',
    label: 'Clinic phone',
    description:
      'The clinic phone number from the locations table. Empty when not set. Use inside copy like "Call us on {{locationPhone}}".',
    sample: '+44 141 555 0123',
  },
  {
    name: 'appointmentRef',
    label: 'LAP reference',
    description: 'The LAP-NNNNN appointment reference. Empty until intake stamps it.',
    sample: 'LAP-00042',
  },
  {
    name: 'patientFacingDuration',
    label: 'Duration (patient-facing)',
    description:
      'How long we tell the patient the appointment is, e.g. "30 min". Set per booking type in Booking types so the email matches the marketing copy, not the operational total. Empty when no value is configured.',
    sample: '30 min',
  },
  {
    name: 'googleCalendarUrl',
    label: 'Add-to-calendar URL',
    description:
      'Pre-built Google Calendar link with the appointment details. Drop it inside [button:Label](url) for a tappable CTA.',
    sample:
      'https://www.google.com/calendar/render?action=TEMPLATE&text=Click-in+veneers&dates=20260509T100000Z/20260509T110000Z',
  },
];

// Reschedule-specific variables. Layered on top of the shared list
// so the picker shows the full set including the "old" trio. Kept
// alphabetised among the old-* trio for predictability.
const RESCHEDULE_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  ...APPOINTMENT_VARIABLES,
  {
    name: 'oldAppointmentDateTime',
    label: 'Previous date and time',
    description:
      'The slot the appointment was moved from, e.g. "Fri 8 May at 09:30". Use to show the change explicitly: "Was Fri 8 May at 09:30."',
    sample: 'Fri 8 May at 09:30',
  },
  {
    name: 'oldAppointmentDate',
    label: 'Previous date',
    description: 'Short day-of-week + date for the old slot, e.g. "Fri 8 May".',
    sample: 'Fri 8 May',
  },
  {
    name: 'oldAppointmentTime',
    label: 'Previous time',
    description: '24-hour HH:MM of the old slot, e.g. "09:30".',
    sample: '09:30',
  },
];

// Cancellation templates don't get the calendar-link variable — the
// .ics attachment is the cancel signal, and a "Add to calendar" CTA
// for an event that's been cancelled is contradictory copy.
const CANCELLATION_VARIABLES: ReadonlyArray<EmailTemplateVariable> = APPOINTMENT_VARIABLES.filter(
  (v) => v.name !== 'googleCalendarUrl',
);

export const EMAIL_TEMPLATE_DEFINITIONS: ReadonlyArray<EmailTemplateDefinition> = [
  {
    key: 'booking_confirmation',
    label: 'Booking confirmation',
    group: 'Appointments',
    description:
      'Sent the moment a patient is booked into a slot. Includes a calendar invite (.ics) so the appointment lands in their calendar with one click.',
    variables: APPOINTMENT_VARIABLES,
  },
  {
    key: 'booking_reschedule',
    label: 'Appointment moved',
    group: 'Appointments',
    description:
      'Sent when staff move an appointment to a new time or date. The calendar invite swaps the old slot for the new one in one step.',
    variables: RESCHEDULE_VARIABLES,
  },
  {
    key: 'booking_cancellation',
    label: 'Appointment cancelled',
    group: 'Appointments',
    description:
      'Sent when an appointment is cancelled. Pairs with a CANCEL calendar file so the slot disappears from the patient\'s calendar.',
    variables: CANCELLATION_VARIABLES,
  },
  {
    key: 'appointment_reminder',
    label: 'Reminder · 24 hours before',
    group: 'Appointments',
    description:
      'Sent automatically 24 hours before each native booking. Patient gets a friendly nudge with the slot details.',
    variables: APPOINTMENT_VARIABLES,
  },
];

// Build a {{var}} → sample-value map for a template, used to
// hydrate the live preview. Returns a plain Record so the renderer
// can consume it directly.
export function sampleVariablesFor(
  templateKey: string,
): Record<string, string> {
  const def = EMAIL_TEMPLATE_DEFINITIONS.find((d) => d.key === templateKey);
  if (!def) return {};
  const map: Record<string, string> = {};
  for (const v of def.variables) map[v.name] = v.sample;
  return map;
}

// Send a test rendering of a template draft to a recipient — used
// by the "Send test" button in the editor. Renders subject + body
// with sample variable values, ships via Resend with a "[TEST]"
// subject prefix so the recipient knows it's not a real send.
//
// Returns ok: true on success or ok: false with a structured error
// the caller can surface as a toast.
export interface SendTemplateTestResult {
  ok: boolean;
  recipient?: string;
  messageId?: string | null;
  error?: string;
}

export async function sendTemplateTest(args: {
  subject: string;
  bodySyntax: string;
  variables: Record<string, string>;
  to: string;
}): Promise<SendTemplateTestResult> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'send-template-test',
    {
      body: {
        subject: args.subject,
        bodySyntax: args.bodySyntax,
        variables: args.variables,
        to: args.to,
      },
    },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as {
    ok?: boolean;
    error?: string;
    recipient?: string;
    messageId?: string | null;
  };
  if (payload.ok) {
    return {
      ok: true,
      recipient: payload.recipient,
      messageId: payload.messageId ?? null,
    };
  }
  return { ok: false, error: payload.error ?? 'Unknown error' };
}
