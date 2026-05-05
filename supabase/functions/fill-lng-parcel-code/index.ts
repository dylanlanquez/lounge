// fill-lng-parcel-code
//
// Looks up the parcel code for a dispatched Lounge visit and writes it back.
// Also sends the patient shipping email if it hasn't been sent yet.
//
// Strategy (in order):
//   1. Already in lng_visits.parcel_code → return immediately
//   2. In Checkpoint's shipping_queue (fill-parcel-codes already ran) → write back
//   3. Trigger Checkpoint's fill-parcel-codes to run now, then check again
//
// Email: If parcel_code is resolved here and shipping_email_sent_at is null,
// atomically claims the send slot and dispatches the notification email.
//
// Called by the VisitDetail page every 30 s while parcel_code is null.
//
// Body: { visit_id: string }
// Response: { ok: true, parcel_code: string | null, email_sent: boolean }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { sendShippingEmail } from '../_shared/shippingEmail.ts';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CHECKPOINT_SUPABASE_URL    = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
const CHECKPOINT_SERVICE_ROLE_KEY = Deno.env.get('CHECKPOINT_SERVICE_ROLE_KEY') ?? '';
const RESEND_API_KEY             = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM                = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';

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
      .select('id, patient_id, dispatch_ref, tracking_number, parcel_code, shipping_address, shipping_email_sent_at')
      .eq('id', body.visit_id)
      .maybeSingle();

    if (!visitRow) return json({ ok: false, error: 'Visit not found' }, 404);
    const visit = visitRow as {
      id: string;
      patient_id: string;
      dispatch_ref: string | null;
      tracking_number: string | null;
      parcel_code: string | null;
      shipping_address: Record<string, string> | null;
      shipping_email_sent_at: string | null;
    };

    // Step 1 — already populated
    if (visit.parcel_code) {
      // Email may still be pending if book-lng-shipment skipped it
      const emailSent = await maybeEmail(admin, visit, visit.parcel_code);
      return json({ ok: true, parcel_code: visit.parcel_code, email_sent: emailSent });
    }
    if (!visit.dispatch_ref || !CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
      return json({ ok: true, parcel_code: null, email_sent: false });
    }

    // Step 2 — check Checkpoint's shipping_queue
    let parcelCode = await lookupFromQueue(visit.dispatch_ref);

    // Step 3 — Checkpoint queue has no code yet; trigger fill-parcel-codes
    if (!parcelCode) {
      await fetch(`${CHECKPOINT_SUPABASE_URL}/functions/v1/fill-parcel-codes`, {
        method:  'POST',
        headers: cpHeaders,
        body:    JSON.stringify({}),
      }).catch(() => {/* non-fatal */});

      await new Promise((r) => setTimeout(r, 3000));
      parcelCode = await lookupFromQueue(visit.dispatch_ref);
    }

    let emailSent = false;
    if (parcelCode) {
      // Write parcel_code back so Realtime updates the visit page
      await admin
        .from('lng_visits')
        .update({ parcel_code: parcelCode })
        .eq('id', body.visit_id);

      emailSent = await maybeEmail(admin, visit, parcelCode);
    }

    return json({ ok: true, parcel_code: parcelCode, email_sent: emailSent });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Atomically claims the email send slot (sets shipping_email_sent_at)
// then sends the notification. Returns true if email was sent this call.
async function maybeEmail(
  admin: ReturnType<typeof createClient>,
  visit: {
    id: string;
    patient_id: string;
    tracking_number: string | null;
    shipping_address: Record<string, string> | null;
    shipping_email_sent_at: string | null;
  },
  parcelCode: string,
): Promise<boolean> {
  if (visit.shipping_email_sent_at || !RESEND_API_KEY) return false;

  // Read patient email
  const { data: patientRow } = await admin
    .from('patients')
    .select('email, first_name')
    .eq('id', visit.patient_id)
    .maybeSingle();
  const patient = patientRow as { email: string | null; first_name: string | null } | null;
  if (!patient?.email) return false;

  // Read the visit's dispatch_ref (needed for the email template)
  const { data: visitFull } = await admin
    .from('lng_visits')
    .select('dispatch_ref')
    .eq('id', visit.id)
    .maybeSingle();
  const dispatchRef = (visitFull as { dispatch_ref: string | null } | null)?.dispatch_ref ?? '';

  // Atomic claim — only one concurrent call can win this
  const now = new Date().toISOString();
  const { data: claimed } = await admin
    .from('lng_visits')
    .update({ shipping_email_sent_at: now })
    .eq('id', visit.id)
    .is('shipping_email_sent_at', null)
    .select('id');

  if (!claimed || claimed.length === 0) return false; // another call already sent it

  const sent = await sendShippingEmail(admin, {
    visitId:          visit.id,
    patientEmail:     patient.email,
    patientFirstName: patient.first_name,
    trackingNumber:   visit.tracking_number,
    parcelCode,
    shippingAddress:  visit.shipping_address,
    items:            [], // generic fallback used by sendShippingEmail
    dispatchRef,
    resendApiKey:     RESEND_API_KEY,
    resendFrom:       RESEND_FROM,
  });

  if (!sent) {
    // Roll back the claim so another attempt can retry
    await admin
      .from('lng_visits')
      .update({ shipping_email_sent_at: null })
      .eq('id', visit.id);
  }

  return sent;
}
