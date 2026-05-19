// klarna-webhook
//
// Public endpoint Klarna calls on a status_update event. Reads the
// session-bound token from ?token= and uses it to look up the
// `lng_klarna_sessions` row. Cross-verifies the webhook body by
// re-querying Klarna's distribution.result_url before flipping
// state (Klarna doesn't sign webhooks, so the token + cross-verify
// is the trust anchor).
//
// Side effects on COMPLETED:
//   • lng_klarna_sessions row → status='captured', stamps
//     klarna_order_id + captured_at + raw_last_webhook
//   • lng_payments row → status='succeeded' + succeeded_at
//
// Side effects on FAILED / EXPIRED / CANCELLED:
//   • lng_klarna_sessions row → status='failed' | 'expired' | 'cancelled'
//   • lng_payments row → status='failed' with failure_reason set
//
// Idempotency: the handler is safe to re-apply — flipping a row
// that's already in the target state is a no-op.
//
// Env vars:
//   • KLARNA_API_USERNAME / KLARNA_API_PASSWORD for the result_url
//     cross-verification call.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const KLARNA_API_USERNAME = Deno.env.get('KLARNA_API_USERNAME') ?? '';
const KLARNA_API_PASSWORD = Deno.env.get('KLARNA_API_PASSWORD') ?? '';

interface KlarnaWebhookBody {
  status?: string;
  order_id?: string;
  klarna_reference?: string;
  session_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  // Klarna POSTs the webhook. Allow GET so they can ping for liveness.
  if (req.method === 'GET') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return jsonError(400, 'Missing token');

  let body: KlarnaWebhookBody;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Token-bound lookup: only the row that minted this token can
  // be flipped by this webhook. A spoofed POST without a matching
  // token gets a 404 and never touches state.
  const { data: sessionRow, error: sesErr } = await supabase
    .from('lng_klarna_sessions')
    .select('id, payment_id, klarna_session_id, result_url, status, amount_pence, visit_id')
    .eq('webhook_token', token)
    .maybeSingle();
  if (sesErr) {
    await logFailure('klarna_session_lookup_failed', { error: sesErr.message });
    return jsonError(500, 'Session lookup failed');
  }
  if (!sessionRow) {
    // Unknown token: silently 200 so Klarna doesn't retry forever
    // on a session we've already torn down or never knew about.
    return new Response('ok', { headers: CORS_HEADERS });
  }
  const session = sessionRow as {
    id: string;
    payment_id: string;
    klarna_session_id: string | null;
    result_url: string | null;
    status: string;
    amount_pence: number;
    visit_id: string;
  };

  // Persist the webhook body verbatim before we act on it — debug
  // trail if the cross-verification disagrees.
  await supabase
    .from('lng_klarna_sessions')
    .update({ raw_last_webhook: body })
    .eq('id', session.id);

  const rawStatus = (body.status ?? '').toString().toUpperCase();

  // Map Klarna's status enum onto our session.status. UNKNOWN
  // statuses are logged and acknowledged with 200 so Klarna
  // doesn't retry — a new column value being added on their side
  // shouldn't take our webhook offline.
  if (rawStatus === 'COMPLETED') {
    return await handleCompleted(supabase, session, body);
  }
  if (rawStatus === 'FAILED' || rawStatus === 'CANCELLED' || rawStatus === 'CANCELED' || rawStatus === 'EXPIRED') {
    return await handleNegativeTerminal(supabase, session, rawStatus, body);
  }

  await logFailure('klarna_webhook_unknown_status', {
    session_id: session.id,
    raw_status: rawStatus,
    body,
  }, 'warning');
  return new Response('ok', { headers: CORS_HEADERS });
});

async function handleCompleted(
  supabase: SupabaseClient,
  session: {
    id: string;
    payment_id: string;
    klarna_session_id: string | null;
    result_url: string | null;
    status: string;
    amount_pence: number;
    visit_id: string;
  },
  body: KlarnaWebhookBody,
): Promise<Response> {
  // Cross-verify with the result_url before committing. Per
  // Klarna's "monitor the status" guidance: a webhook claiming
  // COMPLETED should be confirmed by a server-to-server fetch
  // against the result_url. Skips when the row has no result_url
  // (a malformed earlier state, already flagged in
  // lng_system_failures).
  let confirmed = body;
  if (session.result_url) {
    // Klarna's result endpoint is GET (POST returns 400). Same fix
    // as the QR retrieval call in klarna-create-session.
    const verify = await klarnaFetch('GET', stripBase(session.result_url));
    if (verify.ok && verify.body && typeof verify.body === 'object') {
      const v = verify.body as Record<string, unknown>;
      if (typeof v.status === 'string') {
        if (v.status.toUpperCase() !== 'COMPLETED') {
          // Webhook said completed but the source disagrees. Do
          // NOT mark succeeded; flag the conflict and 200 so
          // Klarna doesn't retry. Manual investigation needed.
          await logFailure('klarna_webhook_cross_verify_mismatch', {
            session_id: session.id,
            webhook_status: 'COMPLETED',
            verify_status: v.status,
            verify_body: v,
          }, 'critical');
          return new Response('ok', { headers: CORS_HEADERS });
        }
      }
      confirmed = {
        status: 'COMPLETED',
        order_id: (typeof v.order_id === 'string' ? v.order_id : body.order_id) ?? undefined,
        klarna_reference:
          (typeof v.klarna_reference === 'string' ? v.klarna_reference : body.klarna_reference) ?? undefined,
        session_id: (typeof v.session_id === 'string' ? v.session_id : body.session_id) ?? undefined,
      };
    } else {
      // Cross-verify call failed. We do NOT mark succeeded based
      // on the unsigned webhook alone — flag for manual review.
      await logFailure('klarna_webhook_cross_verify_failed', {
        session_id: session.id,
        verify_status: verify.status,
        verify_body: verify.body,
      }, 'critical');
      return new Response('ok', { headers: CORS_HEADERS });
    }
  }

  // Already captured: idempotent no-op.
  if (session.status === 'captured') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const orderId = confirmed.order_id ?? null;
  if (!orderId) {
    await logFailure('klarna_completed_without_order_id', {
      session_id: session.id,
      body: confirmed,
    }, 'critical');
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const now = new Date().toISOString();
  const { error: sesUpdateErr } = await supabase
    .from('lng_klarna_sessions')
    .update({
      status: 'captured',
      klarna_order_id: orderId,
      klarna_reference: confirmed.klarna_reference ?? null,
      captured_at: now,
    })
    .eq('id', session.id);
  if (sesUpdateErr) {
    await logFailure('lng_klarna_sessions_capture_update_failed', {
      session_id: session.id,
      error: sesUpdateErr.message,
    }, 'critical');
    return jsonError(500, 'DB update failed');
  }

  const { error: payUpdateErr } = await supabase
    .from('lng_payments')
    .update({ status: 'succeeded', succeeded_at: now })
    .eq('id', session.payment_id)
    .neq('status', 'succeeded');
  if (payUpdateErr) {
    await logFailure('lng_payments_capture_update_failed', {
      payment_id: session.payment_id,
      error: payUpdateErr.message,
    }, 'critical');
    // The session is captured but the payment row didn't flip —
    // ledger views will look at lng_payments and the till will
    // appear stuck. Loud failure already logged; return 200 so
    // Klarna doesn't retry (state needs human reconciliation now).
    return new Response('ok', { headers: CORS_HEADERS });
  }

  return new Response('ok', { headers: CORS_HEADERS });
}

async function handleNegativeTerminal(
  supabase: SupabaseClient,
  session: {
    id: string;
    payment_id: string;
    status: string;
  },
  rawStatus: string,
  body: KlarnaWebhookBody,
): Promise<Response> {
  // Map remote status to our enum. CANCELED is Klarna's US-English
  // spelling; we accept both.
  const nextStatus =
    rawStatus === 'EXPIRED' ? 'expired' :
    rawStatus === 'CANCELLED' || rawStatus === 'CANCELED' ? 'cancelled' :
    'failed';

  // Idempotent: skip if already terminal at the right value.
  if (session.status === nextStatus) {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  // Don't downgrade a captured session — if Klarna sends a
  // late FAILED after a successful COMPLETED, that's an internal
  // Klarna race we shouldn't honor.
  if (session.status === 'captured') {
    await logFailure('klarna_webhook_post_capture_negative', {
      session_id: session.id,
      raw_status: rawStatus,
      body,
    }, 'warning');
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === 'cancelled') patch.cancelled_at = now;
  if (nextStatus === 'failed' || nextStatus === 'expired') patch.failed_at = now;

  await supabase.from('lng_klarna_sessions').update(patch).eq('id', session.id);
  await supabase
    .from('lng_payments')
    .update({
      status: nextStatus === 'cancelled' ? 'cancelled' : 'failed',
      failure_reason: `klarna_${nextStatus}`,
      cancelled_at: nextStatus === 'cancelled' ? now : null,
    })
    .eq('id', session.payment_id);

  return new Response('ok', { headers: CORS_HEADERS });
}

// ---------- helpers ----------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function cors(): Response {
  return new Response('ok', { headers: CORS_HEADERS });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function stripBase(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    return u.pathname + u.search;
  } catch {
    return absoluteUrl;
  }
}

const KLARNA_API_BASE_URL = (Deno.env.get('KLARNA_API_BASE_URL') ?? 'https://api.klarna.com').replace(/\/$/, '');

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
    method,
    headers,
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
      source: 'klarna-webhook',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
