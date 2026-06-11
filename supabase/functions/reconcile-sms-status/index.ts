// reconcile-sms-status — one-shot backfill for lng_sms_messages rows
// left stuck on send_status='pending'.
//
// Twilio fires its delivery StatusCallback exactly once per state change
// and does NOT retry on a non-2xx response. While twilio-sms-status was
// (wrongly) requiring a Supabase JWT it answered every callback with 401,
// so those one-shot 'delivered' / 'failed' updates were lost and the rows
// never advanced past 'pending'. The webhook is fixed going forward; this
// function repairs the rows the outage already stranded by asking Twilio
// for each message's CURRENT status via the REST API and mapping it onto
// our send_status the same way the webhook does.
//
// Gate: POST with header `x-reconcile-token` matching the
// SMS_RECONCILE_TOKEN secret. Deployed --no-verify-jwt (pinned in
// config.toml) so it can be invoked with that token alone.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RECONCILE_TOKEN = Deno.env.get('SMS_RECONCILE_TOKEN') ?? '';
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

// Same mapping the twilio-sms-status webhook uses: 'sent' means the
// handset reported delivery, not just carrier acceptance.
function mapStatus(raw: string): 'sent' | 'failed' | 'pending' {
  const s = raw.toLowerCase();
  if (s === 'delivered') return 'sent';
  if (s === 'undelivered' || s === 'failed' || s === 'canceled') return 'failed';
  return 'pending';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!RECONCILE_TOKEN || req.headers.get('x-reconcile-token') !== RECONCILE_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const apiKeySid = Deno.env.get('TWILIO_API_KEY_SID') ?? '';
  const apiKeySecret = Deno.env.get('TWILIO_API_KEY_SECRET') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  // For READING messages we prefer the master Account SID + Auth Token:
  // the send path may use a restricted (send-only) API key that 401s on
  // GET /Messages. Fall back to the API key only if no auth token.
  const haveAuthToken = authToken.length > 0;
  const authUser = haveAuthToken ? accountSid : apiKeySid;
  const authPass = haveAuthToken ? authToken : apiKeySecret;
  if (!accountSid || !authPass) {
    return new Response(JSON.stringify({ error: 'Twilio not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const basic = btoa(`${authUser}:${authPass}`);

  // One-line capability probe so a 401 storm is diagnosable: which
  // credential shapes exist, without ever echoing secret values.
  const creds = {
    has_account_sid: accountSid.length > 0,
    has_auth_token: haveAuthToken,
    has_api_key: apiKeySid.length > 0 && apiKeySecret.length > 0,
    using: haveAuthToken ? 'account_sid+auth_token' : 'api_key',
  };
  if (new URL(req.url).searchParams.get('probe') === '1') {
    return new Response(JSON.stringify({ creds }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Stuck rows: pending, with a Twilio SID, sent within the last 30 days
  // (older than Twilio's message retention isn't worth querying).
  const { data: rows, error } = await supabase
    .from('lng_sms_messages')
    .select('id, twilio_message_sid, to_phone, send_status, sent_at')
    .eq('send_status', 'pending')
    .not('twilio_message_sid', 'is', null)
    .gte('sent_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('sent_at', { ascending: false });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results: Array<{ id: string; sid: string; twilio: string; mapped: string; updated: boolean }> = [];
  for (const row of rows ?? []) {
    const sid = row.twilio_message_sid as string;
    let twilioStatus = '';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      const res = await fetch(`${TWILIO_BASE}/Accounts/${accountSid}/Messages/${sid}.json`, {
        headers: { Authorization: `Basic ${basic}` },
      });
      if (!res.ok) {
        results.push({ id: row.id, sid, twilio: `http_${res.status}`, mapped: 'pending', updated: false });
        continue;
      }
      const body = await res.json();
      twilioStatus = String(body.status ?? '');
      errorCode = body.error_code != null ? String(body.error_code) : null;
      errorMessage = body.error_message != null ? String(body.error_message) : null;
    } catch {
      results.push({ id: row.id, sid, twilio: 'fetch_error', mapped: 'pending', updated: false });
      continue;
    }

    const mapped = mapStatus(twilioStatus);
    if (mapped === 'pending') {
      // Still genuinely in-flight at Twilio — leave it.
      results.push({ id: row.id, sid, twilio: twilioStatus, mapped, updated: false });
      continue;
    }
    const patch: Record<string, unknown> = { send_status: mapped };
    if (mapped === 'failed') {
      patch.send_error = [errorCode, errorMessage].filter(Boolean).join(' ') || twilioStatus;
    }
    const { error: upErr } = await supabase.from('lng_sms_messages').update(patch).eq('id', row.id);
    results.push({ id: row.id, sid, twilio: twilioStatus, mapped, updated: !upErr });
  }

  const summary = {
    creds,
    checked: results.length,
    updated: results.filter((r) => r.updated).length,
    delivered: results.filter((r) => r.mapped === 'sent' && r.updated).length,
    failed: results.filter((r) => r.mapped === 'failed' && r.updated).length,
    still_pending: results.filter((r) => r.mapped === 'pending').length,
    results,
  };
  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
