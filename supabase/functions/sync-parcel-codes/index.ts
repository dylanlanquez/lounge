// sync-parcel-codes
//
// Server-side batch job. Scheduled via pg_cron every 3 minutes.
//
// Finds every lng_visit that has been dispatched (dispatch_ref IS NOT NULL)
// but whose parcel_code is still null, within the last 7 days. For each,
// reads Checkpoint's shipping_queue (where fill-parcel-codes has written the
// DPD parcel code once DPD's tracking system registered the parcel). When
// the code is available, writes it to lng_visits.parcel_code.
//
// Writing parcel_code fires the Supabase Realtime subscription on lng_visits
// that is open on any visit detail page — no client-side polling required.
//
// Also sends the patient shipping email (deferred from book-lng-shipment when
// parcel_code was not yet available at label-creation time).
//
// Idempotent: safe to call multiple times; the parcel_code update is a no-op
// once set, and shipping_email_sent_at prevents duplicate emails.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { sendShippingEmail } from '../_shared/shippingEmail.ts';

const SUPABASE_URL               = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CHECKPOINT_SUPABASE_URL    = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
const CHECKPOINT_SERVICE_ROLE_KEY = Deno.env.get('CHECKPOINT_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY             = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM                = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const cpHeaders = {
  Authorization: `Bearer ${CHECKPOINT_SERVICE_ROLE_KEY}`,
  apikey:         CHECKPOINT_SERVICE_ROLE_KEY,
  'Content-Type': 'application/json',
};

type PendingVisit = {
  id: string;
  patient_id: string;
  dispatch_ref: string;
  tracking_number: string | null;
  shipping_address: Record<string, string> | null;
  shipping_email_sent_at: string | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: pending, error: fetchErr } = await admin
    .from('lng_visits')
    .select('id, patient_id, dispatch_ref, tracking_number, shipping_address, shipping_email_sent_at')
    .not('dispatch_ref', 'is', null)
    .is('parcel_code', null)
    .gte('dispatched_at', since);

  if (fetchErr) {
    console.error('sync-parcel-codes: fetch failed:', fetchErr.message);
    return new Response(JSON.stringify({ ok: false, error: fetchErr.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const visits = (pending ?? []) as PendingVisit[];
  if (!visits.length) {
    return new Response(JSON.stringify({ ok: true, synced: 0, skipped: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let synced = 0;
  let skipped = 0;

  for (const visit of visits) {
    if (!CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
      skipped++;
      continue;
    }

    const parcelCode = await lookupParcelCode(visit.dispatch_ref);
    if (!parcelCode) { skipped++; continue; }

    const { error: writeErr } = await admin
      .from('lng_visits')
      .update({ parcel_code: parcelCode })
      .eq('id', visit.id);

    if (writeErr) {
      console.error(`sync-parcel-codes: write failed for ${visit.id}:`, writeErr.message);
      skipped++;
      continue;
    }

    synced++;
    // Realtime fires for any open visit detail page — parcel_code link appears automatically.

    await trySendEmail(admin, visit, parcelCode);
  }

  console.log(`sync-parcel-codes: synced=${synced} skipped=${skipped}`);
  return new Response(JSON.stringify({ ok: true, synced, skipped }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});

async function lookupParcelCode(dispatchRef: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${CHECKPOINT_SUPABASE_URL}/rest/v1/shipping_queue?select=parcel_code&cpid=eq.${encodeURIComponent(dispatchRef)}&parcel_code=not.is.null&limit=1`,
      { headers: cpHeaders }
    );
    if (!res.ok) {
      console.error(`sync-parcel-codes: Checkpoint lookup failed (${res.status}) for ${dispatchRef}`);
      return null;
    }
    const rows = await res.json() as Array<{ parcel_code: string | null }>;
    return rows?.[0]?.parcel_code ?? null;
  } catch (e) {
    console.error(`sync-parcel-codes: Checkpoint fetch threw for ${dispatchRef}:`, e);
    return null;
  }
}

async function trySendEmail(
  admin: ReturnType<typeof createClient>,
  visit: PendingVisit,
  parcelCode: string,
): Promise<void> {
  if (visit.shipping_email_sent_at) return;

  if (!RESEND_API_KEY) {
    console.warn('sync-parcel-codes: RESEND_API_KEY is not set — email skipped');
    return;
  }

  const { data: patientRow } = await admin
    .from('patients')
    .select('email, first_name')
    .eq('id', visit.patient_id)
    .maybeSingle();
  const patient = patientRow as { email: string | null; first_name: string | null } | null;

  if (!patient?.email) {
    console.warn(`sync-parcel-codes: no email on patient for visit ${visit.id}`);
    return;
  }

  // Atomic claim — prevents duplicate sends if cron fires twice before completion
  const now = new Date().toISOString();
  const { data: claimed } = await admin
    .from('lng_visits')
    .update({ shipping_email_sent_at: now })
    .eq('id', visit.id)
    .is('shipping_email_sent_at', null)
    .select('id');

  if (!claimed?.length) return; // another concurrent call won the race

  const sent = await sendShippingEmail(admin, {
    visitId:          visit.id,
    patientEmail:     patient.email,
    patientFirstName: patient.first_name,
    trackingNumber:   visit.tracking_number,
    parcelCode,
    shippingAddress:  visit.shipping_address as { name?: string; address1?: string; address2?: string; city?: string; zip?: string } | null,
    items:            [],
    dispatchRef:      visit.dispatch_ref,
    resendApiKey:     RESEND_API_KEY,
    resendFrom:       RESEND_FROM,
  });

  if (sent) {
    console.log(`sync-parcel-codes: shipping email sent for visit ${visit.id}`);
  } else {
    // Roll back claim so the next cron run retries
    await admin.from('lng_visits').update({ shipping_email_sent_at: null }).eq('id', visit.id);
    console.error(`sync-parcel-codes: email send failed for visit ${visit.id} — will retry next cycle`);
  }
}
