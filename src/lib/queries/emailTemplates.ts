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
  /** null = General default row; non-null = per-service override
   *  (M17). Edge functions prefer the service-typed override when
   *  the appointment's service_type matches, fall back to the
   *  General when no override exists for that service. */
  service_type: string | null;
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
  service_type: string | null;
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

export function useEmailTemplateHistory(
  templateKey: string,
  serviceType: string | null = null,
): UseEmailTemplateHistoryResult {
  const [data, setData] = useState<EmailTemplateHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      let q = supabase
        .from('lng_email_template_history')
        .select('*')
        .eq('template_key', templateKey);
      // History is scoped per (template_key, service_type) so the
      // General default's version trail and a service-specific
      // override's version trail don't bleed into each other.
      q = serviceType ? q.eq('service_type', serviceType) : q.is('service_type', null);
      const { data: rows, error: err } = await q.order('version', { ascending: false });
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
  }, [templateKey, serviceType, tick]);

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
  /** null = General default; non-null = service-specific override.
   *  When non-null and no override row exists yet, the helper
   *  creates one by copying default_* columns from the General
   *  row so the new override has a sensible starting point and a
   *  valid "default to reset to". */
  service_type?: string | null;
  subject: string;
  body_syntax: string;
  enabled?: boolean;
}): Promise<{ ok: true; version: number }> {
  const serviceType = input.service_type ?? null;

  // Read the (key, service_type) row directly.
  let read = supabase
    .from('lng_email_templates')
    .select('version, subject, body_syntax, default_subject, default_body_syntax')
    .eq('key', input.key);
  read = serviceType ? read.eq('service_type', serviceType) : read.is('service_type', null);
  const { data: existing, error: readErr } = await read.maybeSingle();
  if (readErr) throw new Error(`Couldn't read template: ${readErr.message}`);

  // Resolve the actor account for the audit columns.
  const { data: actorRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorRaw as string | null) ?? null;

  // No row yet for this (key, service_type) — happens the first
  // time an admin customises a service-typed override. Seed it
  // from the General row so the override has its own default_*
  // baseline to reset back to.
  if (!existing) {
    if (!serviceType) {
      throw new Error(`Template "${input.key}" not found.`);
    }
    const { data: general, error: genErr } = await supabase
      .from('lng_email_templates')
      .select('default_subject, default_body_syntax')
      .eq('key', input.key)
      .is('service_type', null)
      .maybeSingle();
    if (genErr) throw new Error(`Couldn't read General template: ${genErr.message}`);
    if (!general) throw new Error(`No General row to seed override from for "${input.key}".`);
    const seedDefaults = general as { default_subject: string; default_body_syntax: string };
    const { error: insErr } = await supabase.from('lng_email_templates').insert({
      key: input.key,
      service_type: serviceType,
      subject: input.subject,
      body_syntax: input.body_syntax,
      default_subject: seedDefaults.default_subject,
      default_body_syntax: seedDefaults.default_body_syntax,
      version: 1,
      enabled: input.enabled ?? true,
      updated_by: actorAccountId,
    });
    if (insErr) throw new Error(`Couldn't create override: ${insErr.message}`);
    return { ok: true, version: 1 };
  }
  const existingRow = existing as {
    version: number;
    subject: string;
    body_syntax: string;
    default_subject: string;
    default_body_syntax: string;
  };

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

  // Snapshot the current row to history at the OLD version so the
  // history has a complete trail. version 1 was already inserted at
  // seed time so the table starts populated.
  if (!subjectSame || !bodySame) {
    const { error: histErr } = await supabase.from('lng_email_template_history').insert({
      template_key: input.key,
      service_type: serviceType,
      version: existingRow.version,
      subject: existingRow.subject,
      body_syntax: existingRow.body_syntax,
      saved_by: actorAccountId,
    });
    if (histErr && histErr.code !== '23505') {
      throw new Error(`Couldn't snapshot history: ${histErr.message}`);
    }
  }

  const newVersion = existingRow.version + (subjectSame && bodySame ? 0 : 1);
  const patch: Record<string, unknown> = {
    subject: input.subject,
    body_syntax: input.body_syntax,
    version: newVersion,
    updated_by: actorAccountId,
  };
  if (enabledChange) patch.enabled = input.enabled;

  let upd = supabase.from('lng_email_templates').update(patch).eq('key', input.key);
  upd = serviceType ? upd.eq('service_type', serviceType) : upd.is('service_type', null);
  const { error: updErr } = await upd;
  if (updErr) throw new Error(`Couldn't save template: ${updErr.message}`);

  return { ok: true, version: newVersion };
}

// Restore a previous version. Identical to a save with the
// historical content — bumps the version number, snapshots the
// current row before overwriting. Reads service_type off the
// history row so it persists back to the correct variant.
export async function restoreEmailTemplateVersion(input: {
  historyId: string;
}): Promise<{ ok: true; version: number }> {
  const { data: histRaw, error: histErr } = await supabase
    .from('lng_email_template_history')
    .select('template_key, service_type, subject, body_syntax')
    .eq('id', input.historyId)
    .maybeSingle();
  if (histErr) throw new Error(`Couldn't read history row: ${histErr.message}`);
  if (!histRaw) throw new Error('History row not found.');
  const hist = histRaw as {
    template_key: string;
    service_type: string | null;
    subject: string;
    body_syntax: string;
  };
  return saveEmailTemplate({
    key: hist.template_key,
    service_type: hist.service_type,
    subject: hist.subject,
    body_syntax: hist.body_syntax,
  });
}

// Reset semantics depend on service_type:
//   * General (service_type=null) — restores the row's content from
//     its own default_subject / default_body_syntax columns. Same
//     behaviour as before this migration.
//   * Service-typed override — DELETES the override row entirely so
//     the booking re-inherits the General default at send time. This
//     is the "remove customisation" affordance for per-service
//     templates; if the admin wants to keep the override active but
//     reset its content, they can use restoreEmailTemplateVersion()
//     against the first history row instead.
export async function resetEmailTemplateToDefault(input: {
  key: string;
  service_type?: string | null;
}): Promise<{ ok: true; version: number } | { ok: true; deleted: true }> {
  const serviceType = input.service_type ?? null;

  if (serviceType) {
    const { error: delErr } = await supabase
      .from('lng_email_templates')
      .delete()
      .eq('key', input.key)
      .eq('service_type', serviceType);
    if (delErr) throw new Error(`Couldn't remove override: ${delErr.message}`);
    return { ok: true, deleted: true };
  }

  const { data: tplRaw, error: tplErr } = await supabase
    .from('lng_email_templates')
    .select('default_subject, default_body_syntax')
    .eq('key', input.key)
    .is('service_type', null)
    .maybeSingle();
  if (tplErr) throw new Error(`Couldn't read template: ${tplErr.message}`);
  if (!tplRaw) throw new Error('Template not found.');
  const tpl = tplRaw as { default_subject: string; default_body_syntax: string };
  return saveEmailTemplate({
    key: input.key,
    service_type: null,
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
      'How long we tell the patient the appointment is. Renders as a fixed time ("30 min", "1 hour") or a range ("30 to 45 min", "4 to 6 hours") depending on how the booking type is set up in Booking types. Empty when no value is configured.',
    sample: '4 to 6 hours',
  },
  {
    name: 'patientFacingSchedule',
    label: 'Schedule (patient-facing)',
    description:
      'Smart schedule line. For bookings with a long passive phase (e.g. Click-in Veneers lab fabrication), renders one sentence per active phase with the start time and a "please return" prefix for follow-ups: "Book-in & Imps at 09:00 (30 min). Please return at approximately 13:30 for Try In (10 min)." For short or single-phase bookings, falls back to the patient-facing duration.',
    sample:
      'Book-in & Imps at 09:00 (30 min). Please return at approximately 13:30 for Try In (10 min).',
  },
  {
    name: 'googleCalendarUrl',
    label: 'Add to Google Calendar (web)',
    description:
      'Pre-built Google Calendar link for users who want to add the event to Google Calendar in their browser. The .ics file attached to confirmation and reschedule emails covers iOS Mail and Outlook natively — this variable is for staff who want an explicit Google-specific shortcut on top of that.',
    sample:
      'https://www.google.com/calendar/render?action=TEMPLATE&text=Click-in+veneers&dates=20260509T100000Z/20260509T110000Z',
  },
  {
    name: 'publicEmail',
    label: 'Public email',
    description:
      "The clinic's public-facing email address from Branding & clinic. Use for \"questions? email us\".",
    sample: 'hello@venneir.com',
  },
  {
    name: 'websiteUrl',
    label: 'Website URL',
    description: 'Clinic website from Branding & clinic. Empty when not set.',
    sample: 'https://venneir.com',
  },
  {
    name: 'bookingLink',
    label: 'Booking link',
    description:
      'Public booking URL from Branding & clinic. Drop into [button:Book again](url) for a re-booking CTA.',
    sample: 'https://venneir.com/book',
  },
  {
    name: 'mapUrl',
    label: 'Map URL',
    description:
      'Google Maps link to the clinic from Branding & clinic. Pair with the address: "[See on map]({{mapUrl}})".',
    sample: 'https://maps.google.com/?q=Venneir+Lounge',
  },
  {
    name: 'openingHoursToday',
    label: 'Opening hours, today',
    description:
      "Today's opening times in HH:mm–HH:mm format, or \"closed\". Pulled live from Branding & clinic.",
    sample: '09:00–18:00',
  },
  {
    name: 'openingHoursWeek',
    label: 'Opening hours, full week',
    description:
      'All seven days, one per line, e.g. "Monday: 09:00–18:00". Pulled live from Branding & clinic.',
    sample:
      'Monday: 09:00–18:00\nTuesday: 09:00–18:00\nWednesday: 09:00–18:00\nThursday: 09:00–18:00\nFriday: 09:00–18:00\nSaturday: 10:00–16:00\nSunday: closed',
  },
  {
    name: 'manageUrl',
    label: 'Manage appointment link',
    description:
      'Self-serve reschedule / cancel URL for the patient. Empty for older appointments that predate the manage_token column. Use inside [Reschedule or cancel]({{manageUrl}}).',
    sample: 'https://book.venneir.com/manage?token=abc123',
  },
  {
    name: 'bookingItemsBlock',
    label: 'What the patient booked',
    description:
      'Per-arch denture-repair lines + selected upgrades captured at booking, formatted as a bold-headed bullet list with prices. Renders as nothing when the booking has neither, so the variable can sit on its own line in the template without leaving an empty heading behind.',
    sample:
      '**Your upper denture**\n- Reline · £120.00\n- Broken tooth × 2 teeth · £80.00\n\n**Your lower denture**\n- Snapped denture · £150.00\n\n**Upgrades**\n- Scalloped · £45.00',
  },
  {
    name: 'sameDayServiceLabel',
    label: 'Same-day service (appliance / click-in veneers)',
    description:
      'Title-case service name for same-day bookings ONLY: "Same-day Upper & Lower Night Guards", "Same-day Upper Whitening Tray", "Same-day Whitening Kit" (no arch because the kit covers both by default), "Same-day Upper & Lower Click-in Veneers". Renders as empty for every other service type, so drop it on its own line and only same-day bookings show this label.',
    sample: 'Same-day Upper & Lower Missing Tooth Retainers',
  },
  {
    name: 'dentureRepairTable',
    label: 'Denture repair table',
    description:
      'On-theme HTML table grouped by arch ("Your Upper Denture" / "Your Lower Denture" / "Your Upper and Lower Dentures"), one row per repair line with the price right-aligned. Mirrors the customer-facing widget Review card. Renders empty for non-denture-repair bookings, so the variable can sit on its own line in the template without leaving an empty header behind.',
    // Sample is the actual HTML the edge function emits at send time
    // — keeps the live preview in admin a faithful representation of
    // what the patient receives. parseFormatting's raw-HTML rule
    // recognises the leading <div> and passes the block through
    // verbatim, so the admin sees a real rendered table on the
    // template-preview pane.
    sample:
      '<div><div style="margin:0 0 20px 0;"><h3 style="font-size:16px;font-weight:600;margin:0 0 4px 0;color:#0E1414;letter-spacing:-0.01em;">Your Lower Denture</h3><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;border-bottom:1px solid #E5E2DC;"><tr><td style="padding:12px 0;border-top:1px solid #E5E2DC;font-size:14px;color:#0E1414;">Snapped denture</td><td style="padding:12px 0;border-top:1px solid #E5E2DC;font-size:14px;color:#0E1414;text-align:right;font-variant-numeric:tabular-nums;">£60.00</td></tr><tr><td style="padding:12px 0;border-top:1px solid #E5E2DC;font-size:14px;color:#0E1414;">Cracked denture</td><td style="padding:12px 0;border-top:1px solid #E5E2DC;font-size:14px;color:#0E1414;text-align:right;font-variant-numeric:tabular-nums;">£70.00</td></tr></table></div></div>',
  },
  {
    name: 'inPersonImpressionLabel',
    label: 'In-person impression appointment label',
    description:
      'Title-case service phrase for in-person impression bookings ONLY: "In-person Impression Appointment for Upper & Lower Retainers", "In-person Impression Appointment for Upper Click-in Veneers". Renders empty for every other service type.',
    sample: 'In-person Impression Appointment for Upper & Lower Retainers',
  },
  {
    name: 'virtualImpressionLabel',
    label: 'Virtual impression appointment label',
    description:
      'Title-case service phrase for virtual impression bookings ONLY: "Virtual Impression Appointment for Upper & Lower Retainers", "Virtual Impression Appointment for Upper Click-in Veneers". Renders empty for every other service type.',
    sample: 'Virtual Impression Appointment for Upper & Lower Retainers',
  },
  {
    name: 'paymentStatusBlock',
    label: 'Payment status block',
    description:
      'On-theme HTML card that reflects what the patient paid at booking. Three states: "Paid in full · £249.00" with a green tint (paid_in_full_at_booking=true), "Deposit paid · £25.00" with the brand accent and a "remaining balance settled in clinic" sub-line (deposit_status=paid), or "Paying on the day" with a neutral tint (nothing captured at booking). Drop on its own line in the template; the surrounding block rhythm collapses cleanly when the block is empty (none of the three states ever blank — every booking lands on one of the three).',
    sample:
      '<div style="margin:0 0 16px 0;background:#E8F5EC;border:1px solid #B8DCC1;border-radius:12px;padding:14px 16px;"><p style="margin:0;font-size:15px;font-weight:600;color:#0E1414;">Paid in full · £249.00</p><p style="margin:4px 0 0;font-size:13px;color:#4A5159;line-height:1.5;">No balance to settle in clinic. Refunds handled per the clinic\'s cancellation policy.</p></div>',
  },
];

// Virtual-appointment-specific variables — layered on APPOINTMENT_VARIABLES
// with the join meeting URL added as the primary new variable.
const VIRTUAL_APPOINTMENT_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  ...APPOINTMENT_VARIABLES,
  {
    name: 'joinMeetingUrl',
    label: 'Join meeting URL',
    description:
      'Direct link to the video session for this virtual impression appointment. Paste inside [button:Join your appointment]({{joinMeetingUrl}}) for a tappable CTA.',
    sample: 'https://meet.example.com/session/abc123',
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

const VIRTUAL_RESCHEDULE_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  ...VIRTUAL_APPOINTMENT_VARIABLES,
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

// Cancellation templates don't get the Google Calendar link — the
// .ics attachment is the cancel signal, and surfacing an "add to
// calendar" affordance for an event that's been cancelled is
// contradictory copy.
const CANCELLATION_VARIABLES: ReadonlyArray<EmailTemplateVariable> = APPOINTMENT_VARIABLES.filter(
  (v) => v.name !== 'googleCalendarUrl',
);

const RECEIPT_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  {
    name: 'patientFirstName',
    label: 'Patient first name',
    description: 'The patient\'s first name. Falls back to "there" if empty.',
    sample: 'Sarah',
  },
  {
    name: 'totalAmount',
    label: 'Total amount',
    description: 'Formatted total charged, e.g. "£24.00".',
    sample: '£120.00',
  },
  {
    name: 'paidBy',
    label: 'Payment method',
    description: 'How the patient paid: Card, Cash, Klarna, or Clearpay.',
    sample: 'Card',
  },
  {
    name: 'itemsList',
    label: 'Items purchased',
    description: 'One item per line with quantity if more than one, e.g. "Upper Night Guard × 2".',
    sample: 'Upper Night Guard × 2\nLower Retainer',
  },
  {
    name: 'receiptRef',
    label: 'Receipt reference',
    description: 'Short 8-character payment reference.',
    sample: 'a1b2c3d4',
  },
  {
    name: 'paymentDate',
    label: 'Payment date',
    description: 'Date the payment was taken, e.g. "5 May 2026".',
    sample: '5 May 2026',
  },
];

const SHIPPING_VARIABLES: ReadonlyArray<EmailTemplateVariable> = [
  {
    name: 'patientFirstName',
    label: 'Patient first name',
    description: 'The patient\'s first name, e.g. "Sarah".',
    sample: 'Sarah',
  },
  {
    name: 'trackingNumber',
    label: 'DPD tracking number',
    description: 'The parcel tracking number returned by DPD.',
    sample: '15501234567890',
  },
  {
    name: 'trackingUrl',
    label: 'DPD tracking link',
    description: 'Full URL to the DPD parcel tracker for this shipment.',
    sample: 'https://track.dpdlocal.co.uk/parcels/15501234567890#results',
  },
  {
    name: 'shippingAddress',
    label: 'Delivery address',
    description: 'Single-line summary of the delivery address.',
    sample: '14 Elm Street, Edinburgh, EH1 2AB',
  },
  {
    name: 'itemsList',
    label: 'Items shipped',
    description: 'Newline-separated list of items being dispatched.',
    sample: 'Upper Night Guard\nLower Retainer',
  },
  {
    name: 'dispatchRef',
    label: 'Dispatch reference',
    description: 'The internal Lounge dispatch reference, e.g. LVO-A1B2C3D4.',
    sample: 'LVO-A1B2C3D4',
  },
];

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
  {
    key: 'booking_confirmation_virtual',
    label: 'Booking confirmation · Virtual impression',
    group: 'Virtual appointments',
    description:
      'Sent immediately when a patient books a virtual impression appointment. Join link is the primary CTA. No location address shown.',
    variables: VIRTUAL_APPOINTMENT_VARIABLES,
  },
  {
    key: 'booking_reschedule_virtual',
    label: 'Appointment moved · Virtual impression',
    group: 'Virtual appointments',
    description:
      'Sent when a virtual impression appointment is moved to a new time. Updated join link shown prominently.',
    variables: VIRTUAL_RESCHEDULE_VARIABLES,
  },
  {
    key: 'appointment_reminder_virtual',
    label: 'Reminder · 24 hours before · Virtual impression',
    group: 'Virtual appointments',
    description:
      'Sent automatically 24 hours before a virtual impression appointment. Join link is the primary CTA.',
    variables: VIRTUAL_APPOINTMENT_VARIABLES,
  },
  {
    key: 'visit_shipped',
    label: 'Order dispatched',
    group: 'Visits',
    description:
      'Sent to the patient when their completed work is dispatched via DPD. Includes the tracking number and delivery address.',
    variables: SHIPPING_VARIABLES,
  },
  {
    key: 'payment_receipt',
    label: 'Payment receipt',
    group: 'Payments',
    description:
      'Sent to the patient immediately after a payment is taken at the Lounge. Includes a line-item list, total, payment method, and reference.',
    variables: RECEIPT_VARIABLES,
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
