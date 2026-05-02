// checkpoint-jb-check
//
// Unified job-box conflict check across all three apps that allocate
// physical numbered boxes: Checkpoint (lab orders + walk-ins),
// Lounge (appointments + walk-ins) and Meridian (production cases).
// Given a job box number (digits only, e.g. "33"), the function
// returns the first active occupant it finds, or available:true if
// every source is clear. The composed read is the single source of
// truth — each app keeps its own table as the local truth for its
// own allocations, and this function is the canonical reader.
//
// Source-of-truth tables (in lookup order — first match wins):
//   1. Checkpoint  order_arch_slots     status='in_lab'
//   2. Checkpoint  walk_ins             status not in ('complete','cancelled')
//   3. Meridian    production_cases     job_box_number set, deleted_at null,
//                                        archived_at null, stage_key not
//                                        'cancelled'. Note 'complete' still
//                                        counts as in-use because the print
//                                        sits in the box until shipped — the
//                                        case is archived after shipping.
//   4. Lounge      lng_appointments     jb_ref non-null (cleared by
//                                        Pay.closeVisit)
//   5. Lounge      lng_walk_ins         jb_ref non-null (same lifecycle)
//
// Note: Checkpoint's check_ins table is the AUDIT LOG, not live state.
// Querying it would surface every historical occupant of the box.
// Meridian's checkpoint-lookup carries the same warning.
//
// Auth model: anon-key Bearer JWT for the caller. Any user with a row
// in `accounts` (shared between Lounge and Meridian on the npu
// project) can call it — the response only carries first-name +
// case/order ref, no PII beyond what staff already see in their app.
//
// Required env (Lounge Supabase project):
//   SUPABASE_URL                       — Meridian / Lounge project URL
//   SUPABASE_SERVICE_ROLE_KEY          — Meridian / Lounge service role
//   SUPABASE_ANON_KEY                  — for caller-scoped client
//   CHECKPOINT_SUPABASE_URL            — Checkpoint project URL
//   CHECKPOINT_SERVICE_ROLE_KEY        — Checkpoint service role

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CHECKPOINT_SUPABASE_URL = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
const CHECKPOINT_SERVICE_ROLE_KEY = Deno.env.get('CHECKPOINT_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// JB refs are digits-only on Lounge's side (lng_appointments.jb_ref).
// Checkpoint stores them prefixed with "JB" (e.g. JB33). Normalise here
// so the receptionist can paste either form and we always query a
// consistent shape.
function normaliseJbDigits(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toUpperCase().replace(/^JB[-_\s]*/i, '');
  // Allow up to 10 digits — labs run JB sequences well past 9999, so the
  // old 4-digit cap was rejecting legitimate refs (e.g. JB997786). Still
  // bounded so a paste accident can't blow up parseInt.
  if (!/^\d{1,10}$/.test(trimmed)) return null;
  return String(parseInt(trimmed, 10));
}

interface Conflict {
  order_name: string | null;
  customer_name: string | null;
  status: string | null;
  checked_in_at: string | null;
  // Where the conflict was found:
  //   'lab_order'           Checkpoint   order_arch_slots (status=in_lab)
  //   'walk_in'             Checkpoint   walk_ins (active)
  //   'meridian_production' Meridian     production_cases (active)
  //   'lounge_appointment'  Lounge       lng_appointments (jb_ref pinned)
  //   'lounge_walk_in'      Lounge       lng_walk_ins (jb_ref pinned)
  // The receptionist's UI uses this to label the conflict ("in
  // Meridian production", "in Checkpoint", "in Lounge") so they know
  // who currently holds the box.
  source:
    | 'lab_order'
    | 'walk_in'
    | 'meridian_production'
    | 'lounge_appointment'
    | 'lounge_walk_in';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANON_KEY) {
    return json({ error: 'env_missing_lounge' }, 500);
  }
  if (!CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
    return json({ error: 'env_missing_checkpoint' }, 500);
  }

  // ── Caller auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'auth_missing' }, 401);
  const userJwt = authHeader.slice('Bearer '.length).trim();
  if (!userJwt) return json({ error: 'auth_missing' }, 401);

  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await sbAdmin.auth.getUser(userJwt);
  if (userErr || !userData?.user) return json({ error: 'auth_invalid' }, 401);

  const { data: callerAccount } = await sbAdmin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (!callerAccount) return json({ error: 'caller_no_account' }, 403);

  // ── Body ─────────────────────────────────────────────────────────────
  let body: { jb_ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const digits = normaliseJbDigits(body?.jb_ref);
  if (!digits) return json({ error: 'invalid_jb_ref' }, 400);
  const jbFormatted = `JB${digits}`;

  // ── Checkpoint lookup ────────────────────────────────────────────────
  const sbCheckpoint = createClient(CHECKPOINT_SUPABASE_URL, CHECKPOINT_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let conflict: Conflict | null = null;

  // 1. Lab orders — order_arch_slots. Live state lives here. Active
  //    occupants have status='in_lab'; 'dispatched' rows are historical
  //    and don't represent the box being currently occupied.
  const { data: slotRows, error: slotsErr } = await sbCheckpoint
    .from('order_arch_slots')
    .select('order_name, customer_name, status, checked_in_at')
    .eq('job_box', jbFormatted)
    .eq('status', 'in_lab')
    .order('checked_in_at', { ascending: false })
    .limit(1);
  if (slotsErr) {
    return json(
      { error: 'checkpoint_query_failed', source: 'order_arch_slots', detail: slotsErr.message },
      502
    );
  }
  if (slotRows && slotRows.length > 0) {
    const r = slotRows[0] as {
      order_name: string | null;
      customer_name: string | null;
      status: string | null;
      checked_in_at: string | null;
    };
    conflict = {
      order_name: r.order_name,
      customer_name: r.customer_name,
      status: r.status,
      checked_in_at: r.checked_in_at,
      source: 'lab_order',
    };
  }

  // 2. Walk-in impressions — walk_ins. Active = status not in
  //    ('complete', 'cancelled'). Mirrors Meridian's checkpoint-lookup.
  if (!conflict) {
    const { data: walkInRows, error: walkInErr } = await sbCheckpoint
      .from('walk_ins')
      .select('first_name, last_name, status, created_at')
      .eq('job_box', jbFormatted)
      .not('status', 'in', '("complete","cancelled")')
      .order('created_at', { ascending: false })
      .limit(1);
    if (walkInErr && walkInErr.code !== '42P01') {
      return json(
        { error: 'checkpoint_query_failed', source: 'walk_ins', detail: walkInErr.message },
        502
      );
    }
    if (walkInRows && walkInRows.length > 0) {
      const r = walkInRows[0] as {
        first_name: string | null;
        last_name: string | null;
        status: string | null;
        created_at: string | null;
      };
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null;
      conflict = {
        order_name: null,
        customer_name: name,
        status: r.status,
        checked_in_at: r.created_at,
        source: 'walk_in',
      };
    }
  }

  // 3. Meridian active production cases — production_cases.job_box_number.
  //    Stored as digits-only (Meridian's JobBoxSafeguard strips non-
  //    digits from the input before saving), matching Lounge's jb_ref
  //    shape — so we query with `digits`, not `jbFormatted`.
  //    Filters:
  //      • deleted_at is null  (soft-deleted cases freed the box)
  //      • archived_at is null (archived = case parked, box freed
  //                             when physical handling finished)
  //      • stage_key != 'cancelled' (cancellation frees the box)
  //    Note 'complete' is INCLUDED — once a print is complete, the
  //    box still sits in the lab until physical shipping. We only
  //    treat the box as freed when the case is archived/deleted.
  //    Joins through patients (shared with Lounge on the same project)
  //    to surface a customer name in the conflict banner.
  if (!conflict) {
    const { data: caseRows, error: caseErr } = await sbAdmin
      .from('production_cases')
      .select(
        'reference, stage_key, stage_entered_at, patient:patients(first_name, last_name)'
      )
      .eq('job_box_number', digits)
      .is('deleted_at', null)
      .is('archived_at', null)
      .neq('stage_key', 'cancelled')
      .order('stage_entered_at', { ascending: false })
      .limit(1);
    if (caseErr) {
      return json(
        { error: 'meridian_query_failed', source: 'production_cases', detail: caseErr.message },
        502
      );
    }
    if (caseRows && caseRows.length > 0) {
      const r = caseRows[0] as {
        reference: string | null;
        stage_key: string | null;
        stage_entered_at: string | null;
        patient:
          | { first_name: string | null; last_name: string | null }
          | { first_name: string | null; last_name: string | null }[]
          | null;
      };
      const p = Array.isArray(r.patient) ? r.patient[0] ?? null : r.patient;
      const name = p
        ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
        : null;
      conflict = {
        order_name: r.reference,
        customer_name: name,
        status: r.stage_key,
        checked_in_at: r.stage_entered_at,
        source: 'meridian_production',
      };
    }
  }

  // 4. Lounge active appointments — direct jb_ref pin. The column is
  //    nulled by Pay.closeVisit when the visit completes, so a
  //    non-null match means "currently held by a live appointment".
  if (!conflict) {
    const { data: apptRows, error: apptErr } = await sbAdmin
      .from('lng_appointments')
      .select(
        'appointment_ref, start_at, status, patient:patients(first_name, last_name)'
      )
      .eq('jb_ref', digits)
      .order('start_at', { ascending: false })
      .limit(1);
    if (apptErr) {
      return json(
        { error: 'lounge_query_failed', source: 'lng_appointments', detail: apptErr.message },
        502
      );
    }
    if (apptRows && apptRows.length > 0) {
      const r = apptRows[0] as {
        appointment_ref: string | null;
        start_at: string | null;
        status: string | null;
        patient:
          | { first_name: string | null; last_name: string | null }
          | { first_name: string | null; last_name: string | null }[]
          | null;
      };
      const p = Array.isArray(r.patient) ? r.patient[0] ?? null : r.patient;
      const name = p
        ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
        : null;
      conflict = {
        order_name: r.appointment_ref,
        customer_name: name,
        status: r.status,
        checked_in_at: r.start_at,
        source: 'lounge_appointment',
      };
    }
  }

  // 4. Lounge active walk-ins. Same logic — jb_ref non-null = in use.
  //    Walk-ins don't have an appointment_ref UI label that maps as
  //    cleanly, but we still pass the LAP-style ref the column carries
  //    so the receptionist sees a stable identifier in the conflict
  //    banner.
  if (!conflict) {
    const { data: walkInRows, error: walkInErr } = await sbAdmin
      .from('lng_walk_ins')
      .select(
        'appointment_ref, created_at, patient:patients(first_name, last_name)'
      )
      .eq('jb_ref', digits)
      .order('created_at', { ascending: false })
      .limit(1);
    if (walkInErr) {
      return json(
        { error: 'lounge_query_failed', source: 'lng_walk_ins', detail: walkInErr.message },
        502
      );
    }
    if (walkInRows && walkInRows.length > 0) {
      const r = walkInRows[0] as {
        appointment_ref: string | null;
        created_at: string | null;
        patient:
          | { first_name: string | null; last_name: string | null }
          | { first_name: string | null; last_name: string | null }[]
          | null;
      };
      const p = Array.isArray(r.patient) ? r.patient[0] ?? null : r.patient;
      const name = p
        ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
        : null;
      conflict = {
        order_name: r.appointment_ref,
        customer_name: name,
        status: 'walk-in',
        checked_in_at: r.created_at,
        source: 'lounge_walk_in',
      };
    }
  }

  return json({
    jb_ref: digits,
    formatted: jbFormatted,
    available: conflict === null,
    conflict,
  });
});
