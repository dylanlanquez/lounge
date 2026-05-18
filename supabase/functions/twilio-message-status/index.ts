// twilio-message-status — one-shot diagnostic. Given a Twilio
// message SID, pull the live message resource off Twilio's API and
// return the full lifecycle state so we can tell whether a message
// actually delivered, was filtered, or got stuck in trial-account
// restrictions.
//
// Deployed with --no-verify-jwt so we can curl it from an admin
// shell during incident response without needing a browser session.
// The Twilio credentials it forwards are project secrets that never
// reach the response body — only status code + error fields.

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
      },
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  // Force Account SID + Auth Token (master credentials). The scoped
  // API key in use today carries `messaging/messages/create` but not
  // `messaging/messages/read`, so we'd hit a 70051 if we tried it.
  // Auth Token has full account scope.
  const authUser = accountSid;
  const authPass = authToken;
  const missing = [
    !accountSid && 'TWILIO_ACCOUNT_SID',
    !authToken && 'TWILIO_AUTH_TOKEN (master Auth Token — diagnostic needs read permission, the scoped API key only has create)',
  ].filter(Boolean);
  if (missing.length > 0) {
    return jsonResponse(200, {
      ok: false,
      error: `Twilio not configured: missing ${missing.join(', ')}`,
    });
  }

  let body: { sid?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const sid = (body.sid ?? '').trim();
  if (!sid) return jsonResponse(200, { ok: false, error: 'sid required' });

  const auth = btoa(`${authUser}:${authPass}`);
  let res: Response;
  try {
    res = await fetch(
      `${TWILIO_BASE}/Accounts/${accountSid}/Messages/${sid}.json`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      },
    );
  } catch (e) {
    return jsonResponse(200, {
      ok: false,
      error: `Twilio fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse(200, { ok: false, error: `Twilio non-JSON response (${res.status}): ${text.slice(0, 400)}` });
  }
  return jsonResponse(200, {
    ok: res.ok,
    http: res.status,
    twilio: parsed,
  });
});
