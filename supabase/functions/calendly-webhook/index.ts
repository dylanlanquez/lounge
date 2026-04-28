// calendly-webhook
//
// Receives invitee.created / invitee.canceled / routing_form_submission.created
// events from Calendly, verifies the HMAC-SHA256 signature, and writes the raw
// payload into lng_calendly_bookings (idempotency-keyed on delivery_id).
//
// On invitee.created: identity-resolves the invitee against patients, creates
// (or fills-blanks) the patient row, then creates a lng_appointments row.
// On invitee.canceled: updates the matching lng_appointments.status.
//
// Per docs/03-calendly-audit.md §3 and docs/01-architecture-decision.md §2.
//
// Auth model: PUBLIC (no Supabase auth). Calendly does not authenticate via
// Supabase. We rely entirely on the HMAC signature for auth.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SIGNING_KEY = Deno.env.get('CALENDLY_WEBHOOK_SIGNING_KEY') ?? '';

interface CalendlyHeaderTriple {
  t: number;
  v1: string;
}

Deno.serve(async (req) => {
  // CORS preflight (rare for webhooks but safe).
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();

  // Signature verification
  if (SIGNING_KEY) {
    const sigHeader = req.headers.get('calendly-webhook-signature') ?? '';
    const parsed = parseSignature(sigHeader);
    if (!parsed) {
      await logFailure('signature_missing_or_malformed', { sig: sigHeader });
      return new Response('Bad signature', { status: 401 });
    }
    if (Math.abs(Date.now() / 1000 - parsed.t) > 180) {
      await logFailure('signature_replay_window_exceeded', { t: parsed.t });
      return new Response('Stale request', { status: 401 });
    }
    const expected = await hmacSha256Hex(SIGNING_KEY, `${parsed.t}.${rawBody}`);
    if (!constantTimeEqual(expected, parsed.v1)) {
      await logFailure('signature_invalid', { sigHeader });
      return new Response('Bad signature', { status: 401 });
    }
  } else {
    // SIGNING_KEY not set — only allow in environments where this is intentional.
    await logFailure('signature_key_unset', { note: 'Webhook accepted without signature verification.' }, 'warning');
  }

  let parsed: CalendlyEvent;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    await logFailure('payload_unparseable', { e: String(e) });
    return new Response('Bad JSON', { status: 400 });
  }

  const deliveryId =
    req.headers.get('calendly-webhook-delivery-id') ??
    req.headers.get('x-calendly-delivery-id') ??
    parsed?.payload?.uri ??
    crypto.randomUUID();

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Idempotent insert into lng_calendly_bookings
  const { error: insertErr } = await supabase
    .from('lng_calendly_bookings')
    .insert({
      delivery_id: deliveryId,
      event: parsed.event,
      payload: parsed,
    });

  if (insertErr && insertErr.code === '23505') {
    // Duplicate delivery — already processed
    return new Response(JSON.stringify({ ok: true, duplicate: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (insertErr) {
    await logFailure('lng_calendly_bookings_insert_failed', { error: insertErr.message, deliveryId });
    return new Response('DB error', { status: 500 });
  }

  // 2. Per-event handling
  try {
    if (parsed.event === 'invitee.created') {
      await handleInviteeCreated(supabase, parsed);
    } else if (parsed.event === 'invitee.canceled') {
      await handleInviteeCanceled(supabase, parsed);
    } else {
      // Other events get logged but not actioned. Routing form etc.
    }
    await supabase
      .from('lng_calendly_bookings')
      .update({ processed_at: new Date().toISOString() })
      .eq('delivery_id', deliveryId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown';
    await logFailure('webhook_handler_failed', { event: parsed.event, error: msg, deliveryId });
    await supabase
      .from('lng_calendly_bookings')
      .update({ failure_reason: msg })
      .eq('delivery_id', deliveryId);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

// ---------- Event handlers ----------

interface CalendlyEvent {
  event: 'invitee.created' | 'invitee.canceled' | 'routing_form_submission.created' | string;
  created_at?: string;
  payload?: {
    uri?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    name?: string;
    timezone?: string;
    status?: string;
    rescheduled?: boolean;
    questions_and_answers?: Array<{ question: string; answer: string }>;
    scheduled_event?: {
      uri?: string;
      name?: string;
      start_time?: string;
      end_time?: string;
      event_type?: string;
    };
    cancel_url?: string;
    reschedule_url?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function handleInviteeCreated(supabase: SupabaseClient, evt: CalendlyEvent) {
  const inviteeUri = evt.payload?.uri;
  const eventUri = evt.payload?.scheduled_event?.uri;
  const startAt = evt.payload?.scheduled_event?.start_time;
  const endAt = evt.payload?.scheduled_event?.end_time;
  const email = evt.payload?.email?.toLowerCase().trim() ?? null;
  const firstName = evt.payload?.first_name ?? splitName(evt.payload?.name).first;
  const lastName = evt.payload?.last_name ?? splitName(evt.payload?.name).last;
  const eventTypeLabel = evt.payload?.scheduled_event?.name ?? null;

  if (!startAt || !endAt) throw new Error('missing start_time or end_time');

  // Default location (first Venneir lab). v1.5: map per event_type.
  const { data: locRow, error: locErr } = await supabase
    .from('locations')
    .select('id')
    .eq('type', 'lab')
    .eq('is_venneir', true)
    .order('name')
    .limit(1)
    .maybeSingle();
  if (locErr || !locRow) throw new Error('no Venneir lab location found');
  const location_id = (locRow as { id: string }).id;

  // Resolve a default account_id for the location. patients.account_id is a
  // legacy NOT NULL FK in Meridian's schema. Webhooks have no auth.uid(), so
  // we pick the first active member of this location (any role) as the
  // default 'owning' account for Calendly-sourced patients.
  const default_account_id = await resolveDefaultAccountId(supabase, location_id);

  // Identity-resolve patient: email + location, then phone, then create.
  let patient_id: string | null = null;
  if (email) {
    const { data: existing } = await supabase
      .from('patients')
      .select('id')
      .eq('location_id', location_id)
      .ilike('email', email)
      .maybeSingle();
    if (existing) {
      patient_id = (existing as { id: string }).id;
      // fill-blanks merge: only set name fields if currently null. Use a SQL
      // expression via update with COALESCE-like behaviour by reading first.
      const { data: cur } = await supabase
        .from('patients')
        .select('first_name, last_name')
        .eq('id', patient_id)
        .maybeSingle();
      const patch: Record<string, string> = {};
      if (cur && (cur as { first_name: string | null }).first_name == null && firstName)
        patch.first_name = firstName;
      if (cur && (cur as { last_name: string | null }).last_name == null && lastName)
        patch.last_name = lastName;
      if (Object.keys(patch).length > 0) {
        await supabase.from('patients').update(patch).eq('id', patient_id);
      }
    }
  }
  if (!patient_id) {
    const { data: created, error: createErr } = await supabase
      .from('patients')
      .insert({
        account_id: default_account_id,
        location_id,
        first_name: firstName || 'Patient',
        last_name: lastName || '',
        email,
      })
      .select('id')
      .single();
    if (createErr || !created) throw new Error(createErr?.message ?? 'patient create failed');
    patient_id = (created as { id: string }).id;
    await supabase.from('patient_events').insert({
      patient_id,
      event_type: 'patient_created',
      payload: { source: 'calendly', email, calendly_invitee_uri: inviteeUri },
    });
  }

  // Insert lng_appointments
  const { error: apptErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id,
      location_id,
      source: 'calendly',
      calendly_event_uri: eventUri,
      calendly_invitee_uri: inviteeUri,
      start_at: startAt,
      end_at: endAt,
      event_type_label: eventTypeLabel,
      status: 'booked',
    });
  if (apptErr && apptErr.code !== '23505') throw new Error(apptErr.message);

  await supabase.from('patient_events').insert({
    patient_id,
    event_type: 'appointment_booked',
    payload: { source: 'calendly', start_at: startAt, calendly_invitee_uri: inviteeUri },
  });
}

async function handleInviteeCanceled(supabase: SupabaseClient, evt: CalendlyEvent) {
  const inviteeUri = evt.payload?.uri;
  if (!inviteeUri) return;
  const isReschedule = Boolean(evt.payload?.rescheduled);
  const newStatus = isReschedule ? 'rescheduled' : 'cancelled';

  const { data: appt } = await supabase
    .from('lng_appointments')
    .update({ status: newStatus })
    .eq('calendly_invitee_uri', inviteeUri)
    .select('id, patient_id')
    .maybeSingle();

  if (appt) {
    await supabase.from('patient_events').insert({
      patient_id: (appt as { patient_id: string }).patient_id,
      event_type: isReschedule ? 'appointment_rescheduled' : 'appointment_cancelled',
      payload: { calendly_invitee_uri: inviteeUri },
    });
  }
}

// ---------- helpers ----------

function parseSignature(header: string): CalendlyHeaderTriple | null {
  // Format: "t=<unix>,v1=<hex>"
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return null;
  return { t, v1 };
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function splitName(name: string | undefined): { first: string; last: string } {
  if (!name) return { first: '', last: '' };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

async function resolveDefaultAccountId(supabase: SupabaseClient, location_id: string): Promise<string> {
  // Pick the longest-tenured active member of this location as the default
  // owner for Calendly-imported patients. Receptionists or admins both fine.
  const { data: rows, error } = await supabase
    .from('location_members')
    .select('account_id, joined_at')
    .eq('location_id', location_id)
    .is('removed_at', null)
    .order('joined_at', { ascending: true })
    .limit(1);
  if (error || !rows || rows.length === 0) {
    throw new Error(`no active location_members for location ${location_id} — cannot pick default account_id`);
  }
  return (rows[0] as { account_id: string }).account_id;
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error'
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'calendly-webhook',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
