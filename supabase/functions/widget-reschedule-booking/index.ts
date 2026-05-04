// widget-reschedule-booking
//
// Customer self-serve reschedule. The patient hits this from the
// manage page (/widget/manage?token=<uuid>) after picking a new
// slot. We verify the manage token, run the same conflict check
// the staff app uses (excluding the original appointment so a
// same-time reschedule doesn't conflict with itself), insert a
// new lng_appointments row, mark the old row 'rescheduled', emit
// patient_events, and fire the cancellation+confirmation paired
// email so the patient's calendar updates cleanly.
//
// Mirrors the staff rescheduleAppointment helper but:
//   • Caller is unauth'd; auth is the manage_token, not auth.uid.
//   • New row gets source='native' (the widget originated the
//     reschedule).
//   • Deposit fields carry from the old row to the new one — the
//     patient already paid; rescheduling shouldn't re-charge.
//   • New row gets a fresh manage_token so the new confirmation
//     email links correctly. The old token still resolves but
//     loads the rescheduled state.
//
// Auth model: anon-callable. The 122-bit manage_token IS the auth.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};

interface Body {
  token?: string;
  newStartAt?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExistingAppointment {
  id: string;
  patient_id: string;
  location_id: string;
  source: 'calendly' | 'manual' | 'native';
  status: string;
  service_type: string | null;
  event_type_label: string | null;
  staff_account_id: string | null;
  repair_variant: string | null;
  product_key: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  notes: string | null;
  appointment_ref: string | null;
  start_at: string;
  deposit_status: string | null;
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: string | null;
  deposit_external_id: string | null;
  deposit_paid_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (e) {
    return jsonResponse(400, { error: 'bad_json', detail: String(e) });
  }
  const token = (body.token ?? '').trim();
  const newStartAt = (body.newStartAt ?? '').trim();
  if (!UUID_RE.test(token)) return jsonResponse(400, { error: 'invalid_token' });
  if (!newStartAt) return jsonResponse(400, { error: 'newStartAt_missing' });
  const newStart = new Date(newStartAt);
  if (Number.isNaN(newStart.getTime())) return jsonResponse(400, { error: 'newStartAt_invalid' });
  if (newStart.getTime() <= Date.now()) return jsonResponse(400, { error: 'newStartAt_in_past' });

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Lookup existing appointment by token ────────────────────
  const { data: existingRaw, error: lookupErr } = await supabase
    .from('lng_appointments')
    .select(
      'id, patient_id, location_id, source, status, service_type, event_type_label, staff_account_id, repair_variant, product_key, arch, notes, appointment_ref, start_at, deposit_status, deposit_pence, deposit_currency, deposit_provider, deposit_external_id, deposit_paid_at',
    )
    .eq('manage_token', token)
    .maybeSingle();
  if (lookupErr) {
    await logFailure('lookup_failed', { error: lookupErr.message });
    return jsonResponse(500, { error: 'lookup_failed' });
  }
  if (!existingRaw) return jsonResponse(404, { error: 'token_not_found' });
  const existing = existingRaw as ExistingAppointment;

  // ── Source / status guards ──────────────────────────────────
  if (existing.source === 'calendly') {
    return jsonResponse(409, { error: 'calendly_source_not_supported' });
  }
  if (
    existing.status === 'rescheduled' ||
    existing.status === 'cancelled' ||
    existing.status === 'no_show' ||
    existing.status === 'complete'
  ) {
    return jsonResponse(409, { error: 'not_reschedulable', status: existing.status });
  }
  if (new Date(existing.start_at).getTime() < Date.now()) {
    return jsonResponse(409, { error: 'too_late_to_reschedule' });
  }

  // ── Resolve duration via the booking-type resolver ──────────
  const { data: cfgRaw, error: cfgErr } = await supabase.rpc('lng_booking_type_resolve', {
    p_service_type: existing.service_type,
    p_repair_variant: existing.repair_variant,
    p_product_key: existing.product_key,
    p_arch: existing.arch,
  });
  if (cfgErr) {
    await logFailure('booking_type_resolve_failed', { error: cfgErr.message });
    return jsonResponse(500, { error: 'resolve_failed' });
  }
  const cfg = (Array.isArray(cfgRaw) ? cfgRaw[0] : null) as
    | { duration_default?: number }
    | null;
  if (!cfg || typeof cfg.duration_default !== 'number') {
    return jsonResponse(400, { error: 'no_booking_config' });
  }
  const newEnd = new Date(newStart.getTime() + cfg.duration_default * 60_000);

  // ── Conflict check (excluding the original) ─────────────────
  const { data: conflictRows, error: conflictErr } = await supabase.rpc(
    'lng_booking_check_conflict',
    {
      p_location_id: existing.location_id,
      p_service_type: existing.service_type,
      p_start_at: newStart.toISOString(),
      p_end_at: newEnd.toISOString(),
      p_exclude_appointment_id: existing.id,
      p_repair_variant: existing.repair_variant,
      p_product_key: existing.product_key,
      p_arch: existing.arch,
    },
  );
  if (conflictErr) {
    await logFailure('conflict_check_failed', { error: conflictErr.message });
    return jsonResponse(500, { error: 'conflict_check_failed' });
  }
  if (Array.isArray(conflictRows) && conflictRows.length > 0) {
    return jsonResponse(409, { error: 'slot_unavailable' });
  }

  // ── Generate fresh appointment_ref for the new row ──────────
  const { data: refRaw, error: refErr } = await supabase.rpc('generate_appointment_ref');
  if (refErr) {
    await logFailure('appointment_ref_failed', { error: refErr.message });
    return jsonResponse(500, { error: 'ref_failed' });
  }
  const newRef = typeof refRaw === 'string' ? refRaw : null;

  // ── Insert new appointment ──────────────────────────────────
  const { data: insertedRaw, error: insertErr } = await supabase
    .from('lng_appointments')
    .insert({
      patient_id: existing.patient_id,
      location_id: existing.location_id,
      source: 'native',
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      status: 'booked',
      service_type: existing.service_type,
      event_type_label: existing.event_type_label,
      staff_account_id: existing.staff_account_id,
      repair_variant: existing.repair_variant,
      product_key: existing.product_key,
      arch: existing.arch,
      notes: existing.notes,
      appointment_ref: newRef,
      // Carry the deposit forward — patient already paid; the
      // Stripe PI is associated with the same booking, just a new
      // row. Reports filtering by status='booked' will see exactly
      // one paid row at a time (old row flips to 'rescheduled'
      // below).
      deposit_status: existing.deposit_status,
      deposit_pence: existing.deposit_pence,
      deposit_currency: existing.deposit_currency,
      deposit_provider: existing.deposit_provider,
      deposit_external_id: existing.deposit_external_id,
      deposit_paid_at: existing.deposit_paid_at,
    })
    .select('id, manage_token')
    .single();
  if (insertErr || !insertedRaw) {
    await logFailure('insert_failed', { error: insertErr?.message });
    return jsonResponse(500, { error: 'insert_failed' });
  }
  const newRow = insertedRaw as { id: string; manage_token: string };

  // ── Mark old row rescheduled with the chain pointer ─────────
  const { error: updateErr } = await supabase
    .from('lng_appointments')
    .update({
      status: 'rescheduled',
      reschedule_to_id: newRow.id,
      cancel_reason: 'patient_self_serve_reschedule',
    })
    .eq('id', existing.id);
  if (updateErr) {
    await logFailure('update_old_failed', {
      error: updateErr.message,
      newAppointmentId: newRow.id,
      oldAppointmentId: existing.id,
    });
    // We've created a new row but the old row's still booked.
    // Don't unwind — the operator can fix via the Schedule sheet
    // and the patient has the new confirmation email.
  }

  // ── patient_events for both sides of the chain ──────────────
  await supabase.from('patient_events').insert({
    patient_id: existing.patient_id,
    event_type: 'appointment_rescheduled',
    payload: {
      old_appointment_id: existing.id,
      new_appointment_id: newRow.id,
      old_appointment_ref: existing.appointment_ref,
      new_appointment_ref: newRef,
      source: 'widget_self_serve',
    },
  });

  // ── Send paired REQUEST + CANCEL email ──────────────────────
  // The email function understands oldAppointmentIdToCancel and
  // emits both .ics attachments in one message so most calendars
  // (Apple, Outlook, Google) update the existing event in place.
  try {
    const { error: emailErr } = await supabase.functions.invoke(
      'send-appointment-confirmation',
      {
        body: {
          appointmentId: newRow.id,
          oldAppointmentIdToCancel: existing.id,
        },
      },
    );
    if (emailErr) {
      await logFailure('reschedule_email_invoke_failed', {
        newAppointmentId: newRow.id,
        oldAppointmentId: existing.id,
        error: emailErr.message,
      }, 'warning');
    }
  } catch (e) {
    await logFailure('reschedule_email_threw', {
      newAppointmentId: newRow.id,
      error: e instanceof Error ? e.message : String(e),
    }, 'warning');
  }

  return jsonResponse(200, {
    ok: true,
    newAppointmentId: newRow.id,
    newManageToken: newRow.manage_token,
    newAppointmentRef: newRef,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'widget-reschedule-booking',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
