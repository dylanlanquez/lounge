import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// SMS templates — sibling of emailTemplates.ts. Each row is the body
// for one (key, service_type) pair. service_type=null is the
// General default; non-null rows are per-booking-type overrides
// that fall back to the General row at send time if missing.
//
// Variable substitution is shared with the email side conceptually
// (same {{name}} tokens) but the resolver list below is the
// SMS-only vocabulary the edge function understands. Keep this
// list in sync with send-visit-ready-sms's `variables` map.

export interface SmsTemplateRow {
  id: string;
  key: string;
  service_type: string | null;
  /** Admin-editable name shown in the row title and in the
   *  receptionist's Send-an-SMS dropdown. Null falls back to the
   *  humanised key. Edited from the General pill; per-service rows
   *  inherit the General row's name (the picker uses it directly). */
  display_name: string | null;
  body: string;
  default_body: string;
  description: string | null;
  version: number;
  enabled: boolean;
  updated_at: string;
}

export interface SmsTemplateVariable {
  name: string;
  label: string;
  description: string;
  sample: string;
}

// Variables every SMS template can use. The edge function resolves
// each one at send time from the patient + appointment + location
// + lng_settings rows associated with the visit. Admin's "Insert
// variable" picker reads this list to render the chip row beneath
// the body textarea.
export const SMS_TEMPLATE_VARIABLES: ReadonlyArray<SmsTemplateVariable> = [
  {
    name: 'patientFirstName',
    label: "Patient's first name",
    description: 'Falls back to "there" when the patient row has no first name on file.',
    sample: 'Sarah',
  },
  {
    name: 'clinicName',
    label: 'Clinic name',
    description:
      'The clinic name set in Admin → Branding → Clinic info. Falls back to "the clinic" when blank.',
    sample: 'Venneir Lounge',
  },
  {
    name: 'clinicPhone',
    label: 'Clinic phone',
    description:
      'The phone number set in Admin → Branding → Clinic info. Falls back to the public phone in Settings, then to a blank string. Render in the body next to "call us" so the patient can ring back in one tap.',
    sample: '0141 530 1180',
  },
  {
    name: 'clinicAddress',
    label: 'Clinic address (full, one line)',
    description:
      'Street + city + postcode joined with commas, sourced from Admin > Branding > Clinic info. Empty when no address is on file.',
    sample: '123 High Street, Glasgow, ML1 5UH',
  },
  {
    name: 'clinicStreet',
    label: 'Clinic street address',
    description:
      'Just the street line from Admin > Branding > Clinic info (no city, no postcode). Empty when not set.',
    sample: '123 High Street',
  },
  {
    name: 'clinicCity',
    label: 'Clinic city',
    description:
      'The city from Admin > Branding > Clinic info. Empty when not set.',
    sample: 'Glasgow',
  },
  {
    name: 'clinicPostcode',
    label: 'Clinic postcode',
    description:
      'The postcode from Admin > Branding > Clinic info, rendered uppercase as stored. Empty when not set.',
    sample: 'ML1 5UH',
  },
  {
    name: 'websiteUrl',
    label: 'Website URL',
    description:
      'The website URL from Admin → Branding → Clinic info. Empty when not set.',
    sample: 'venneir.com',
  },
  {
    name: 'bookingLink',
    label: 'Booking link',
    description:
      'The booking URL from Admin → Branding → Clinic info. Use for "Book your next appointment" CTAs. Empty when not set.',
    sample: 'venneir.com/book',
  },
  {
    name: 'apptDate',
    label: 'Appointment date',
    description:
      'The booking date formatted like "Mon 25 May" for UK readers. Empty when the visit has no linked appointment.',
    sample: 'Mon 25 May',
  },
  {
    name: 'apptTime',
    label: 'Appointment time',
    description:
      'The booking start time formatted like "14:30" (UK 24h). Empty when the visit has no linked appointment.',
    sample: '14:30',
  },
  {
    name: 'staffFirstName',
    label: 'Clinician first name',
    description:
      'First name of the clinician assigned to the appointment. Falls back to "your clinician" when no clinician is set on the appointment row.',
    sample: 'Jamie',
  },
  {
    name: 'itemLabel',
    label: 'The appliance / item being collected',
    description:
      "Resolved from the appointment's service_type + product_key so a repair reads 'denture repair', a same-day retainer reads 'retainer', click-in veneers reads 'click-in veneers', etc. Falls back to 'appliance' for any service we haven't pinned.",
    sample: 'retainer',
  },
  {
    name: 'locationName',
    label: 'Location name (legacy alias of clinicName)',
    description:
      'Same value as {{clinicName}}, kept so older templates that already reference {{locationName}} keep rendering. Prefer {{clinicName}} in new copy.',
    sample: 'Venneir Lounge',
  },
  {
    name: 'appointmentRef',
    label: 'Appointment reference (LAP-xxxxx)',
    description:
      'The booking reference the patient already saw in their confirmation email. This is what they are most likely to quote when they walk in, so it is the recommended default for the "Reference" line. Falls back to a dash when the visit has no linked appointment.',
    sample: 'LAP-12345',
  },
  {
    name: 'lwoRef',
    label: 'Patient LWO reference',
    description:
      'Immutable internal lab reference written when the patient is first created. Same patient always carries the same lwoRef across every visit. Many older patient records do not have one on file (renders as a dash), so prefer {{appointmentRef}} for customer-facing copy.',
    sample: 'LWO-12345',
  },
  // Receipt-only variables. Resolved by send-receipt's SMS branch
  // from the closed cart + payment row. Other SMS templates won't
  // have access to these (the resolver leaves them as literal
  // `{{name}}` placeholders), so use them only in payment_receipt.
  {
    name: 'totalAmount',
    label: 'Total amount paid',
    description:
      'The formatted GBP total taken at the till, e.g. "£120.00". Receipt SMS only.',
    sample: '£120.00',
  },
  {
    name: 'paidBy',
    label: 'Payment method',
    description:
      'How the patient paid: "Card", "Cash", "Klarna", or "Clearpay". Receipt SMS only.',
    sample: 'Card',
  },
  {
    name: 'receiptRef',
    label: 'Receipt reference',
    description:
      'Short 8-character payment reference the patient can quote if they need to ask about the charge. Receipt SMS only.',
    sample: 'a1b2c3d4',
  },
  {
    name: 'paymentDate',
    label: 'Payment date',
    description:
      'Date the payment was taken, e.g. "5 May 2026". Receipt SMS only.',
    sample: '5 May 2026',
  },
];

interface ListResult {
  data: SmsTemplateRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSmsTemplates(): ListResult {
  const [data, setData] = useState<SmsTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      const { data: rows, error: err } = await supabase
        .from('lng_sms_templates')
        .select('id, key, service_type, display_name, body, default_body, description, version, enabled, updated_at')
        .order('key', { ascending: true })
        .order('service_type', { ascending: true, nullsFirst: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as SmsTemplateRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// Save an existing (key, service_type) row. Creates the row when an
// override doesn't exist yet so admins can write per-service copy
// without a separate "Add override" affordance, same UX as emails.
// display_name is a separate axis from body (only the body bumps
// version + writes a history row, since the name is metadata).
export async function saveSmsTemplate(input: {
  key: string;
  service_type: string | null;
  body: string;
  enabled?: boolean;
  /** Optional rename for the row. Pass an empty string to clear it
   *  back to the humanised default. */
  display_name?: string | null;
}): Promise<{ ok: true; version: number }> {
  // Look up the row by (key, service_type). nulls aren't "equal" to
  // each other via .eq, so .is() is used for the General lookup.
  const baseQuery = supabase
    .from('lng_sms_templates')
    .select('id, version, body, default_body, description')
    .eq('key', input.key);
  const { data: existing, error: readErr } = input.service_type
    ? await baseQuery.eq('service_type', input.service_type).maybeSingle()
    : await baseQuery.is('service_type', null).maybeSingle();
  if (readErr) throw new Error(`Couldn't read template: ${readErr.message}`);

  // No row for this (key, service_type) pair → create a fresh
  // override seeded from the General row's body so the admin's
  // editing on top of the right starting point. Without the seed
  // they'd see an empty textarea.
  if (!existing) {
    if (!input.service_type) {
      throw new Error(`General template "${input.key}" not found.`);
    }
    const { data: generalRow, error: genErr } = await supabase
      .from('lng_sms_templates')
      .select('default_body, description')
      .eq('key', input.key)
      .is('service_type', null)
      .maybeSingle();
    if (genErr) throw new Error(`Couldn't read General default: ${genErr.message}`);
    const general = generalRow as { default_body: string; description: string | null } | null;
    if (!general) throw new Error(`General template "${input.key}" not found.`);
    const { error: insErr } = await supabase.from('lng_sms_templates').insert({
      key: input.key,
      service_type: input.service_type,
      body: input.body,
      default_body: general.default_body,
      description: general.description,
      enabled: input.enabled ?? true,
      version: 1,
    });
    if (insErr) throw new Error(`Couldn't create override: ${insErr.message}`);
    return { ok: true, version: 1 };
  }

  const cur = existing as { id: string; version: number; body: string };

  if (cur.body !== input.body) {
    const { data: actorRaw } = await supabase.rpc('auth_account_id');
    const actor = (actorRaw as string | null) ?? null;
    const { error: histErr } = await supabase.from('lng_sms_template_history').insert({
      template_key: input.key,
      service_type: input.service_type,
      version: cur.version,
      body: cur.body,
      saved_by: actor,
    });
    if (histErr && histErr.code !== '23505') {
      throw new Error(`Couldn't snapshot history: ${histErr.message}`);
    }
  }

  const bodyChanged = cur.body !== input.body;
  const newVersion = bodyChanged ? cur.version + 1 : cur.version;
  const patch: Record<string, unknown> = {
    body: input.body,
    version: newVersion,
    updated_at: new Date().toISOString(),
  };
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.display_name !== undefined) {
    // Empty string clears the override so the picker falls back to
    // the humanised default. Trim so trailing whitespace doesn't
    // shadow the empty case.
    const trimmed = (input.display_name ?? '').trim();
    patch.display_name = trimmed.length === 0 ? null : trimmed;
  }

  const { error: updErr } = await supabase
    .from('lng_sms_templates')
    .update(patch)
    .eq('id', cur.id);
  if (updErr) throw new Error(`Couldn't save template: ${updErr.message}`);
  return { ok: true, version: newVersion };
}

// Reset an existing (key, service_type) override back to its
// default_body. For a service-typed row this restores the override's
// own seeded default. For General it restores the canonical seed
// from the migration. Deleting the override entirely (so it falls
// back to General) is a separate "Remove override" flow caller-side.
export async function resetSmsTemplateToDefault(input: {
  key: string;
  service_type: string | null;
}): Promise<void> {
  const baseQuery = supabase
    .from('lng_sms_templates')
    .select('default_body')
    .eq('key', input.key);
  const { data: row, error: readErr } = input.service_type
    ? await baseQuery.eq('service_type', input.service_type).maybeSingle()
    : await baseQuery.is('service_type', null).maybeSingle();
  if (readErr) throw new Error(`Couldn't read default: ${readErr.message}`);
  if (!row) throw new Error(`Template "${input.key}" not found for this service.`);
  const def = (row as { default_body: string }).default_body;
  await saveSmsTemplate({ key: input.key, service_type: input.service_type, body: def });
}

// Delete a per-service override row so the booking falls back to
// the General copy. Refuses to delete the General row itself —
// reset_to_default is the right action for General.
export async function removeSmsTemplateOverride(input: {
  key: string;
  service_type: string;
}): Promise<void> {
  const { error } = await supabase
    .from('lng_sms_templates')
    .delete()
    .eq('key', input.key)
    .eq('service_type', input.service_type);
  if (error) throw new Error(`Couldn't remove override: ${error.message}`);
}

/** Render the body with sample variable values for the in-app
 *  preview — keeps the admin-side preview faithful to what the
 *  edge function will substitute at send time. */
export function renderSmsPreview(body: string): string {
  const sample: Record<string, string> = Object.fromEntries(
    SMS_TEMPLATE_VARIABLES.map((v) => [v.name, v.sample]),
  );
  return body.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => sample[name] ?? `{{${name}}}`);
}

// Pretty SMS character / segment count so the editor can warn admins
// before they paste a 200-char message that'll get split into three
// segments. Twilio counts segments at 160 chars for GSM-7 and 70 for
// UCS-2 (the latter triggered by any non-GSM char). We approximate by
// detecting GSM-only via a regex; close enough for an editor warning.
const GSM_7BIT_RE =
  /^[ -¡¤§¿Ä-ÆÉÑÖØÜßàä-æè-éìñòöøùüΓΔΘΛΞΠΣΦΨΩ\n\r]*$/;

export function summariseSmsBody(rendered: string): {
  characters: number;
  segments: number;
  encoding: 'gsm-7' | 'ucs-2';
} {
  const characters = [...rendered].length;
  const isGsm = GSM_7BIT_RE.test(rendered);
  const limit = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;
  const segments = characters === 0
    ? 0
    : characters <= limit
      ? 1
      : Math.ceil(characters / multi);
  return { characters, segments, encoding: isGsm ? 'gsm-7' : 'ucs-2' };
}

// Friendly, sentence-case labels for each template_key. Used by the
// admin row header and by the send-side template picker so the
// receptionist sees readable names instead of snake_case keys.
// Admins can override this per template via display_name on the
// General row, see smsDisplayName().
export function humaniseSmsKey(key: string): string {
  const map: Record<string, string> = {
    visit_ready: 'Visit ready, your work is ready to collect',
    please_return: 'Please return to clinic',
    please_call: 'Please give us a call',
    running_late: 'Clinician running late',
    reminder_to_attend: 'Reminder to attend',
    payment_receipt: 'Payment receipt',
  };
  return map[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Returns the admin-set display_name on the row when non-blank,
 *  otherwise falls back to the humanised key. Accepts either a
 *  SmsTemplateRow or just a (key, display_name) pair so callers
 *  that already filtered to (key → general-row name) maps don't
 *  have to materialise the full row. */
export function smsDisplayName(
  row: { key: string; display_name?: string | null } | { key: string },
): string {
  const named = 'display_name' in row ? (row.display_name ?? '').trim() : '';
  return named.length > 0 ? named : humaniseSmsKey(row.key);
}
