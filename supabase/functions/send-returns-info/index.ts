// send-returns-info
//
// From the virtual appointment page, send the patient their prepaid DPD
// return label + the SENDING staff member's authorisation code, by email
// and/or SMS. Copy is the admin-editable 'returns' template (Admin →
// Emails / SMS). The DPD link is {{returnsLink}} from lng_settings.
//
// Auth: signed-in staff JWT (the sender). Their lng_staff_members
// authorisation_code is inserted as {{authorisationCode}}.
//
// Body: { appointment_id: string, email?: boolean, sms?: boolean }
// Returns: { ok, email?: ChannelResult, sms?: ChannelResult }
//   ChannelResult = { status: 'sent' | 'skipped' | 'failed', reason?, error? }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { normalisePhone, sendSms } from '../_shared/twilioSms.ts';
import { recordSmsMessage } from '../_shared/smsRecord.ts';
import { recordEmailMessage } from '../_shared/emailRecord.ts';
import { getEmailSenderHeaders } from '../_shared/emailSender.ts';
import { properCase } from '../_shared/properCase.ts';
import {
  loadBrand,
  renderAndSend,
  substituteVariables,
  type TemplateRow,
} from '../_shared/emailRenderer.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

const RETURNS_LINK_DEFAULT = 'https://our-returns.dpd.co.uk/VENNEIR';
const VIRTUAL = 'virtual_impression_appointment';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

type ChannelResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `send-returns-info crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // ── Auth: signed-in staff (the sender) ──
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return jsonResponse(200, { ok: false, error: 'Not signed in.' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(200, { ok: false, error: 'Not signed in.' });

  let body: { appointment_id?: string; email?: boolean; sms?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body.appointment_id) return jsonResponse(200, { ok: false, error: 'appointment_id required' });
  const wantEmail = body.email !== false; // default both on
  const wantSms = body.sms !== false;
  if (!wantEmail && !wantSms) {
    return jsonResponse(200, { ok: false, error: 'Pick at least one of email or SMS.' });
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Sender's account + authorisation code ──
  const { data: actorRow } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', who.user.id)
    .maybeSingle();
  const actorId = (actorRow as { id: string } | null)?.id ?? null;
  if (!actorId) return jsonResponse(200, { ok: false, error: 'No staff account for this session.' });
  const { data: staffRow } = await admin
    .from('lng_staff_members')
    .select('authorisation_code')
    .eq('account_id', actorId)
    .maybeSingle();
  const authorisationCode = ((staffRow as { authorisation_code: string | null } | null)?.authorisation_code ?? '').trim();
  if (!authorisationCode) {
    return jsonResponse(200, {
      ok: false,
      error: 'You have no authorisation code set. Add yours in Admin, Staff, then send.',
      reason: 'no_auth_code',
    });
  }

  // ── Appointment + patient + location + DPD link ──
  const { data: apptRow, error: apptErr } = await admin
    .from('lng_appointments')
    .select('id, patient_id, location_id, service_type')
    .eq('id', body.appointment_id)
    .maybeSingle();
  if (apptErr || !apptRow) return jsonResponse(200, { ok: false, error: 'Appointment not found.' });
  const appt = apptRow as { id: string; patient_id: string; location_id: string | null; service_type: string | null };

  const [patientRes, locationRes, linkRes] = await Promise.all([
    admin.from('patients').select('first_name, email, phone').eq('id', appt.patient_id).maybeSingle(),
    appt.location_id
      ? admin.from('locations').select('name').eq('id', appt.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from('lng_settings').select('value').eq('key', 'returns.link').is('location_id', null).maybeSingle(),
  ]);
  const patient = patientRes.data as { first_name: string | null; email: string | null; phone: string | null } | null;
  if (!patient) return jsonResponse(200, { ok: false, error: 'Patient not found.' });
  const clinicName = ((locationRes.data as { name: string | null } | null)?.name ?? '').trim() || 'the clinic';
  const linkVal = (linkRes.data as { value: unknown } | null)?.value;
  const returnsLink = (typeof linkVal === 'string' ? linkVal : String(linkVal ?? '')).trim() || RETURNS_LINK_DEFAULT;

  const variables: Record<string, string> = {
    patientFirstName: properCase((patient.first_name ?? '').trim()) || 'there',
    authorisationCode,
    returnsLink,
    clinicName,
  };

  const result: { ok: true; email?: ChannelResult; sms?: ChannelResult } = { ok: true };

  // ── Email ──
  if (wantEmail) {
    result.email = await sendEmailChannel(admin, appt, patient, variables);
  }

  // ── SMS ──
  if (wantSms) {
    result.sms = await sendSmsChannel(admin, appt, patient, variables, actorId);
  }

  return jsonResponse(200, result);
}

async function sendEmailChannel(
  admin: SupabaseClient,
  appt: { id: string; patient_id: string; location_id: string | null },
  patient: { email: string | null },
  variables: Record<string, string>,
): Promise<ChannelResult> {
  const to = (patient.email ?? '').trim();
  if (!to) return { status: 'skipped', reason: 'no_email' };
  if (!RESEND_API_KEY) return { status: 'skipped', reason: 'email_not_configured' };

  const { data: tplRaw, error: tplErr } = await admin.rpc('lng_resolve_email_template', {
    p_key: 'returns',
    p_service_type: VIRTUAL,
  });
  const tpl = (Array.isArray(tplRaw) ? tplRaw[0] : tplRaw) as
    | { subject: string; body_syntax: string; enabled: boolean }
    | null;
  if (tplErr || !tpl) return { status: 'failed', error: 'Returns email template not found.' };
  if (!tpl.enabled) return { status: 'skipped', reason: 'template_disabled' };

  const headers = await getEmailSenderHeaders(admin);
  const brand = await loadBrand(admin);
  const send = await renderAndSend({
    apiKey: RESEND_API_KEY,
    from: headers.from,
    replyTo: headers.replyTo,
    to,
    template: tpl as TemplateRow,
    brand,
    variables,
  });

  await recordEmailMessage(admin, {
    patient_id: appt.patient_id,
    appointment_id: appt.id,
    location_id: appt.location_id,
    template_key: 'returns',
    kind: 'returns',
    subject: send.ok ? send.subject : substituteVariables(tpl.subject, variables),
    html: send.ok ? send.html : '',
    body_text: send.ok ? send.text : null,
    to_email: to,
    from_email: headers.fromAddress,
    reply_to: headers.replyTo,
    provider: 'resend',
    provider_message_id: send.ok ? (send.messageId ?? null) : null,
    send_status: send.ok ? 'sent' : 'failed',
    send_error: send.ok ? null : send.error,
  });

  return send.ok ? { status: 'sent' } : { status: 'failed', error: send.error };
}

async function sendSmsChannel(
  admin: SupabaseClient,
  appt: { id: string; patient_id: string; location_id: string | null; service_type: string | null },
  patient: { phone: string | null },
  variables: Record<string, string>,
  actorId: string,
): Promise<ChannelResult> {
  const raw = (patient.phone ?? '').trim();
  if (!raw) return { status: 'skipped', reason: 'no_phone' };
  const to = normalisePhone(raw);

  const { data: tplRaw, error: tplErr } = await admin.rpc('lng_resolve_sms_template', {
    p_key: 'returns',
    p_service_type: VIRTUAL,
  });
  const tpl = (Array.isArray(tplRaw) ? tplRaw[0] : tplRaw) as { body: string; enabled: boolean } | null;
  if (tplErr || !tpl) return { status: 'failed', error: 'Returns SMS template not found.' };
  if (!tpl.enabled) return { status: 'skipped', reason: 'template_disabled' };

  const renderedBody = substituteVariables(tpl.body, variables);
  const send = await sendSms({ to, body: renderedBody });

  await recordSmsMessage(admin, {
    patient_id: appt.patient_id,
    appointment_id: appt.id,
    location_id: appt.location_id,
    template_key: 'returns',
    to_phone: to,
    body: renderedBody,
    send_status: send.ok ? 'sent' : 'failed',
    send_error: send.ok ? null : send.message,
    twilio_message_sid: send.ok ? send.sid : null,
    sent_by: actorId,
    sent_at: new Date().toISOString(),
  });

  return send.ok ? { status: 'sent' } : { status: 'failed', error: send.message };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
