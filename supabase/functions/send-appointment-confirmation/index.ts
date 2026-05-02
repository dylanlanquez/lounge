// send-appointment-confirmation
//
// Emails an appointment confirmation (or update) to the patient with
// an .ics calendar invite attached, sender lounge@venneir.com.
//
// Auth: anon-key Bearer JWT. The caller is the Lounge app, signed in.
//
// Body:
//   {
//     appointmentId: uuid,                  // required — the new / current appointment row
//     oldAppointmentIdToCancel?: uuid,      // optional — when this is a reschedule, the
//                                              old row to send a METHOD:CANCEL .ics for so
//                                              the patient's calendar updates instead of
//                                              getting a duplicate event
//   }
//
// Response: { ok: true } on success. { ok: false, error, reason? } on
// failure. Reason codes the caller may surface to staff:
//
//   delivery_not_configured    RESEND_API_KEY unset (env / dashboard)
//   no_email_on_patient        patient row has no email column value
//   appointment_not_found      bad appointmentId
//
// Loud-failure rule: every catch-that-doesn't-rethrow writes to
// lng_system_failures. Successes write to patient_events
// ('appointment_confirmation_sent') and to lng_event_log
// (source='send-appointment-confirmation', event_type='delivered').
//
// Per brief §5.9 / §1 (loud failures). Wired from
// rescheduleAppointment (best-effort post-step) and the Schedule
// sheet "Resend confirmation" button.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
// Booking emails go from a separate sender than receipts so the
// patient sees a coherent thread per topic. Falls back to the
// lounge@ address per the working agreement; can be overridden via
// the RESEND_FROM_BOOKING env var if we ever want to test on a
// dev sender without redeploying.
const RESEND_FROM = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO_BOOKING') ?? 'lounge@venneir.com';

Deno.serve(async (req) => {
  // Top-level try/catch so any unhandled exception surfaces as a 200
  // with a specific error message instead of a generic non-2xx that
  // shows in the UI as "Edge Function returned a non-2xx status code".
  // The caller's confirmation toast renders the message verbatim.
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-appointment-confirmation crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });
  const callerAccountAuthId = who.user.id;

  let body: {
    appointmentId?: string;
    oldAppointmentIdToCancel?: string;
    intent?: 'confirmation' | 'cancellation';
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const appointmentId = body.appointmentId;
  const oldAppointmentIdToCancel = body.oldAppointmentIdToCancel ?? null;
  const intent: 'confirmation' | 'cancellation' = body.intent ?? 'confirmation';
  if (!appointmentId) {
    return jsonResponse(400, { ok: false, error: 'appointmentId required' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Hydrate new appointment ────────────────────────────────────
  const apt = await readAppointment(admin, appointmentId);
  if (!apt) {
    return jsonResponse(404, {
      ok: false,
      error: 'Appointment not found',
      reason: 'appointment_not_found',
    });
  }

  // ── Hydrate optional cancel target ─────────────────────────────
  const oldApt = oldAppointmentIdToCancel
    ? await readAppointment(admin, oldAppointmentIdToCancel)
    : null;

  // ── Patient + location lookups ─────────────────────────────────
  const { data: patientRow } = await admin
    .from('patients')
    .select('first_name, last_name, email')
    .eq('id', apt.patient_id)
    .maybeSingle();
  const patient = patientRow as PatientRow | null;
  if (!patient?.email) {
    // Not a system failure; the patient just has no email. Caller
    // surfaces "no email on file, can't send" inline.
    return jsonResponse(200, {
      ok: false,
      error: 'No email on file for this patient',
      reason: 'no_email_on_patient',
    });
  }

  // Meridian's locations table stores the street address as a single
  // `address` text column, not the address_line_1 / postcode split
  // we'd assumed in the first revision of this function. The original
  // select 4xx'd because of the unknown columns and surfaced to the
  // app as "Edge Function returned a non-2xx status code".
  const { data: locationRow } = await admin
    .from('locations')
    .select('id, name, city, address, phone')
    .eq('id', apt.location_id)
    .maybeSingle();
  const location = locationRow as LocationRow | null;

  // ── Resolve intent → kind ──────────────────────────────────────
  // Three modes:
  //   cancellation  — build CANCEL .ics for the given appointment,
  //                   send "your appointment has been cancelled"
  //                   email. No paired REQUEST.
  //   reschedule    — confirmation intent + oldApt set. REQUEST for
  //                   the new slot + CANCEL for the old, paired in
  //                   one email so calendars update cleanly.
  //   booking       — confirmation intent, no oldApt. REQUEST only.
  const kind: 'booking' | 'reschedule' | 'cancellation' =
    intent === 'cancellation'
      ? 'cancellation'
      : oldApt
      ? 'reschedule'
      : 'booking';

  // ── Build .ics attachment(s) ───────────────────────────────────
  let primaryIcs: string;
  let secondaryIcs: string | null = null;

  if (kind === 'cancellation') {
    // Bumping the sequence is what tells the patient's calendar to
    // actually remove the event — Apple Mail and Outlook ignore
    // CANCEL with a stale sequence.
    primaryIcs = buildIcs({
      method: 'CANCEL',
      uid: icsUid(apt.id),
      sequence: (await currentSequenceForUid(admin, apt.id)) + 1,
      summary: emailSubjectLine(apt, location),
      description: 'This appointment has been cancelled.',
      location: locationFreeform(location),
      startAt: apt.start_at,
      endAt: apt.end_at,
      organizerEmail: RESEND_REPLY_TO,
      organizerName: 'Venneir Lounge',
      attendeeEmail: patient.email,
      attendeeName: fullName(patient),
      url: apt.join_url ?? null,
      status: 'CANCELLED',
    });
  } else {
    const sequence = await currentSequenceForUid(admin, apt.id);
    primaryIcs = buildIcs({
      method: 'REQUEST',
      uid: icsUid(apt.id),
      sequence,
      summary: emailSubjectLine(apt, location),
      description: icsDescription(apt, location),
      location: locationFreeform(location),
      startAt: apt.start_at,
      endAt: apt.end_at,
      organizerEmail: RESEND_REPLY_TO,
      organizerName: 'Venneir Lounge',
      attendeeEmail: patient.email,
      attendeeName: fullName(patient),
      url: apt.join_url ?? null,
      status: 'CONFIRMED',
    });
    if (oldApt) {
      secondaryIcs = buildIcs({
        method: 'CANCEL',
        uid: icsUid(oldApt.id),
        sequence: (await currentSequenceForUid(admin, oldApt.id)) + 1,
        summary: emailSubjectLine(oldApt, location),
        description: 'This appointment has been moved. See the new invite.',
        location: locationFreeform(location),
        startAt: oldApt.start_at,
        endAt: oldApt.end_at,
        organizerEmail: RESEND_REPLY_TO,
        organizerName: 'Venneir Lounge',
        attendeeEmail: patient.email,
        attendeeName: fullName(patient),
        url: oldApt.join_url ?? null,
        status: 'CANCELLED',
      });
    }
  }

  // ── Render email ────────────────────────────────────────────────
  const subject =
    kind === 'cancellation'
      ? `Your appointment has been cancelled · ${formatHumanDateTime(apt.start_at)}`
      : kind === 'reschedule'
      ? `Your appointment has moved · ${formatHumanDateTime(apt.start_at)}`
      : `You're booked in · ${formatHumanDateTime(apt.start_at)}`;

  const html = renderHtml({ apt, oldApt, patient, location, kind });
  const text = renderText({ apt, oldApt, patient, location, kind });

  // ── Deliver via Resend ─────────────────────────────────────────
  if (!RESEND_API_KEY) {
    await logFailure(admin, {
      severity: 'warning',
      message: 'RESEND_API_KEY unset; appointment confirmation not sent',
      context: { appointmentId, patientEmail: patient.email },
      callerAccountAuthId,
    });
    return jsonResponse(200, {
      ok: false,
      error: 'Email delivery not configured',
      reason: 'delivery_not_configured',
    });
  }

  const attachments = [
    {
      filename: kind === 'cancellation' ? 'cancel.ics' : 'invite.ics',
      content: btoa(unicodeEscape(primaryIcs)),
    },
  ];
  if (secondaryIcs) {
    attachments.push({
      filename: 'cancel.ics',
      content: btoa(unicodeEscape(secondaryIcs)),
    });
  }

  const sendResult = await sendEmail({
    to: patient.email,
    subject,
    html,
    text,
    attachments,
  });

  if (!sendResult.ok) {
    await logFailure(admin, {
      severity: 'error',
      message: `Resend delivery failed: ${sendResult.error}`,
      context: {
        appointmentId,
        oldAppointmentIdToCancel,
        patientEmail: patient.email,
      },
      callerAccountAuthId,
    });
    return jsonResponse(200, { ok: false, error: sendResult.error });
  }

  // ── Persist success ────────────────────────────────────────────
  await admin.from('patient_events').insert({
    patient_id: apt.patient_id,
    event_type:
      kind === 'cancellation'
        ? 'appointment_cancellation_sent'
        : 'appointment_confirmation_sent',
    payload: {
      appointment_id: apt.id,
      old_appointment_id_cancelled: oldAppointmentIdToCancel,
      kind,
      recipient: patient.email,
      provider: 'resend',
      message_id: sendResult.messageId ?? null,
    },
  });

  await admin.from('lng_event_log').insert({
    source: 'send-appointment-confirmation',
    event_type: 'delivered',
    location_id: apt.location_id,
    payload: {
      appointment_id: apt.id,
      old_appointment_id_cancelled: oldAppointmentIdToCancel,
      kind,
      message_id: sendResult.messageId ?? null,
    },
  });

  return jsonResponse(200, {
    ok: true,
    kind,
    recipient: patient.email,
    provider: 'resend',
    messageId: sendResult.messageId ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  service_type: string | null;
  event_type_label: string | null;
  appointment_ref: string | null;
  join_url: string | null;
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
  phone: string | null;
}

async function readAppointment(
  admin: SupabaseClient,
  id: string,
): Promise<AppointmentRow | null> {
  const { data } = await admin
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, start_at, end_at, service_type, event_type_label, appointment_ref, join_url',
    )
    .eq('id', id)
    .maybeSingle();
  return (data as AppointmentRow | null) ?? null;
}

// Counts prior delivery events for a given appointment UID. Returned
// value becomes the SEQUENCE on the next REQUEST (or `+1` for a
// CANCEL of the old UID).
async function currentSequenceForUid(admin: SupabaseClient, appointmentId: string): Promise<number> {
  const { count } = await admin
    .from('lng_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'send-appointment-confirmation')
    .eq('event_type', 'delivered')
    .filter('payload->>appointment_id', 'eq', appointmentId);
  return count ?? 0;
}

async function logFailure(
  admin: SupabaseClient,
  args: {
    severity: 'warning' | 'error';
    message: string;
    context: Record<string, unknown>;
    callerAccountAuthId: string;
  },
): Promise<void> {
  // Best-effort. We don't want failure-logging itself to throw.
  try {
    // Translate the auth user id to the accounts.id (FK target). If
    // it can't be resolved, we just leave the user_id null — the
    // failure row is still useful.
    const { data: acc } = await admin
      .from('accounts')
      .select('id')
      .eq('auth_user_id', args.callerAccountAuthId)
      .maybeSingle();
    await admin.from('lng_system_failures').insert({
      source: 'send-appointment-confirmation',
      severity: args.severity,
      message: args.message,
      context: args.context,
      user_id: (acc as { id: string } | null)?.id ?? null,
    });
  } catch {
    // intentionally swallowed — failure of failure-logging shouldn't break the response
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// .ics builder
// ─────────────────────────────────────────────────────────────────────────────

function buildIcs(args: {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  sequence: number;
  summary: string;
  description: string;
  location: string;
  startAt: string; // ISO
  endAt: string; // ISO
  organizerEmail: string;
  organizerName: string;
  attendeeEmail: string;
  attendeeName: string;
  url: string | null;
  status: 'CONFIRMED' | 'CANCELLED';
}): string {
  const dtstamp = formatIcsDate(new Date().toISOString());
  const dtstart = formatIcsDate(args.startAt);
  const dtend = formatIcsDate(args.endAt);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Venneir//Lounge//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${args.method}`,
    'BEGIN:VEVENT',
    `UID:${args.uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SEQUENCE:${args.sequence}`,
    `SUMMARY:${escapeIcsText(args.summary)}`,
    `DESCRIPTION:${escapeIcsText(args.description)}`,
    `LOCATION:${escapeIcsText(args.location)}`,
    `STATUS:${args.status}`,
    'TRANSP:OPAQUE',
    `ORGANIZER;CN=${escapeIcsText(args.organizerName)}:mailto:${args.organizerEmail}`,
    `ATTENDEE;CN=${escapeIcsText(args.attendeeName)};RSVP=FALSE;PARTSTAT=ACCEPTED:mailto:${args.attendeeEmail}`,
  ];
  if (args.url) lines.push(`URL:${args.url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  // RFC 5545 line-folding: max 75 octets per line, continuation
  // lines start with a single space. Most clients are forgiving but
  // long DESCRIPTION values trip up Outlook if unfolded.
  return lines.map(foldIcsLine).join('\r\n');
}

function formatIcsDate(iso: string): string {
  // YYYYMMDDTHHmmssZ in UTC.
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  // First line: 75 chars; continuation lines: 74 chars (leading space).
  chunks.push(line.slice(i, i + 75));
  i += 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

function icsUid(appointmentId: string): string {
  return `${appointmentId}@lounge.venneir.com`;
}

// JS strings are UTF-16 but btoa wants Latin-1. Encode UTF-8 bytes as
// Latin-1 first so accented names + pound signs survive the round-trip.
function unicodeEscape(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => String.fromCharCode(b))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Email rendering
// ─────────────────────────────────────────────────────────────────────────────

interface RenderContext {
  apt: AppointmentRow;
  oldApt: AppointmentRow | null;
  patient: PatientRow;
  location: LocationRow | null;
  kind: 'booking' | 'reschedule' | 'cancellation';
}

function renderHtml({ apt, oldApt, patient, location, kind }: RenderContext): string {
  const greeting = patient.first_name
    ? `Hi ${escapeHtml(patient.first_name)},`
    : 'Hi,';
  const headline =
    kind === 'cancellation'
      ? 'Your appointment has been cancelled'
      : kind === 'reschedule'
      ? 'Your appointment has moved'
      : "You're booked in";
  const lead =
    kind === 'cancellation'
      ? `Your booking on <strong>${escapeHtml(formatHumanDateTime(apt.start_at))}</strong> has been cancelled. Your calendar will be updated automatically.`
      : kind === 'reschedule'
      ? `We've updated your booking to <strong>${escapeHtml(formatHumanDateTime(apt.start_at))}</strong>.`
      : `See you on <strong>${escapeHtml(formatHumanDateTime(apt.start_at))}</strong>.`;
  const oldRow = oldApt
    ? `
      <tr>
        <td style="padding:8px 0;color:#7B8285;font-size:14px;">Was</td>
        <td style="padding:8px 0;text-align:right;color:#7B8285;font-size:14px;text-decoration:line-through;">
          ${escapeHtml(formatHumanDateTime(oldApt.start_at))}
        </td>
      </tr>`
    : '';
  const serviceLabel = labelForService(apt);
  const gcalUrl = googleCalendarUrl(apt, location);
  const locationLine = location
    ? `${escapeHtml(location.name ?? 'Venneir Lounge')}${location.city ? `, ${escapeHtml(location.city)}` : ''}`
    : 'Venneir Lounge';
  const joinRow =
    kind !== 'cancellation' && apt.join_url
      ? `
      <tr>
        <td style="padding:8px 0;color:#5A6266;font-size:14px;">Join link</td>
        <td style="padding:8px 0;text-align:right;font-size:14px;">
          <a href="${escapeHtml(apt.join_url)}" style="color:#0E1414;">Open meeting</a>
        </td>
      </tr>`
      : '';
  const refRow = apt.appointment_ref
    ? `
      <tr>
        <td style="padding:8px 0;color:#7B8285;font-size:12px;">Reference</td>
        <td style="padding:8px 0;text-align:right;color:#7B8285;font-size:12px;font-variant-numeric:tabular-nums;">
          ${escapeHtml(apt.appointment_ref)}
        </td>
      </tr>`
    : '';

  // The Add-to-Google-Calendar CTA is only meaningful when there's
  // a future event to add. For cancellations we replace it with a
  // muted "if this was a mistake, get in touch" line.
  const ctaBlock =
    kind === 'cancellation'
      ? `<div style="margin:24px 0 0;text-align:center;">
           <p style="margin:0;color:#7B8285;font-size:13px;line-height:1.55;">
             If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule.
           </p>
         </div>`
      : `<div style="margin:24px 0 0;text-align:center;">
           <a href="${escapeHtml(gcalUrl)}"
              style="display:inline-block;padding:12px 20px;background:#0E1414;color:#FFFFFF;text-decoration:none;border-radius:999px;font-weight:600;font-size:14px;">
             Add to Google Calendar
           </a>
           <p style="margin:12px 0 0;color:#7B8285;font-size:12px;">
             Apple Mail and Outlook will pick up the attached .ics automatically.
           </p>
         </div>`;

  const replyLine =
    kind === 'cancellation'
      ? "Want to rebook? Just reply to this email and we'll sort it out."
      : "Need to change something? Just reply to this email and we'll sort it out.";

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,system-ui,sans-serif;color:#0E1414;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;letter-spacing:-0.01em;">${escapeHtml(headline)}</h1>
    <p style="margin:0 0 24px;color:#5A6266;line-height:1.5;">${greeting} ${lead}</p>
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:12px;padding:20px 24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;color:#5A6266;font-size:14px;">Service</td>
          <td style="padding:8px 0;text-align:right;font-size:14px;">${escapeHtml(serviceLabel)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#5A6266;font-size:14px;">${kind === 'cancellation' ? 'Was due' : 'When'}</td>
          <td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px;${kind === 'cancellation' ? 'text-decoration:line-through;color:#7B8285;' : ''}">${escapeHtml(formatHumanDateTime(apt.start_at))}</td>
        </tr>
        ${oldRow}
        <tr>
          <td style="padding:8px 0;color:#5A6266;font-size:14px;">Where</td>
          <td style="padding:8px 0;text-align:right;font-size:14px;">${locationLine}</td>
        </tr>
        ${joinRow}
        ${refRow}
      </table>
    </div>
    ${ctaBlock}
    <p style="margin:32px 0 0;color:#5A6266;font-size:14px;line-height:1.55;">
      ${replyLine}
    </p>
    <p style="margin:24px 0 0;color:#7B8285;font-size:12px;">Venneir Limited</p>
  </div>
</body></html>`;
}

function renderText({ apt, oldApt, patient, location, kind }: RenderContext): string {
  const greeting = patient.first_name ? `Hi ${patient.first_name},` : 'Hi,';
  const headline =
    kind === 'cancellation'
      ? 'Your appointment has been cancelled'
      : kind === 'reschedule'
      ? 'Your appointment has moved'
      : "You're booked in";
  const serviceLabel = labelForService(apt);
  const locationLine = location
    ? `${location.name ?? 'Venneir Lounge'}${location.city ? `, ${location.city}` : ''}`
    : 'Venneir Lounge';
  const lead =
    kind === 'cancellation'
      ? `Your booking on ${formatHumanDateTime(apt.start_at)} has been cancelled.`
      : kind === 'reschedule'
      ? `We've updated your booking to ${formatHumanDateTime(apt.start_at)}.`
      : `See you on ${formatHumanDateTime(apt.start_at)}.`;
  const lines = [
    headline,
    '',
    greeting,
    lead,
    '',
    `Service: ${serviceLabel}`,
    `${kind === 'cancellation' ? 'Was due' : 'When'}: ${formatHumanDateTime(apt.start_at)}`,
  ];
  if (oldApt) lines.push(`Was: ${formatHumanDateTime(oldApt.start_at)}`);
  lines.push(`Where: ${locationLine}`);
  if (kind !== 'cancellation' && apt.join_url) lines.push(`Join link: ${apt.join_url}`);
  if (apt.appointment_ref) lines.push(`Reference: ${apt.appointment_ref}`);
  lines.push('');
  if (kind === 'cancellation') {
    lines.push(
      "If this cancellation was a mistake, just reply to this email and we'll get you back on the schedule.",
    );
  } else {
    lines.push(`Add to Google Calendar: ${googleCalendarUrl(apt, location)}`);
  }
  lines.push('');
  lines.push(
    kind === 'cancellation'
      ? "Want to rebook? Just reply to this email and we'll sort it out."
      : "Need to change something? Just reply to this email and we'll sort it out.",
  );
  lines.push('');
  lines.push('Venneir Limited');
  return lines.join('\n');
}

function emailSubjectLine(apt: AppointmentRow, location: LocationRow | null): string {
  const service = labelForService(apt);
  return location?.city ? `${service} at Venneir Lounge ${location.city}` : `${service} at Venneir Lounge`;
}

function icsDescription(apt: AppointmentRow, location: LocationRow | null): string {
  const parts: string[] = [];
  parts.push(labelForService(apt));
  if (location?.name) parts.push(`Location: ${location.name}`);
  if (apt.appointment_ref) parts.push(`Reference: ${apt.appointment_ref}`);
  if (apt.join_url) parts.push(`Join link: ${apt.join_url}`);
  parts.push('Reply to lounge@venneir.com to make changes.');
  return parts.join('\n');
}

function locationFreeform(location: LocationRow | null): string {
  if (!location) return 'Venneir Lounge';
  const pieces = [location.name, location.address, location.city].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return pieces.length ? pieces.join(', ') : 'Venneir Lounge';
}

function googleCalendarUrl(apt: AppointmentRow, location: LocationRow | null): string {
  const start = formatIcsDate(apt.start_at);
  const end = formatIcsDate(apt.end_at);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: emailSubjectLine(apt, location),
    dates: `${start}/${end}`,
    details: icsDescription(apt, location),
    location: locationFreeform(location),
  });
  return `https://www.google.com/calendar/render?${params.toString()}`;
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

function fullName(p: PatientRow): string {
  const n = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return n || 'Patient';
}

function formatHumanDateTime(iso: string): string {
  // Sat 9 May at 11:00 (London time, 24-hour). Built explicitly so
  // we don't depend on the runtime's locale and so the format
  // matches the rest of the Lounge UI.
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // Intl returns "Sat, 9 May, 11:00" — re-stitch to "Sat 9 May at 11:00".
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} at ${get('hour')}:${get('minute')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend
// ─────────────────────────────────────────────────────────────────────────────

async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; content: string }>;
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
        attachments: args.attachments,
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
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
