// lng-reset-2fa
//
// Removes every MFA factor enrolled by the target staff member.
// Used by the admin "Reset 2FA" action when a staff member loses
// their authenticator device, gets a new phone, etc. — they're
// prompted to enrol a fresh one on next sign-in (chunk 3 wires the
// enrolment screen).
//
// Implementation: deletes auth.mfa_factors rows for the user.
// The Supabase JS admin SDK doesn't expose mfa.deleteFactor at the
// admin level, but auth.mfa_factors is a regular table accessible
// to the service role. We delete by user_id which removes every
// factor type (totp, phone) the user has enrolled.
//
// Auth: Bearer JWT (anon key). Caller must be an active Lounge admin.
//
// Body: { staff_member_id: string }
//
// Returns: { ok: true, factors_removed: number }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) {
    return jsonResponse(401, { ok: false, error: 'No bearer token' });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who?.user) return jsonResponse(401, { ok: false, error: 'Not signed in' });
  const callerAuthId = who.user.id;

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerRaw, error: callerErr } = await admin
    .from('accounts')
    .select('id')
    .eq('auth_user_id', callerAuthId)
    .maybeSingle();
  if (callerErr) return jsonResponse(500, { ok: false, error: callerErr.message });
  if (!callerRaw) return jsonResponse(403, { ok: false, error: 'No account row for caller' });
  const callerAccountId = (callerRaw as { id: string }).id;

  const { data: callerStaff } = await admin
    .from('lng_staff_members')
    .select('is_admin, status')
    .eq('account_id', callerAccountId)
    .maybeSingle();
  if (callerStaff?.is_admin !== true || callerStaff.status !== 'active') {
    return jsonResponse(403, { ok: false, error: 'Lounge admin only' });
  }

  let body: { staff_member_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON' });
  }
  const staffMemberId = body.staff_member_id?.trim() ?? '';
  if (!staffMemberId) {
    return jsonResponse(400, { ok: false, error: 'staff_member_id required' });
  }

  // Resolve the target's auth_user_id via the joined accounts row.
  const { data: targetRaw, error: targetErr } = await admin
    .from('lng_staff_members')
    .select('id, account:accounts!account_id(id, auth_user_id)')
    .eq('id', staffMemberId)
    .maybeSingle();
  if (targetErr) return jsonResponse(500, { ok: false, error: targetErr.message });
  if (!targetRaw) return jsonResponse(404, { ok: false, error: 'Staff member not found' });
  const target = targetRaw as {
    id: string;
    account: { id: string; auth_user_id: string | null } | null;
  };
  const targetAuthId = target.account?.auth_user_id;
  if (!targetAuthId) {
    return jsonResponse(400, { ok: false, error: 'Staff member has no auth user (invite not yet accepted?)' });
  }

  // Remove all enrolled MFA factors for this auth user. auth.mfa_factors
  // is a regular table from PostgREST's perspective when accessed via
  // the service role. We schema-qualify because PostgREST exposes the
  // public schema by default; the admin client honours the schema in
  // the from() argument.
  const { data: deleted, error: delErr } = await admin
    .schema('auth')
    .from('mfa_factors')
    .delete()
    .eq('user_id', targetAuthId)
    .select('id');
  if (delErr) {
    return jsonResponse(500, { ok: false, error: `Could not delete MFA factors: ${delErr.message}` });
  }

  const factorsRemoved = Array.isArray(deleted) ? deleted.length : 0;

  // Audit log so an admin can answer "who reset whose 2FA when".
  try {
    await admin.from('lng_event_log').insert({
      source: 'lng-reset-2fa',
      event_type: 'mfa_reset',
      account_id: callerAccountId,
      payload: {
        target_staff_member_id: staffMemberId,
        target_auth_user_id: targetAuthId,
        factors_removed: factorsRemoved,
      },
    });
  } catch {
    // event-log failures shouldn't crash the reset response
  }

  return jsonResponse(200, { ok: true, factors_removed: factorsRemoved });
});
