// book-lng-shipment
//
// Creates a DPD shipment for a completed Lounge visit and stamps the
// dispatch metadata back onto lng_visits. Also cross-posts a row into
// Checkpoint's shipping_queue (LWO pipeline) and sends the patient a
// shipping notification email if the visit_shipped template is enabled.
//
// Auth: anon-key Bearer JWT (signed-in staff). Accepts an internal
// service-role call from other edge functions.
//
// Body:
//   {
//     visit_id:         uuid        — required
//     shipping_address: {
//       name:        string          — max 35 chars (DPD)
//       address1:    string          — max 35 chars
//       address2?:   string          — max 35 chars
//       city:        string          — max 35 chars
//       zip:         string          — postcode
//       country_code?: string        — defaults 'GB'
//       phone?:      string
//     }
//     items:    string[]            — display labels for items being shipped
//     staff_name: string            — displayed on shipped card + Checkpoint row
//   }
//
// Response:
//   { ok: true, dispatch_ref, tracking_number, label_data }
//   { ok: false, error }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
import { sendShippingEmail } from '../_shared/shippingEmail.ts';

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY                 = Deno.env.get('SUPABASE_ANON_KEY')!;

// DPD calls are proxied through Checkpoint's edge function which runs on
// the IP already whitelisted with DPD. Direct calls from this project's
// egress IP are rejected by DPD's IP allowlist.

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM    = Deno.env.get('RESEND_FROM_BOOKING') ?? 'Venneir Lounge <lounge@venneir.com>';

const CHECKPOINT_SUPABASE_URL        = Deno.env.get('CHECKPOINT_SUPABASE_URL') ?? '';
const CHECKPOINT_SERVICE_ROLE_KEY    = Deno.env.get('CHECKPOINT_SERVICE_ROLE_KEY') ?? '';

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


function generateDispatchRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'LVO-';
  for (let i = 0; i < 8; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  try {
    return await handle(req);
  } catch (e) {
    return json({ ok: false, error: `book-lng-shipment crashed: ${e instanceof Error ? e.message : String(e)}` });
  }
});

async function handle(req: Request): Promise<Response> {
  // Auth
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return json({ ok: false, error: 'No bearer token' }, 401);

  const isInternal = userJwt === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  if (!isInternal) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: userJwt } },
    });
    const { data: who } = await userClient.auth.getUser();
    if (!who?.user) return json({ ok: false, error: 'Not signed in' }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: {
    visit_id?: string;
    shipping_address?: {
      name?: string;
      address1?: string;
      address2?: string;
      city?: string;
      zip?: string;
      country_code?: string;
      phone?: string;
    };
    items?: Array<{ name: string; qty: number; arch: string | null }>;
    staff_name?: string;
  };
  try { body = await req.json(); } catch { body = {}; }

  const { visit_id, shipping_address, items = [], staff_name = '' } = body;

  // Arch suffix used for both email labels and Checkpoint product names
  const archSuffix = (arch: string | null | undefined): string => {
    if (arch === 'both') return ' (upper & lower)';
    if (arch === 'upper') return ' (upper)';
    if (arch === 'lower') return ' (lower)';
    return '';
  };
  // Human-readable labels for the email body
  const itemLabels = items.map((it) =>
    `${it.name}${archSuffix(it.arch)}${it.qty > 1 ? ` × ${it.qty}` : ''}`
  );
  // Structured rows for Checkpoint's dispatched_products column.
  // ShippingQueueView reads p.label || p.name and p.qty.
  const dispatchedProducts = items.map((it) => ({
    label:        `${it.name}${archSuffix(it.arch)}`,
    qty:          it.qty,
    book_in_type: null,
  }));

  if (!visit_id)                  return json({ ok: false, error: 'visit_id required' }, 400);
  if (!shipping_address?.zip)     return json({ ok: false, error: 'shipping address / postcode required' }, 400);
  if (!shipping_address?.address1) return json({ ok: false, error: 'address line 1 required' }, 400);

  // Load visit + patient
  const { data: visitRow, error: vErr } = await admin
    .from('lng_visits')
    .select('id, patient_id, fulfilment_method, status, dispatch_ref, jb_ref')
    .eq('id', visit_id)
    .maybeSingle();
  if (vErr || !visitRow) return json({ ok: false, error: 'Visit not found' }, 404);

  const visit = visitRow as {
    id: string;
    patient_id: string;
    fulfilment_method: string | null;
    status: string;
    dispatch_ref: string | null;
    jb_ref: string | null;
  };

  if (visit.fulfilment_method !== 'shipping') {
    return json({ ok: false, error: 'Visit fulfilment method is not shipping' }, 400);
  }
  if (visit.dispatch_ref) {
    return json({ ok: false, error: 'Visit already dispatched', dispatch_ref: visit.dispatch_ref }, 409);
  }

  const { data: patientRow } = await admin
    .from('patients')
    .select('first_name, last_name, email, phone, lwo_ref')
    .eq('id', visit.patient_id)
    .maybeSingle();
  const patient = patientRow as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    lwo_ref: string | null;
  } | null;

  // ── DPD: book via Checkpoint proxy ──────────────────────────────────────
  // Checkpoint's book-dpd-shipment function runs on an IP already whitelisted
  // with DPD. We call it with the service-role key (same pattern as the
  // shipping_queue insert below).
  const dispatch_ref = generateDispatchRef();

  let trackingNumber: string | null = null;
  let parcelCode: string | null = null;
  let shipmentId: string | null = null;
  let labelData: string | null = null;

  if (!CHECKPOINT_SUPABASE_URL || !CHECKPOINT_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'CHECKPOINT_SUPABASE_URL / CHECKPOINT_SERVICE_ROLE_KEY not set' });
  }

  const dpdRes = await fetch(`${CHECKPOINT_SUPABASE_URL}/functions/v1/book-dpd-shipment`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${CHECKPOINT_SERVICE_ROLE_KEY}`,
      apikey:          CHECKPOINT_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shippingAddress: {
        name:         (shipping_address.name || `${patient?.first_name ?? ''} ${patient?.last_name ?? ''}`.trim() || 'Customer'),
        address1:     shipping_address.address1 ?? '',
        address2:     shipping_address.address2 ?? '',
        city:         shipping_address.city     ?? '',
        zip:          shipping_address.zip      ?? '',
        country_code: shipping_address.country_code ?? 'GB',
        phone:        shipping_address.phone    ?? '',
      },
      customerEmail: patient?.email ?? '',
      customerPhone: patient?.phone ?? '',
      orderName:     dispatch_ref,
    }),
  });

  if (!dpdRes.ok) {
    const errText = await dpdRes.text().catch(() => '');
    return json({ ok: false, error: `DPD booking failed (${dpdRes.status}): ${errText.slice(0, 300)}` });
  }

  const dpdData = await dpdRes.json() as {
    success?: boolean;
    trackingNumber?: string | null;
    shipmentId?: string | null;
    labelData?: string | null;
    parcelCode?: string | null;
    error?: string;
  };

  if (!dpdData.success) {
    return json({ ok: false, error: `DPD booking error: ${dpdData.error ?? 'unknown'}` });
  }

  trackingNumber = dpdData.trackingNumber ?? null;
  parcelCode     = dpdData.parcelCode     ?? null;
  shipmentId     = dpdData.shipmentId     ?? null;
  labelData      = dpdData.labelData      ?? null;
  // DPD failure is non-fatal for the record — we stamp what we have and
  // surface status in the shipped card. Staff can re-trigger later.

  const now        = new Date().toISOString();
  const addrSnapshot = {
    name:         shipping_address.name     ?? '',
    address1:     shipping_address.address1 ?? '',
    address2:     shipping_address.address2 ?? '',
    city:         shipping_address.city     ?? '',
    zip:          shipping_address.zip      ?? '',
    country_code: shipping_address.country_code ?? 'GB',
    phone:        shipping_address.phone    ?? '',
  };

  // ── Update lng_visits ────────────────────────────────────────────────────
  const { error: updateErr } = await admin
    .from('lng_visits')
    .update({
      dispatched_at:    now,
      dispatched_by:    staff_name || null,
      tracking_number:  trackingNumber,
      parcel_code:      parcelCode,
      shipment_id:      shipmentId,
      label_data:       labelData,
      shipping_address: addrSnapshot,
      dispatch_ref,
    })
    .eq('id', visit_id);

  if (updateErr) {
    console.error('lng_visits update failed:', updateErr.message);
    return json({ ok: false, error: `Failed to save dispatch: ${updateErr.message}` }, 500);
  }

  // ── Patient event ────────────────────────────────────────────────────────
  await admin.from('patient_events').insert({
    patient_id: visit.patient_id,
    event_type:  'visit_shipped',
    payload: {
      visit_id,
      dispatch_ref,
      tracking_number: trackingNumber,
      dispatched_by:   staff_name,
      items:           itemLabels,
    },
  });

  // ── Checkpoint shipping_queue insert ─────────────────────────────────────
  if (CHECKPOINT_SUPABASE_URL && CHECKPOINT_SERVICE_ROLE_KEY) {
    const cpSb = {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${CHECKPOINT_SERVICE_ROLE_KEY}`,
      apikey:          CHECKPOINT_SERVICE_ROLE_KEY,
    };
    const lwoRef       = patient?.lwo_ref ?? null;
    const orderName    = lwoRef ? `LWO-${lwoRef}` : dispatch_ref;
    const customerName = `${patient?.first_name ?? ''} ${patient?.last_name ?? ''}`.trim() || 'Unknown';

    const cpRow = {
      cpid:                 dispatch_ref,
      order_id:             null,
      order_name:           orderName,
      customer_name:        customerName,
      product_type:         'completed_product',
      delivery_method:      'DPD Local',
      country:              shipping_address.country_code ?? 'GB',
      postcode:             (shipping_address.zip ?? '').trim(),
      status:               labelData ? 'printed' : (trackingNumber ? 'pending' : 'print_error'),
      label_data:           labelData,
      label_html:           null,
      tracking_number:      trackingNumber ?? '',
      shipment_id:          shipmentId ?? '',
      slot_id:              null,
      dispatched_products:  dispatchedProducts,
      shopify_line_item_ids:[],
      shopify_sync:         'skipped',
      created_by:           staff_name || 'Lounge',
      created_at:           now,
    };

    const cpInsert = await fetch(`${CHECKPOINT_SUPABASE_URL}/rest/v1/shipping_queue`, {
      method:  'POST',
      headers: { ...cpSb, Prefer: 'return=representation' },
      body: JSON.stringify(cpRow),
    });
    if (!cpInsert.ok) {
      const cpBody = await cpInsert.text().catch(() => '');
      console.error(`Checkpoint shipping_queue insert failed (${cpInsert.status}):`, cpBody.slice(0, 300));
    }

    // If we don't have the parcel code yet (DPD can take a moment to register
    // the parcel in their tracking system), trigger Checkpoint's fill-parcel-codes
    // now and wait for it before sending the patient email. This guarantees the
    // email always contains the correct tracking URL.
    if (!parcelCode && trackingNumber) {
      await fetch(`${CHECKPOINT_SUPABASE_URL}/functions/v1/fill-parcel-codes`, {
        method:  'POST',
        headers: { ...cpSb, 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      }).catch((e) => console.error('fill-parcel-codes trigger failed (non-fatal):', e));

      // Allow time for the DPD tracking call inside fill-parcel-codes to complete
      await new Promise((r) => setTimeout(r, 4000));

      // Read back the parcel code that fill-parcel-codes just wrote
      const qRes = await fetch(
        `${CHECKPOINT_SUPABASE_URL}/rest/v1/shipping_queue?select=parcel_code&cpid=eq.${encodeURIComponent(dispatch_ref)}&parcel_code=not.is.null&limit=1`,
        { headers: cpSb }
      ).catch(() => null);
      if (qRes?.ok) {
        const qRows = await qRes.json().catch(() => []) as Array<{ parcel_code: string | null }>;
        const fetched = qRows?.[0]?.parcel_code ?? null;
        if (fetched) {
          parcelCode = fetched;
          // Persist it so the visit page shows the correct link immediately
          await admin.from('lng_visits').update({ parcel_code: parcelCode }).eq('id', visit_id);
        }
      }
    }
  }

  // ── Send patient email (only when parcel_code is confirmed) ─────────────
  // Sending with just tracking_number builds a broken DPD URL. If
  // parcel_code is still null here, fill-lng-parcel-code will send the
  // email atomically once it resolves the code.
  if (parcelCode && patient?.email && RESEND_API_KEY) {
    // Atomic claim: only send if shipping_email_sent_at is still null.
    const { data: claimed } = await admin
      .from('lng_visits')
      .update({ shipping_email_sent_at: now })
      .eq('id', visit_id)
      .is('shipping_email_sent_at', null)
      .select('id');

    if (claimed && claimed.length > 0) {
      await sendShippingEmail(admin, {
        visitId:          visit_id,
        patientEmail:     patient.email,
        patientFirstName: patient.first_name,
        trackingNumber,
        parcelCode,
        shippingAddress:  addrSnapshot,
        items:            itemLabels,
        dispatchRef:      dispatch_ref,
        resendApiKey:     RESEND_API_KEY,
        resendFrom:       RESEND_FROM,
      }).catch((e) => console.error('Resend dispatch email failed:', e));
    }
  } else if (!parcelCode) {
    console.log(`book-lng-shipment: parcel_code not yet available for ${dispatch_ref}; email deferred to fill-lng-parcel-code`);
  }

  return json({
    ok: true,
    dispatch_ref,
    tracking_number: trackingNumber,
    shipment_id:     shipmentId,
    label_data:      labelData,
  });
}

