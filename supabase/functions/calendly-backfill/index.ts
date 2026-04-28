// calendly-backfill
//
// Admin-triggered. Pulls scheduled_events from Calendly's API for a time window
// and replays each through the same logic as calendly-webhook would on an
// invitee.created delivery. Used for:
//   - First-time bootstrap (no live webhooks yet)
//   - Replay after a webhook outage
//
// Auth model: anon-key Bearer JWT (per brief §8.5). The function is also
// authorized at the application level by checking the caller is an admin —
// using is_admin() RLS via a service-role probe.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const CALENDLY_PAT = Deno.env.get('CALENDLY_PAT') ?? '';

const EDGE_HEADERS = {
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' },
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!CALENDLY_PAT) {
    return jsonResponse(500, { ok: false, error: 'CALENDLY_PAT not set' });
  }

  // Caller must be an admin in Meridian. Use the user's JWT to read accounts.
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return jsonResponse(401, { ok: false, error: 'No bearer token' });

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: meRows, error: meErr } = await userClient.rpc('is_admin');
  if (meErr || meRows !== true) {
    return jsonResponse(403, { ok: false, error: 'Admin only' });
  }

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: { action?: 'backfill' | 'verify'; since?: string; until?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Step 1: resolve the connected Calendly user URI (used by both actions)
  const me = await calendly('GET', '/users/me');
  if (!me.ok) return jsonResponse(502, { ok: false, error: 'Calendly /users/me failed', detail: me.body });
  const userUri = me.body?.resource?.uri as string | undefined;
  const orgUri = me.body?.resource?.current_organization as string | undefined;
  if (!userUri) return jsonResponse(502, { ok: false, error: 'No user URI in /users/me' });

  // action=verify → list webhook subscriptions and tell the UI which (if any)
  // points at this project's calendly-webhook function.
  if (body.action === 'verify') {
    const expectedUrl = `${SUPABASE_URL.replace('https://', 'https://').replace(
      '.supabase.co',
      '.functions.supabase.co'
    )}/calendly-webhook`;
    const subs = await calendly(
      'GET',
      `/webhook_subscriptions?organization=${encodeURIComponent(orgUri ?? '')}&user=${encodeURIComponent(userUri)}&scope=user`
    );
    if (!subs.ok) {
      return jsonResponse(502, { ok: false, error: 'webhook_subscriptions failed', detail: subs.body });
    }
    const list = (subs.body?.collection ?? []) as Array<{
      uri?: string;
      callback_url?: string;
      events?: string[];
      state?: string;
      created_at?: string;
      retry_started_at?: string | null;
    }>;
    const matching = list.filter((s) => s.callback_url === expectedUrl);
    return jsonResponse(200, {
      ok: true,
      action: 'verify',
      expectedUrl,
      userUri,
      orgUri,
      subscriptionsTotal: list.length,
      subscriptionsMatching: matching.length,
      activeMatching: matching.filter((s) => s.state === 'active').length,
      subscriptions: list.map((s) => ({
        uri: s.uri,
        callback_url: s.callback_url,
        events: s.events,
        state: s.state,
        created_at: s.created_at,
        retry_started_at: s.retry_started_at,
        matchesProject: s.callback_url === expectedUrl,
      })),
    });
  }

  // Default action: backfill. Window past 30d..future 60d.
  const since = body.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const until = body.until ?? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  // Step 2: paginate scheduled_events
  let pageToken: string | undefined = undefined;
  let totalReceived = 0;
  let totalApplied = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < 50; i++) {
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', userUri);
    url.searchParams.set('min_start_time', since);
    url.searchParams.set('max_start_time', until);
    url.searchParams.set('count', '100');
    url.searchParams.set('status', 'active');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const events = await calendly('GET', url.pathname + url.search);
    if (!events.ok) {
      errors.push(`scheduled_events page ${i}: ${JSON.stringify(events.body)}`);
      break;
    }
    const collection = (events.body?.collection ?? []) as Array<{
      uri: string;
      name: string;
      start_time: string;
      end_time: string;
      event_type: string;
    }>;
    totalReceived += collection.length;

    // For each event, fetch invitees and synthesise an invitee.created.
    for (const evt of collection) {
      const eventUuid = evt.uri.split('/').pop()!;
      const invs = await calendly('GET', `/scheduled_events/${eventUuid}/invitees?count=100`);
      if (!invs.ok) {
        errors.push(`invitees ${eventUuid}: ${JSON.stringify(invs.body)}`);
        continue;
      }
      const invitees = (invs.body?.collection ?? []) as Array<{
        uri: string;
        email: string;
        first_name?: string;
        last_name?: string;
        name?: string;
      }>;
      for (const inv of invitees) {
        try {
          const outcome = await applyInvitee(supabase, evt, inv);
          if (outcome === 'skipped') totalSkipped++;
          else totalApplied++;
        } catch (e) {
          errors.push(`apply ${inv.uri}: ${(e as Error).message}`);
        }
      }
    }

    pageToken = events.body?.pagination?.next_page_token;
    if (!pageToken) break;
  }

  return jsonResponse(200, {
    ok: true,
    since,
    until,
    received: totalReceived,
    applied: totalApplied,
    skipped: totalSkipped,
    errors,
  });
});

async function applyInvitee(
  supabase: SupabaseClient,
  evt: { uri: string; name: string; start_time: string; end_time: string },
  inv: { uri: string; email: string; first_name?: string; last_name?: string; name?: string }
): Promise<'applied' | 'skipped'> {
  // Default location
  const { data: locRow } = await supabase
    .from('locations')
    .select('id')
    .eq('type', 'lab')
    .eq('is_venneir', true)
    .order('name')
    .limit(1)
    .maybeSingle();
  if (!locRow) throw new Error('no Venneir lab location');
  const location_id = (locRow as { id: string }).id;

  const firstName = inv.first_name ?? splitName(inv.name).first;
  const lastName = inv.last_name ?? splitName(inv.name).last;
  const email = inv.email?.toLowerCase().trim();

  // Identity resolve
  let patient_id: string | null = null;
  if (email) {
    const { data: ex } = await supabase
      .from('patients')
      .select('id, first_name, last_name')
      .eq('location_id', location_id)
      .ilike('email', email)
      .maybeSingle();
    if (ex) {
      patient_id = (ex as { id: string }).id;
      // Fill-blanks: only fill name fields if currently null (never overwrite).
      const cur = ex as { first_name: string | null; last_name: string | null };
      const patch: Record<string, string> = {};
      if (cur.first_name == null && firstName) patch.first_name = firstName;
      if (cur.last_name == null && lastName) patch.last_name = lastName;
      if (Object.keys(patch).length > 0) {
        await supabase.from('patients').update(patch).eq('id', patient_id);
      }
    }
  }
  if (!patient_id) {
    const account_id = await resolveDefaultAccountId(supabase, location_id);
    const { data: created, error: createErr } = await supabase
      .from('patients')
      .insert({
        account_id,
        location_id,
        first_name: firstName || 'Patient',
        last_name: lastName || '',
        email,
      })
      .select('id')
      .single();
    if (createErr || !created) throw new Error(createErr?.message ?? 'create patient failed');
    patient_id = (created as { id: string }).id;
  }

  const { error: apptErr } = await supabase.from('lng_appointments').insert({
    patient_id,
    location_id,
    source: 'calendly',
    calendly_event_uri: evt.uri,
    calendly_invitee_uri: inv.uri,
    start_at: evt.start_time,
    end_at: evt.end_time,
    event_type_label: evt.name,
    status: 'booked',
  });
  // 23505 == unique violation on calendly_invitee_uri (already imported). Treat
  // as a skip — backfill is idempotent by design.
  if (apptErr) {
    if (apptErr.code === '23505') return 'skipped';
    throw new Error(apptErr.message);
  }
  return 'applied';
}

async function calendly(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ ok: boolean; body: { [k: string]: unknown } }> {
  const r = await fetch(`https://api.calendly.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CALENDLY_PAT}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: { [k: string]: unknown } = {};
  try {
    parsed = await r.json();
  } catch {
    parsed = {};
  }
  return { ok: r.ok, body: parsed };
}

async function resolveDefaultAccountId(supabase: SupabaseClient, location_id: string): Promise<string> {
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

function splitName(name?: string): { first: string; last: string } {
  if (!name) return { first: '', last: '' };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...EDGE_HEADERS,
    },
  });
}
