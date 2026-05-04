// send-appointment-reminders
//
// Cron-driven sweep that sends 24-hours-before reminder emails for
// native (manual / native-source) Lounge appointments. Idempotent
// against repeated firings: stamps reminder_sent_at on send, so the
// next hour's run skips anything already done.
//
// Auth: a shared CRON_SECRET, OR a service-role JWT in Authorization:
// Bearer. The pg_cron job passes the service-role key from the
// vault. Manual triggers (e.g. via curl during QA) can pass either.
// User-JWT auth is intentionally NOT supported — this function
// touches every clinic's bookings, no individual user has a
// legitimate reason to invoke it.
//
// Sweep: lng_appointments WHERE status='booked' AND reminder_sent_at
// IS NULL AND source != 'calendly' AND start_at BETWEEN now+23h AND
// now+25h. The ±1h window covers the hourly cron cadence with
// minute-level slack on either side; missing the window means the
// next hour's run picks it up because reminder_sent_at is still
// NULL.
//
// Per row: load the appointment_reminder template, hydrate variables
// from patient + location + appointment fields, render to HTML via
// the same parser as src/lib/emailRenderer.ts, send via Resend,
// stamp reminder_sent_at. patient_events row written for the
// timeline; lng_event_log row written for ops audit. Failures land
// in lng_system_failures.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? 'lounge@venneir.com';

// Optional shared secret. When set, callers must pass
// X-Cron-Secret: <value> OR Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>.
// Either is accepted so the cron job (which uses service-role) and
// any manual ops trigger can both work.
const CRON_SECRET = Deno.env.get('LNG_REMINDERS_CRON_SECRET') ?? '';

// Reminder window. Default 23-25h covers an hourly cron with
// generous slack. Configurable via env in case ops wants to tune
// without redeploying.
const REMINDER_WINDOW_START_HOURS = Number(
  Deno.env.get('LNG_REMINDERS_WINDOW_START_HOURS') ?? '23',
);
const REMINDER_WINDOW_END_HOURS = Number(
  Deno.env.get('LNG_REMINDERS_WINDOW_END_HOURS') ?? '25',
);

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-appointment-reminders crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Auth check — accept service-role bearer OR cron secret header.
  //
  // For the bearer path, we decode the JWT payload and verify the
  // role + project ref rather than doing a strict string equality
  // against SUPABASE_SERVICE_ROLE_KEY. The strict-equality version
  // turned out brittle: Supabase can hold multiple valid signatures
  // for the same role/project (key rotation, leading/trailing
  // whitespace mismatches between the env var and what's in Vault),
  // so two equivalent service-role JWTs would compare unequal.
  // Decoding the payload + verifying the claims is the robust
  // pattern. The Supabase gateway has already verified the
  // signature before our handler runs, so trust the payload.
  const auth = req.headers.get('authorization') ?? '';
  const secret = req.headers.get('x-cron-secret') ?? '';
  let bearerOk = false;
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    const payload = decodeJwtPayload(token);
    if (payload?.role === 'service_role' && (!payload.ref || isExpectedProjectRef(payload.ref))) {
      bearerOk = true;
    }
  }
  const secretOk = !!CRON_SECRET && secret === CRON_SECRET;
  if (!bearerOk && !secretOk) {
    return jsonResponse(401, { ok: false, error: 'Unauthorised' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Load template ──────────────────────────────────────────────
  const { data: tplRaw, error: tplErr } = await admin
    .from('lng_email_templates')
    .select('subject, body_syntax, enabled')
    .eq('key', 'appointment_reminder')
    .maybeSingle();
  if (tplErr) {
    return jsonResponse(200, { ok: false, error: `Template read failed: ${tplErr.message}` });
  }
  if (!tplRaw) {
    return jsonResponse(200, { ok: false, error: 'No appointment_reminder template configured' });
  }
  const template = tplRaw as { subject: string; body_syntax: string; enabled: boolean };
  if (!template.enabled) {
    return jsonResponse(200, { ok: true, sent: 0, skipped: 0, failed: 0, paused: true });
  }

  // ── Compute sweep window ───────────────────────────────────────
  const now = new Date();
  const windowStart = new Date(now.getTime() + REMINDER_WINDOW_START_HOURS * 3600 * 1000);
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_END_HOURS * 3600 * 1000);

  // ── Sweep ─────────────────────────────────────────────────────
  const { data: rowsRaw, error: sweepErr } = await admin
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, start_at, end_at, source, status, service_type, event_type_label, appointment_ref',
    )
    .eq('status', 'booked')
    .neq('source', 'calendly')
    .is('reminder_sent_at', null)
    .gte('start_at', windowStart.toISOString())
    .lt('start_at', windowEnd.toISOString());
  if (sweepErr) {
    return jsonResponse(200, { ok: false, error: `Sweep failed: ${sweepErr.message}` });
  }
  const rows = (rowsRaw ?? []) as AppointmentRow[];

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ appointmentId: string; reason: string }> = [];

  for (const apt of rows) {
    try {
      const result = await processOne(admin, template, apt);
      if (result.outcome === 'sent') sent += 1;
      else if (result.outcome === 'skipped') skipped += 1;
      else {
        failed += 1;
        errors.push({ appointmentId: apt.id, reason: result.reason });
      }
    } catch (e) {
      failed += 1;
      errors.push({
        appointmentId: apt.id,
        reason: e instanceof Error ? e.message : String(e),
      });
      await logFailure(admin, {
        message: `Unhandled exception in reminder send: ${e instanceof Error ? e.message : String(e)}`,
        context: { appointmentId: apt.id },
      });
    }
  }

  // Operational summary so the cron's response logs tell ops what
  // actually happened in plain English.
  await admin.from('lng_event_log').insert({
    source: 'send-appointment-reminders',
    event_type: 'sweep_complete',
    payload: {
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      eligible: rows.length,
      sent,
      skipped,
      failed,
      errors: errors.slice(0, 10), // cap so we don't bloat the log on a runaway
    },
  });

  return jsonResponse(200, {
    ok: true,
    eligible: rows.length,
    sent,
    skipped,
    failed,
  });
}

interface ProcessResult {
  outcome: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

async function processOne(
  admin: SupabaseClient,
  template: { subject: string; body_syntax: string },
  apt: AppointmentRow,
): Promise<ProcessResult> {
  // Hydrate patient + location.
  const [{ data: patientRaw }, { data: locationRaw }] = await Promise.all([
    admin
      .from('patients')
      .select('first_name, last_name, email')
      .eq('id', apt.patient_id)
      .maybeSingle(),
    admin
      .from('locations')
      .select('id, name, city, address')
      .eq('id', apt.location_id)
      .maybeSingle(),
  ]);
  const patient = patientRaw as PatientRow | null;
  const location = locationRaw as LocationRow | null;

  if (!patient?.email) {
    // No email — silently skip, but still stamp reminder_sent_at so
    // the sweep doesn't keep retrying. The patient-events row makes
    // the skip visible in the timeline if anyone checks.
    await admin
      .from('lng_appointments')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', apt.id);
    await admin.from('patient_events').insert({
      patient_id: apt.patient_id,
      event_type: 'appointment_reminder_skipped',
      payload: { appointment_id: apt.id, reason: 'no_email_on_patient' },
    });
    return { outcome: 'skipped', reason: 'no_email_on_patient' };
  }

  if (!RESEND_API_KEY) {
    return { outcome: 'failed', reason: 'RESEND_API_KEY not configured' };
  }

  // Best-effort resolve of the booking type so {{patientFacingDuration}}
  // hydrates from the parent config. Returns {min, max} — either or
  // both can be null and the renderer degrades to empty string.
  const patientFacingRange = await resolvePatientFacingRange(admin, apt.service_type);

  // Phase data + threshold drive {{patientFacingSchedule}}. Empty
  // phases degrade to the duration label.
  const [phases, segmentedThresholdMinutes, brandingAndContact] = await Promise.all([
    fetchAppointmentPhases(admin, apt.id),
    resolveSegmentedThresholdMinutes(admin),
    loadBrandingAndContact(admin),
  ]);

  // Build variables. Keep names matching what the admin UI exposes
  // so the editor's autocomplete + the renderer never disagree.
  const variables = buildVariables(
    apt,
    patient,
    location,
    patientFacingRange.min,
    patientFacingRange.max,
    phases,
    segmentedThresholdMinutes,
    brandingAndContact.contact,
  );

  // Render via the inline parser (same pipeline as src/lib/emailRenderer.ts).
  const subject = substituteVariables(template.subject, variables);
  const bodyAfterVars = substituteVariables(template.body_syntax, variables);
  const bodyHtml = parseFormatting(bodyAfterVars);
  const html = wrapInLoungeShell(bodyHtml, brandingAndContact.brand);
  const text = bodyToText(bodyAfterVars);

  // Send.
  const sendResult = await sendEmail({ to: patient.email, subject, html, text });
  if (!sendResult.ok) {
    await logFailure(admin, {
      message: `Resend send failed for reminder: ${sendResult.error}`,
      context: { appointmentId: apt.id, recipient: patient.email },
    });
    return { outcome: 'failed', reason: sendResult.error };
  }

  // Stamp + log.
  await admin
    .from('lng_appointments')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', apt.id);

  await admin.from('patient_events').insert({
    patient_id: apt.patient_id,
    event_type: 'appointment_reminder_sent',
    payload: {
      appointment_id: apt.id,
      recipient: patient.email,
      provider: 'resend',
      message_id: sendResult.messageId ?? null,
    },
  });

  return { outcome: 'sent' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable hydration
// ─────────────────────────────────────────────────────────────────────────────

function buildVariables(
  apt: AppointmentRow,
  patient: PatientRow,
  location: LocationRow | null,
  patientFacingMinMinutes: number | null,
  patientFacingMaxMinutes: number | null,
  phases: AppointmentPhase[],
  segmentedThresholdMinutes: number,
  contact: ContactSettings,
): Record<string, string> {
  const start = new Date(apt.start_at);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...opts }).format(start);
  // Format any ISO timestamp as HH:MM in London time. Used by the
  // appointment-time variable AND by buildPatientFacingSchedule for
  // each phase's start time.
  const formatHmm = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  const time = formatHmm(apt.start_at);
  const dayShort = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
  const dateTime = `${dayShort} at ${time}`;
  const dateLong = fmt({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return {
    patientFirstName: patient.first_name?.trim() || 'there',
    patientLastName: patient.last_name?.trim() || '',
    appointmentTime: time,
    appointmentDate: dayShort,
    appointmentDateLong: dateLong,
    appointmentDateTime: dateTime,
    serviceLabel: labelForService(apt),
    locationName: location?.name?.trim() || 'Venneir Lounge',
    locationCity: location?.city?.trim() || '',
    locationAddress: locationFreeform(location),
    publicEmail: contact.publicEmail,
    websiteUrl: contact.websiteUrl,
    bookingLink: contact.bookingUrl,
    mapUrl: contact.mapUrl,
    openingHoursToday: contact.openingHoursToday,
    openingHoursWeek: contact.openingHoursWeek,
    appointmentRef: apt.appointment_ref ?? '',
    patientFacingDuration: formatPatientFacingDurationForEmail(
      patientFacingMinMinutes,
      patientFacingMaxMinutes,
    ),
    patientFacingSchedule: buildPatientFacingSchedule(
      phases,
      segmentedThresholdMinutes,
      formatPatientFacingDurationForEmail(patientFacingMinMinutes, patientFacingMaxMinutes),
      formatHmm,
    ),
  };
}

// Mirrors the helper in send-appointment-confirmation. Renders fixed
// values ("30 min" / "1 hour 30 min") or ranges ("30 to 45 min" /
// "1 to 2 hours"). Empty when min is null so the variable degrades
// gracefully in templates that include it on services without a
// value set.
function formatPatientFacingDurationForEmail(
  min: number | null,
  max: number | null,
): string {
  if (!min || min <= 0) return '';
  if (!max || max <= min) return formatMinutesLong(min);
  return `${formatMinutesLong(min)} to ${formatMinutesLong(max)}`;
}

function formatMinutesLong(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hourWord = h === 1 ? 'hour' : 'hours';
  if (m === 0) return `${h} ${hourWord}`;
  return `${h} ${hourWord} ${m} min`;
}

// Mirrors the helper in send-appointment-confirmation. Best-effort —
// any error or empty result returns {min: null, max: null} and the
// variable hydrates to empty string.
// Mirrors the helper in send-appointment-confirmation.
interface AppointmentPhase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  start_at: string;
  end_at: string;
}

async function fetchAppointmentPhases(
  admin: SupabaseClient,
  appointmentId: string,
): Promise<AppointmentPhase[]> {
  const { data, error } = await admin
    .from('lng_appointment_phases')
    .select('phase_index, label, patient_required, start_at, end_at')
    .eq('appointment_id', appointmentId)
    .order('phase_index', { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data as AppointmentPhase[];
}

async function resolveSegmentedThresholdMinutes(
  admin: SupabaseClient,
): Promise<number> {
  const { data, error } = await admin
    .from('lng_settings')
    .select('value')
    .is('location_id', null)
    .eq('key', 'booking.patient_segmented_threshold_minutes')
    .maybeSingle();
  if (error || !data) return 60;
  const v = (data as { value: unknown }).value;
  if (typeof v === 'number' && v > 0) return v;
  return 60;
}

// Mirrors buildPatientFacingSchedule in send-appointment-confirmation.
// When the booking has a long passive phase, render a multi-segment
// schedule ("Imps at 09:00 (30 min). Please return at approximately
// 13:30 for Try In (10 min).") instead of a single duration line.
function buildPatientFacingSchedule(
  phases: AppointmentPhase[],
  thresholdMinutes: number,
  fallbackDuration: string,
  formatTime: (iso: string) => string,
): string {
  if (phases.length < 2) return fallbackDuration;

  const hasLongPassive = phases.some((p) => {
    if (p.patient_required) return false;
    const ms = new Date(p.end_at).getTime() - new Date(p.start_at).getTime();
    return ms >= thresholdMinutes * 60_000;
  });
  if (!hasLongPassive) return fallbackDuration;

  const activePhases = phases.filter((p) => p.patient_required);
  if (activePhases.length === 0) return fallbackDuration;

  const sentences = activePhases.map((p, i) => {
    const durMinutes = Math.max(
      Math.round((new Date(p.end_at).getTime() - new Date(p.start_at).getTime()) / 60_000),
      1,
    );
    const durLabel = formatMinutesLong(durMinutes);
    if (i === 0) {
      return `${p.label} at ${formatTime(p.start_at)} (${durLabel})`;
    }
    return `Please return at approximately ${formatTime(p.start_at)} for ${p.label} (${durLabel})`;
  });

  return `${sentences.join('. ')}.`;
}

async function resolvePatientFacingRange(
  admin: SupabaseClient,
  serviceType: string | null,
): Promise<{ min: number | null; max: number | null }> {
  if (!serviceType) return { min: null, max: null };
  const { data, error } = await admin.rpc('lng_booking_type_resolve', {
    p_service_type: serviceType,
  });
  if (error) return { min: null, max: null };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { min: null, max: null };
  const r = row as {
    patient_facing_min_minutes: number | null;
    patient_facing_max_minutes: number | null;
  };
  const min = typeof r.patient_facing_min_minutes === 'number' && r.patient_facing_min_minutes > 0
    ? r.patient_facing_min_minutes
    : null;
  const max = typeof r.patient_facing_max_minutes === 'number' && r.patient_facing_max_minutes > 0
    ? r.patient_facing_max_minutes
    : null;
  return { min, max };
}

function labelForService(apt: AppointmentRow): string {
  if (apt.event_type_label && apt.event_type_label.trim()) return apt.event_type_label.trim();
  switch (apt.service_type) {
    case 'denture_repair':
      return 'Denture repair';
    case 'click_in_veneers':
      return 'Click-in veneers';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'impression_appointment':
      return 'Impression appointment';
    default:
      return 'Appointment';
  }
}

function locationFreeform(location: LocationRow | null): string {
  if (!location) return 'Venneir Lounge';
  const pieces = [location.name, location.address, location.city].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return pieces.length ? pieces.join(', ') : 'Venneir Lounge';
}

// ─────────────────────────────────────────────────────────────────────────────
// Email parser — Deno copy of src/lib/emailRenderer.ts. Kept in sync
// by hand because Deno can't import from src/ directly. If you change
// one, change the other AND extend src/lib/emailRenderer.test.ts to
// cover the new behaviour.
// ─────────────────────────────────────────────────────────────────────────────

function substituteVariables(template: string, variables: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    return full;
  });
}

// Paragraph-based renderer — mirror of src/lib/emailRenderer.ts.
// Every block (paragraph, heading, hr, list, image) wraps with the
// same margin so each gap reads as one consistent paragraph break.
// Keep these functions byte-for-byte aligned with the browser copy
// or sent emails will drift from the in-app preview.

const _BLOCK_MB = '0 0 8px 0';
const _STYLE_PARA = `margin:${_BLOCK_MB}`;
const _STYLE_H2 = `font-size:20px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H3 = `font-size:16px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_HR = `border:none;border-top:1px solid #E5E2DC;margin:${_BLOCK_MB}`;
const _STYLE_IMG = `max-width:100%;border-radius:8px;margin:${_BLOCK_MB};display:block`;
const _STYLE_LIST = `margin:${_BLOCK_MB}`;
const _STYLE_LI = 'display:block;padding-left:16px;position:relative;margin:0';
const _STYLE_BUL = 'position:absolute;left:0;top:0;color:#0E1414';

function _applyInlines(text: string): string {
  let out = text;
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>');
  out = out.replace(
    /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
    (_: string, label: string, bg: string | undefined, tc: string | undefined, rad: string | undefined, mt: string | undefined, mb: string | undefined, url: string) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      const mtC = mt || '12';
      const mbC = mb || '12';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );
  out = out.replace(
    /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
    (_: string, label: string, bg: string | undefined, tc: string | undefined, rad: string | undefined, url: string) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:12px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>');
  return out;
}

function parseFormatting(syntax: string): string {
  if (!syntax) return '';
  const trimmed = syntax.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  let listItems: string[] = [];
  let emptyStreak = 0;
  const flushBuffer = () => {
    if (buffer.length === 0) return;
    blocks.push(`<p style="${_STYLE_PARA}">${_applyInlines(buffer.join('<br>'))}</p>`);
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems
      .map((item) => `<span style="${_STYLE_LI}"><span style="${_STYLE_BUL}">•</span>${_applyInlines(item)}</span>`)
      .join('');
    blocks.push(`<div style="${_STYLE_LIST}">${items}</div>`);
    listItems = [];
  };
  for (const line of lines) {
    if (line === '') {
      flushBuffer();
      flushList();
      emptyStreak++;
      continue;
    }
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) blocks.push(`<p style="${_STYLE_PARA}">&nbsp;</p>`);
    }
    emptyStreak = 0;
    if (/^---+$/.test(line.trim())) {
      flushBuffer();
      flushList();
      blocks.push(`<hr style="${_STYLE_HR}">`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2 && h2[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h2 style="${_STYLE_H2}">${_applyInlines(h2[1])}</h2>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3 && h3[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h3 style="${_STYLE_H3}">${_applyInlines(h3[1])}</h3>`);
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
    if (img && img[2] !== undefined) {
      flushBuffer();
      flushList();
      blocks.push(`<img src="${img[2]}" alt="${img[1] ?? ''}" style="${_STYLE_IMG}">`);
      continue;
    }
    const li = line.match(/^- (.+)$/);
    if (li && li[1]) {
      flushBuffer();
      listItems.push(li[1]);
      continue;
    }
    flushList();
    buffer.push(line);
  }
  flushBuffer();
  flushList();
  return blocks.join('');
}

function bodyToText(syntax: string): string {
  if (!syntax) return '';
  return syntax
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
    .replace(/!\[([^\]]*)\]\((.+?)\)/g, '[image: $1 — $2]')
    .replace(/\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding & contact loader — mirror of send-appointment-confirmation.
// Pulls lng_settings to drive the email shell's logo header + legal
// footer, plus the publicEmail / website / booking / opening-hours
// template variables. Best-effort; any DB hiccup degrades to empty
// values rather than blocking the send.
// ─────────────────────────────────────────────────────────────────────────────

interface BrandSettings {
  logoUrl: string;
  logoShow: boolean;
  logoMaxWidth: number;
  accentColor: string;
  companyNumber: string;
  vatNumber: string;
  registeredAddress: string;
}

interface ContactSettings {
  publicEmail: string;
  websiteUrl: string;
  bookingUrl: string;
  mapUrl: string;
  openingHoursToday: string;
  openingHoursWeek: string;
}

type OpeningDay = { closed: true } | { open: string; close: string };
const DAY_NAMES_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function loadBrandingAndContact(
  admin: SupabaseClient,
): Promise<{ brand: BrandSettings; contact: ContactSettings }> {
  const empty = {
    brand: {
      logoUrl: '',
      logoShow: false,
      logoMaxWidth: 120,
      accentColor: '#0E1414',
      companyNumber: '',
      vatNumber: '',
      registeredAddress: '',
    },
    contact: {
      publicEmail: '',
      websiteUrl: '',
      bookingUrl: '',
      mapUrl: '',
      openingHoursToday: '',
      openingHoursWeek: '',
    },
  };
  const { data: rows, error } = await admin
    .from('lng_settings')
    .select('key, value')
    .or('key.like.email.%,key.like.clinic.%,key.like.legal.%')
    .is('location_id', null);
  if (error || !rows) return empty;
  const map = new Map<string, unknown>();
  for (const r of rows as Array<{ key: string; value: unknown }>) map.set(r.key, r.value);

  const get = <T>(k: string, fallback: T): T => {
    const v = map.get(k);
    return v === undefined || v === null ? fallback : (v as T);
  };

  const brand: BrandSettings = {
    logoUrl: get<string>('email.brand_logo_url', ''),
    logoShow: get<boolean>('email.brand_logo_show', true),
    logoMaxWidth: get<number>('email.brand_logo_max_width', 120),
    accentColor: get<string>('email.brand_accent_color', '#0E1414'),
    companyNumber: get<string>('legal.company_number', ''),
    vatNumber: get<string>('legal.vat_number', ''),
    registeredAddress: get<string>('legal.registered_address', ''),
  };

  const opening = get<OpeningDay[]>('clinic.opening_hours', []);
  const formatDay = (d: OpeningDay | undefined) =>
    !d ? '' : 'closed' in d && d.closed ? 'closed' : `${('open' in d && d.open) || ''}–${('close' in d && d.close) || ''}`;
  const todayIdx = ((new Date().getDay() + 6) % 7);
  const openingHoursToday = formatDay(opening[todayIdx]);
  const openingHoursWeek = opening
    .map((d, i) => `${DAY_NAMES_LONG[i]}: ${formatDay(d)}`)
    .join('\n');

  const contact: ContactSettings = {
    publicEmail: get<string>('clinic.public_email', ''),
    websiteUrl: get<string>('clinic.website_url', ''),
    bookingUrl: get<string>('clinic.booking_url', ''),
    mapUrl: get<string>('clinic.map_url', ''),
    openingHoursToday,
    openingHoursWeek,
  };

  return { brand, contact };
}

function renderLogoHeader(brand: BrandSettings): string {
  if (!brand.logoShow || !brand.logoUrl) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth));
  return `<p style="margin:0 0 8px 0;text-align:center"><img src="${brand.logoUrl}" alt="" style="max-width:${maxWidth}px;height:auto;display:inline-block;border:0"></p>`;
}

function renderLegalFooter(brand: BrandSettings): string {
  const lines: string[] = ['Venneir Limited'];
  if (brand.companyNumber) lines.push(`Company no. ${brand.companyNumber}`);
  if (brand.vatNumber) lines.push(`VAT no. ${brand.vatNumber}`);
  if (brand.registeredAddress) lines.push(brand.registeredAddress);
  return `<p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">${lines.join(' · ')}</p>`;
}

function wrapInLoungeShell(bodyHtml: string, brand: BrandSettings): string {
  const logo = renderLogoHeader(brand);
  const footer = renderLegalFooter(brand);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${logo}${bodyHtml}
    </div>
    ${footer}
  </div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [args.to],
        reply_to: RESEND_REPLY_TO,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Resend network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(body)}` };
  return { ok: true, messageId: (body as { id?: string }).id };
}

async function logFailure(
  admin: SupabaseClient,
  args: { message: string; context: Record<string, unknown> },
): Promise<void> {
  try {
    await admin.from('lng_system_failures').insert({
      source: 'send-appointment-reminders',
      severity: 'error',
      message: args.message,
      context: args.context,
    });
  } catch {
    // intentionally swallowed — failure-logging failure shouldn't crash the response
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  source: 'calendly' | 'manual' | 'native';
  status: string;
  service_type: string | null;
  event_type_label: string | null;
  appointment_ref: string | null;
}

interface PatientRow {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface LocationRow {
  id: string;
  name: string | null;
  city: string | null;
  address: string | null;
}

// Decode a JWT's payload without verifying the signature (the
// Supabase gateway already verified it before our handler runs).
// Returns null on malformed input.
function decodeJwtPayload(token: string): { role?: string; ref?: string; iat?: number; exp?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// The project ref the function is deployed under. Supabase doesn't
// expose this as an explicit env var, but SUPABASE_URL is
// 'https://<ref>.supabase.co' so we can pull it from there.
function isExpectedProjectRef(ref: string): boolean {
  try {
    const u = new URL(SUPABASE_URL);
    const expected = u.hostname.split('.')[0];
    return ref === expected;
  } catch {
    return false;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
