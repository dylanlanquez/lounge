// checkpoint-jb-check
//
// Receptionist-side JB conflict check for the Lounge arrival intake sheet.
// Given a job box number (digits only, e.g. "33"), this asks Checkpoint
// whether the box is currently occupied by an active lab order or
// active walk-in. If it is, we surface enough context (order name,
// customer name) so the receptionist can either reuse the box if it's
// the same person or pick a different one.
//
// Source-of-truth tables (mirrors Meridian's checkpoint-lookup):
//   - order_arch_slots — live lab orders. Active = status='in_lab'.
//   - walk_ins         — live walk-in impressions. Active = status not in
//                        ('complete', 'cancelled').
//
// Note: Checkpoint's check_ins table is the AUDIT LOG, not live state.
// Querying it would surface every historical occupant of the box.
// Meridian's checkpoint-lookup carries the same warning.
//
// Auth model: anon-key Bearer JWT for the caller (per Lounge brief
// §8.5). The caller must have a Lounge account row.
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
  source: 'lab_order' | 'walk_in';
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

  return json({
    jb_ref: digits,
    formatted: jbFormatted,
    available: conflict === null,
    conflict,
  });
});
