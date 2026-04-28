// checkpoint-jb-check
//
// Receptionist-side JB conflict check for the Lounge arrival intake sheet.
// Given a job box number (digits only, e.g. "33"), this asks Checkpoint
// whether the box is currently occupied by an open check-in or walk-in
// slot. If it is, we surface enough context (order name, customer name)
// so the receptionist can either reuse the box if it's the same person
// or pick a different one.
//
// Mirrors Meridian's production-begin → checkpoint pattern: the caller
// is authenticated against Lounge with a normal user JWT, and we then
// fan out to Checkpoint with the service-role key configured for that
// project.
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
  const trimmed = input.trim().toUpperCase().replace(/^JB/, '');
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return String(parseInt(trimmed, 10));
}

interface Conflict {
  order_name: string | null;
  customer_name: string | null;
  status: string | null;
  checked_in_at: string | null;
  source: 'shopify_order' | 'walk_in';
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
  // Two surfaces can hold a JB on Checkpoint:
  //   - check_ins (Shopify-order-driven flow)
  //   - walk_ins  (impression-only walk-ins from the front desk)
  // Both should be considered "occupied" — a JB only holds one patient's
  // impression at a time. Status filtering excludes dispatched/cleared
  // rows; "checked_in" / "in_progress" / null status are still active.
  const sbCheckpoint = createClient(CHECKPOINT_SUPABASE_URL, CHECKPOINT_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: checkInRows, error: checkInErr } = await sbCheckpoint
    .from('check_ins')
    .select('order_name, customer_name, status, checked_in_at, job_box')
    .eq('job_box', jbFormatted)
    .neq('status', 'dispatched')
    .order('checked_in_at', { ascending: false })
    .limit(1);
  if (checkInErr) {
    return json({ error: 'checkpoint_query_failed', detail: checkInErr.message }, 502);
  }

  let conflict: Conflict | null = null;
  if (checkInRows && checkInRows.length > 0) {
    const r = checkInRows[0] as {
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
      source: 'shopify_order',
    };
  }

  if (!conflict) {
    // Checkpoint also has a walk_ins table (impression-only walk-ins).
    // The shape mirrors check_ins but the source label differs.
    const { data: walkInRows, error: walkInErr } = await sbCheckpoint
      .from('walk_ins')
      .select('first_name, last_name, status, created_at, job_box')
      .eq('job_box', jbFormatted)
      .neq('status', 'dispatched')
      .order('created_at', { ascending: false })
      .limit(1);
    if (walkInErr && walkInErr.code !== '42P01') {
      // 42P01 = relation does not exist; tolerate that since not every
      // Checkpoint deploy has the walk_ins table yet. Anything else is
      // a real failure.
      return json({ error: 'checkpoint_query_failed', detail: walkInErr.message }, 502);
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
