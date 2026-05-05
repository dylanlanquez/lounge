// fill-lng-parcel-code
//
// Looks up the parcel code for a dispatched Lounge visit by checking
// Checkpoint's shipping_queue (where fill-parcel-codes has already
// populated it). If found, writes it back to lng_visits.parcel_code.
//
// Called lazily from VisitDetail.tsx when a shipped visit has a
// tracking_number but no parcel_code — DPD doesn't always return the
// parcel code immediately at label creation time.
//
// Body: { visit_id: string }
// Response: { ok: true, parcel_code: string | null }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CHECKPOINT_SUPABASE_URL   = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
const CHECKPOINT_SERVICE_ROLE_KEY = Deno.env.get('CHECKPOINT_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let body: { visit_id?: string };
    try { body = await req.json(); } catch { body = {}; }

    if (!body.visit_id) return json({ ok: false, error: 'visit_id required' }, 400);

    // Load the visit — check it actually needs a parcel code
    const { data: visitRow } = await admin
      .from('lng_visits')
      .select('id, dispatch_ref, tracking_number, parcel_code')
      .eq('id', body.visit_id)
      .maybeSingle();

    if (!visitRow) return json({ ok: false, error: 'Visit not found' }, 404);

    const visit = visitRow as {
      id: string;
      dispatch_ref: string | null;
      tracking_number: string | null;
      parcel_code: string | null;
    };

    // Already populated — nothing to do
    if (visit.parcel_code) return json({ ok: true, parcel_code: visit.parcel_code });
    if (!visit.dispatch_ref) return json({ ok: true, parcel_code: null });

    if (!CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
      return json({ ok: false, error: 'Checkpoint env vars not set' });
    }

    // Look up in Checkpoint's shipping_queue where cpid = dispatch_ref
    const cpRes = await fetch(
      `${CHECKPOINT_SUPABASE_URL}/rest/v1/shipping_queue?select=parcel_code&cpid=eq.${encodeURIComponent(visit.dispatch_ref)}&parcel_code=not.is.null&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${CHECKPOINT_SERVICE_ROLE_KEY}`,
          apikey:         CHECKPOINT_SERVICE_ROLE_KEY,
        },
      }
    );

    if (!cpRes.ok) {
      return json({ ok: true, parcel_code: null });
    }

    const cpRows = await cpRes.json() as Array<{ parcel_code: string | null }>;
    const parcelCode = cpRows?.[0]?.parcel_code ?? null;

    if (parcelCode) {
      // Write back so this lookup only runs once
      await admin
        .from('lng_visits')
        .update({ parcel_code: parcelCode })
        .eq('id', body.visit_id);
    }

    return json({ ok: true, parcel_code: parcelCode });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
