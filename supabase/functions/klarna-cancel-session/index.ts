// klarna-cancel-session
//
// POST { session_row_id }
//
// Aborts a pending or awaiting_customer Klarna in-store session.
// Use when staff hits Cancel on the QR modal because the patient
// walked away, picked card instead, or the customer scanned and
// got stuck in the Klarna app.
//
// Side effects:
//   • lng_klarna_sessions  → status='cancelled', cancelled_at,
//                             cancelled_by stamped
//   • lng_payments         → status='cancelled', cancelled_at
//
// We do NOT call Klarna's cancel endpoint when the session never
// reached awaiting_customer (it has no klarna_session_id). For
// sessions Klarna knows about we POST a cancel via Klarna's API.
// If Klarna's cancel call fails (e.g. session already completed
// on Klarna's side) we still flip local state — the webhook
// handler will reconcile to 'captured' when it fires, and the
// reconciliation logger picks up the conflict.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const KLARNA_API_USERNAME = Deno.env.get('KLARNA_API_USERNAME') ?? '';
const KLARNA_API_PASSWORD = Deno.env.get('KLARNA_API_PASSWORD') ?? '';
const KLARNA_API_BASE_URL = (Deno.env.get('KLARNA_API_BASE_URL') ?? 'https://api.klarna.com').replace(/\/$/, '');

interface CancelBody {
  session_row_id: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return jsonError(401, 'Missing token');

  let body: CancelBody;
  try { body = await req.json(); } catch { return jsonError(400, 'Bad JSON'); }
  if (!body.session_row_id) return jsonError(400, 'session_row_id required');

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const cancelledBy = (meRow as string | null) ?? null;

  const { data: sessionRow, error: sesErr } = await supabase
    .from('lng_klarna_sessions')
    .select('id, payment_id, klarna_session_id, status')
    .eq('id', body.session_row_id)
    .maybeSingle();
  if (sesErr || !sessionRow) return jsonError(404, 'Session not found');
  const session = sessionRow as {
    id: string;
    payment_id: string;
    klarna_session_id: string | null;
    status: string;
  };

  if (session.status === 'captured') {
    return jsonError(409, 'Session already captured — cannot cancel');
  }
  if (session.status === 'cancelled') {
    return jsonOk({ already_cancelled: true });
  }

  // Best-effort Klarna-side cancel. We tolerate failure here —
  // it's likely "session not found" if Klarna already cleaned it
  // up — and rely on local state flipping to authoritative.
  if (session.klarna_session_id) {
    const cancelRes = await klarnaFetch(
      'POST',
      `/payments/v1/sessions/${encodeURIComponent(session.klarna_session_id)}/cancel`,
      {},
    );
    if (!cancelRes.ok) {
      await logFailure('klarna_cancel_call_failed', {
        session_row_id: session.id,
        klarna_session_id: session.klarna_session_id,
        status: cancelRes.status,
        body: cancelRes.body,
      }, 'warning');
    }
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('lng_klarna_sessions')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: cancelledBy,
    })
    .eq('id', session.id)
    .neq('status', 'captured');  // belt and braces — never cancel a captured row
  if (updErr) return jsonError(500, 'DB update failed');

  await supabase
    .from('lng_payments')
    .update({ status: 'cancelled', cancelled_at: now })
    .eq('id', session.payment_id)
    .in('status', ['pending', 'processing']);

  return jsonOk({ cancelled: true });
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function cors(): Response { return new Response('ok', { headers: CORS_HEADERS }); }
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
function jsonOk(extra: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...extra }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function klarnaFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const credentials = btoa(`${KLARNA_API_USERNAME}:${KLARNA_API_PASSWORD}`);
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${KLARNA_API_BASE_URL}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = {};
  const text = await r.text();
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  return { ok: r.ok, status: r.status, body: parsed };
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'klarna-cancel-session',
      severity, message, context,
    });
  } catch { /* best-effort */ }
}
