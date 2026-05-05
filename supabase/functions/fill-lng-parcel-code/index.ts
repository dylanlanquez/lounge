// fill-lng-parcel-code
//
// Looks up the parcel code for a dispatched Lounge visit.
//
// Strategy (in order):
//   1. Already in lng_visits.parcel_code → return immediately
//   2. In Checkpoint's shipping_queue (fill-parcel-codes already ran) → write back
//   3. Trigger Checkpoint's fill-parcel-codes to run now, then check again
//
// Called lazily from VisitDetail.tsx when a shipped visit has a
// tracking_number but no parcel_code.
//
// Body: { visit_id: string }
// Response: { ok: true, parcel_code: string | null }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CHECKPOINT_SUPABASE_URL    = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
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

const cpHeaders = {
  Authorization: `Bearer ${CHECKPOINT_SERVICE_ROLE_KEY}`,
  apikey:         CHECKPOINT_SERVICE_ROLE_KEY,
  'Content-Type': 'application/json',
};

async function lookupFromQueue(dispatchRef: string): Promise<string | null> {
  const res = await fetch(
    `${CHECKPOINT_SUPABASE_URL}/rest/v1/shipping_queue?select=parcel_code&cpid=eq.${encodeURIComponent(dispatchRef)}&parcel_code=not.is.null&limit=1`,
    { headers: cpHeaders }
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ parcel_code: string | null }>;
  return rows?.[0]?.parcel_code ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let body: { visit_id?: string };
    try { body = await req.json(); } catch { body = {}; }
    if (!body.visit_id) return json({ ok: false, error: 'visit_id required' }, 400);

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

    // Step 1 — already populated
    if (visit.parcel_code) return json({ ok: true, parcel_code: visit.parcel_code });
    if (!visit.dispatch_ref || !CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
      return json({ ok: true, parcel_code: null });
    }

    // Step 2 — check Checkpoint's shipping_queue
    let parcelCode = await lookupFromQueue(visit.dispatch_ref);

    // Step 3 — Checkpoint queue has no code yet; trigger fill-parcel-codes
    // on Checkpoint then check the queue once more
    if (!parcelCode) {
      await fetch(`${CHECKPOINT_SUPABASE_URL}/functions/v1/fill-parcel-codes`, {
        method:  'POST',
        headers: cpHeaders,
        body:    JSON.stringify({}),
      }).catch(() => {/* non-fatal */});

      // Small wait for the DPD tracking call to complete
      await new Promise((r) => setTimeout(r, 3000));
      parcelCode = await lookupFromQueue(visit.dispatch_ref);
    }

    if (parcelCode) {
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
