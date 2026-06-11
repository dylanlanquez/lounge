// recover-patient-names
//
// One-off / batched recovery of patient names polluted by the historical
// Shopify-orders-webhook bug, which stamped the literal first name
// "Customer" (and a blank last name) whenever a Shopify order's customer
// object had no name — the norm for express checkouts, where the real
// name sits on the shipping/billing address. ~31% of patients carry the
// placeholder. The webhook + widget are fixed going forward; this
// function repairs the existing rows.
//
// Auth: a shared secret. The caller must send  x-recovery-token: <token>
// matching the RECOVERY_TOKEN secret. Deployed with --no-verify-jwt so
// the gateway lets the call through; the token is the real gate. Refuses
// if RECOVERY_TOKEN is unset (fail loud, never run open).
//
// Modes (POST JSON body):
//   { mode: "targeted", patient_id }
//       Recover one patient. Tries Stripe first (the billing name on
//       their most recent appointment deposit PaymentIntent — the most
//       reliable real name for a booked customer), then Shopify
//       (customer record / default address / latest order addresses).
//
//   { mode: "bulk", limit?, after_id? }
//       Walk patients with a placeholder/blank name AND a
//       shopify_customer_id, ordered by id, id > after_id. Recover each
//       from Shopify only (Stripe per-row would be far too slow at
//       scale). Returns next_after_id so the caller can page through.
//
// Fill-blanks only: a real stored name is never overwritten. A blank or
// the legacy "Customer"/"Patient" placeholder counts as blank. We never
// invent a placeholder — first_name/last_name are NOT NULL, so the
// canonical "no name" is '' (the app renders it as a dash and falls back
// to the email for display).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RECOVERY_TOKEN = Deno.env.get('RECOVERY_TOKEN') ?? '';
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const SHOPIFY_TOKEN =
  Deno.env.get('SHOPIFY_VENNEIR_ADMIN_TOKEN') ?? Deno.env.get('SHOPIFY_TOKEN') ?? '';
const SHOPIFY_SHOP = normaliseShop(
  Deno.env.get('SHOPIFY_VENNEIR_SHOP') ?? Deno.env.get('SHOPIFY_STORE') ?? 'venneir.myshopify.com',
);
const SHOPIFY_API_VERSION = Deno.env.get('SHOPIFY_API_VERSION') ?? '2025-07';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-recovery-token',
};

function normaliseShop(raw: string): string {
  let s = raw.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return s;
}

// ── name helpers (mirror _shared/patientName.ts + the webhook) ──
function isBlankName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' || v === 'customer' || v === 'patient';
}
function splitName(name: string | undefined | null): { first: string; last: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

interface NameCandidate {
  first: string;
  last: string;
  source: string;
}

// First candidate that carries any name wins (keeps first+last paired).
function pickName(candidates: NameCandidate[]): NameCandidate | null {
  return candidates.find((c) => c.first.trim() !== '' || c.last.trim() !== '') ?? null;
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

    if (!RECOVERY_TOKEN) return json(500, { ok: false, error: 'RECOVERY_TOKEN not configured' });
    const token = req.headers.get('x-recovery-token') ?? '';
    if (token !== RECOVERY_TOKEN) return json(401, { ok: false, error: 'bad recovery token' });

    let body: { mode?: string; patient_id?: string; limit?: number; after_id?: string } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (body.mode === 'targeted') {
      if (!body.patient_id) return json(400, { ok: false, error: 'patient_id required' });
      const result = await recoverOne(admin, body.patient_id, true);
      return json(200, { ok: true, ...result });
    }

    if (body.mode === 'stripe_shape') {
      // Sample recent Stripe charges to see whether billing_details
      // carries name + email (would make an enumeration recovery viable).
      const res = await fetch('https://api.stripe.com/v1/charges?limit=20', {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
      });
      const data = res.ok ? await res.json() : { error: res.status };
      const rows = (data?.data ?? []).map((c: any) => ({
        created: c.created,
        bemail: c?.billing_details?.email ?? null,
        bname: c?.billing_details?.name ?? null,
        remail: c?.receipt_email ?? null,
      }));
      const withName = rows.filter((r: any) => r.bname).length;
      const withEmailAndName = rows.filter((r: any) => r.bname && r.bemail).length;
      return json(200, { ok: true, sampled: rows.length, withName, withEmailAndName, sample: rows.slice(0, 8) });
    }

    if (body.mode === 'diag') {
      // Diagnostics: granted Shopify scopes + per-customer order counts,
      // so we can tell "no Shopify order at all" from "orders hidden by
      // the 60-day / read_all_orders limit".
      const cid = body.patient_id ?? null;
      const scopesRes = await fetch(
        `https://${SHOPIFY_SHOP}/admin/oauth/access_scopes.json`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } },
      );
      const scopes = scopesRes.ok ? await scopesRes.json() : { error: scopesRes.status };
      let customer: unknown = null;
      if (cid) {
        const d = await shopifyGraphql(
          `query($id: ID!){ customer(id:$id){ numberOfOrders firstName lastName email
             orders(first:3, sortKey: CREATED_AT, reverse:true){ nodes{ createdAt
               shippingAddress{ firstName lastName name } billingAddress{ firstName lastName name } } } } }`,
          { id: `gid://shopify/Customer/${cid}` },
        );
        customer = d?.data?.customer ?? d?.errors ?? null;
      }
      return json(200, { ok: true, shop: SHOPIFY_SHOP, scopes, customer });
    }

    if (body.mode === 'probe') {
      // Debug: name candidates for a customer id and/or email, across
      // Shopify (orders/customer) and Stripe (charges by email).
      const cid = body.patient_id ?? null;
      const email = (body as { email?: string }).email ?? null;
      const shopify = await shopifyNameCandidates(cid, email);
      const stripe = email ? await stripeNameByEmail(email) : null;
      const all = [...shopify];
      if (stripe) all.push({ ...stripe, source: 'stripe_email' });
      return json(200, { ok: true, picked: pickName(all), shopify, stripe });
    }

    if (body.mode === 'bulk') {
      const limit = Math.min(Math.max(body.limit ?? 50, 1), 250);
      const out = await recoverBulk(admin, limit, body.after_id ?? null);
      return json(200, { ok: true, ...out });
    }

    return json(400, { ok: false, error: 'mode must be "targeted" or "bulk"' });
  } catch (e) {
    return json(200, {
      ok: false,
      error: `recover-patient-names crashed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    });
  }
});

// ── Recover a single patient ──
async function recoverOne(
  admin: SupabaseClient,
  patientId: string,
  allowStripe: boolean,
): Promise<Record<string, unknown>> {
  const { data: p } = await admin
    .from('patients')
    .select('id, first_name, last_name, email, shopify_customer_id, portal_ship_name')
    .eq('id', patientId)
    .maybeSingle();
  if (!p) return { patient_id: patientId, status: 'not_found' };

  const patient = p as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    shopify_customer_id: string | null;
    portal_ship_name: string | null;
  };

  const firstBlank = isBlankName(patient.first_name);
  const lastBlank = isBlankName(patient.last_name);
  if (!firstBlank && !lastBlank) {
    return { patient_id: patientId, status: 'already_named', first_name: patient.first_name, last_name: patient.last_name };
  }

  const candidates: NameCandidate[] = [];

  // 0) portal_ship_name — seeded from the order shipping address at
  // creation. Free internal source, no API. Skip if it's just the email
  // or carries no letters.
  const ship = (patient.portal_ship_name ?? '').trim();
  if (ship && ship.toLowerCase() !== (patient.email ?? '').trim().toLowerCase() && /[a-z]/i.test(ship)) {
    candidates.push({ ...splitName(ship), source: 'portal_ship_name' });
  }

  // 1) Stripe billing name from the most recent deposit PaymentIntent.
  if (allowStripe && STRIPE_SECRET_KEY) {
    const stripeName = await stripeNameForPatient(admin, patientId);
    if (stripeName) candidates.push({ ...stripeName, source: 'stripe' });
  }

  // 2) Shopify: the customer record is usually an empty shell for these
  // (express/guest checkout), so the real name lives on the ORDER's
  // shipping/billing address. We search orders by email (the field 98%
  // of polluted rows have), then fall back to the customer record.
  if (SHOPIFY_TOKEN) {
    const shopifyCands = await shopifyNameCandidates(patient.shopify_customer_id, patient.email);
    candidates.push(...shopifyCands);
  }

  const picked = pickName(candidates);
  if (!picked) {
    // Nothing recoverable. Clean the 'Customer' placeholder to '' so the
    // row reads honestly (the UI shows the email). Only touch a
    // placeholder first name; never wipe a real value.
    const patch: Record<string, string> = {};
    if (patient.first_name != null && patient.first_name.trim() !== '' && firstBlank) patch.first_name = '';
    if (Object.keys(patch).length > 0) await admin.from('patients').update(patch).eq('id', patientId);
    return { patient_id: patientId, status: 'no_name_found', cleaned: Object.keys(patch).length > 0 };
  }

  const patch: Record<string, string> = {};
  if (firstBlank && picked.first.trim() !== '') patch.first_name = picked.first.trim();
  if (lastBlank && picked.last.trim() !== '') patch.last_name = picked.last.trim();
  // If we found a real first name but the placeholder first was 'Customer'
  // and the source had no last name, also clear a leftover placeholder.
  if (firstBlank && !('first_name' in patch) && patient.first_name && patient.first_name.trim() !== '') {
    patch.first_name = '';
  }
  if (Object.keys(patch).length === 0) {
    return { patient_id: patientId, status: 'no_change', source: picked.source };
  }
  await admin.from('patients').update(patch).eq('id', patientId);
  return {
    patient_id: patientId,
    status: 'recovered',
    source: picked.source,
    first_name: patch.first_name ?? patient.first_name,
    last_name: patch.last_name ?? patient.last_name,
  };
}

// ── Bulk walk ──
async function recoverBulk(
  admin: SupabaseClient,
  limit: number,
  afterId: string | null,
): Promise<Record<string, unknown>> {
  // Placeholder/blank name AND has a shopify_customer_id (the only bulk
  // recovery source). Page by id ascending.
  let q = admin
    .from('patients')
    .select('id, first_name, last_name, email, shopify_customer_id')
    .not('shopify_customer_id', 'is', null)
    .or('first_name.eq.Customer,first_name.eq.Patient,first_name.eq.,last_name.eq.')
    .order('id', { ascending: true })
    .limit(limit);
  if (afterId) q = q.gt('id', afterId);
  const { data: rows, error } = await q;
  if (error) return { processed: 0, error: error.message };

  const list = (rows ?? []) as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    shopify_customer_id: string | null;
  }[];

  let recovered = 0;
  let cleaned = 0;
  let noName = 0;
  for (const row of list) {
    const r = await recoverOne(admin, row.id, false);
    if (r.status === 'recovered') recovered++;
    else if (r.status === 'no_name_found') {
      noName++;
      if (r.cleaned) cleaned++;
    }
  }

  const nextAfterId = list.length === limit ? list[list.length - 1].id : null;
  return {
    processed: list.length,
    recovered,
    cleaned,
    no_name_found: noName,
    next_after_id: nextAfterId,
    done: nextAfterId === null,
  };
}

// ── Stripe: billing name on the patient's most recent deposit PI ──
async function stripeNameForPatient(
  admin: SupabaseClient,
  patientId: string,
): Promise<{ first: string; last: string } | null> {
  const { data: appt } = await admin
    .from('lng_appointments')
    .select('deposit_external_id, deposit_provider, created_at')
    .eq('patient_id', patientId)
    .eq('deposit_provider', 'stripe')
    .not('deposit_external_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const pi = (appt as { deposit_external_id: string | null } | null)?.deposit_external_id;
  if (!pi) return null;

  const res = await fetch(
    `https://api.stripe.com/v1/payment_intents/${pi}?expand[]=latest_charge`,
    { headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const name: string | undefined =
    data?.latest_charge?.billing_details?.name ??
    data?.shipping?.name ??
    undefined;
  const parsed = splitName(name);
  return parsed.first || parsed.last ? parsed : null;
}

async function shopifyGraphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  return await res.json();
}

function pushAddressCand(
  cands: NameCandidate[],
  first: string | null | undefined,
  last: string | null | undefined,
  name: string | null | undefined,
  source: string,
): void {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  if (f || l) {
    cands.push({ first: f, last: l, source });
    return;
  }
  const sp = splitName(name);
  if (sp.first || sp.last) cands.push({ ...sp, source });
}

// ── Stripe: billing name from a charge matched by email ──
// "One Click" (venneir.com) checkouts create a Shopify customer shell
// plus a Stripe card payment, so for those the real name lives only in
// Stripe billing_details. Search charges by receipt email, take the
// first with a billing name.
async function stripeNameByEmail(email: string): Promise<{ first: string; last: string } | null> {
  if (!STRIPE_SECRET_KEY || !email.trim()) return null;
  const safe = email.trim().replace(/"/g, '\\"');
  const headers = { Authorization: `Bearer ${STRIPE_SECRET_KEY}` };

  // 1) Charges by receipt email.
  const chargeRes = await fetch(
    `https://api.stripe.com/v1/charges/search?query=${encodeURIComponent(`receipt_email:"${safe}"`)}&limit=10`,
    { headers },
  );
  if (chargeRes.ok) {
    const data = await chargeRes.json();
    for (const ch of data?.data ?? []) {
      const sp = splitName(ch?.billing_details?.name ?? ch?.shipping?.name);
      if (sp.first || sp.last) return sp;
    }
  }

  // 2) Customer by email → the customer's name, then their charges'
  // billing name. One Click checkouts attach the email to a Stripe
  // customer rather than setting a charge receipt_email.
  const custRes = await fetch(
    `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email:"${safe}"`)}&limit=5`,
    { headers },
  );
  if (custRes.ok) {
    const custData = await custRes.json();
    for (const cust of custData?.data ?? []) {
      const sp = splitName(cust?.name);
      if (sp.first || sp.last) return sp;
      const chRes = await fetch(`https://api.stripe.com/v1/charges?customer=${cust.id}&limit=5`, { headers });
      if (chRes.ok) {
        const chData = await chRes.json();
        for (const ch of chData?.data ?? []) {
          const sp2 = splitName(ch?.billing_details?.name ?? ch?.shipping?.name);
          if (sp2.first || sp2.last) return sp2;
        }
      }
    }
  }
  return null;
}

// ── Shopify: order addresses (by email) + customer record ──
// Orders-by-email first: for express/guest checkouts the customer record
// is nameless and carries no linked orders, but the order itself holds
// the real name on its shipping/billing address.
async function shopifyNameCandidates(
  customerId: string | null,
  email: string | null,
): Promise<NameCandidate[]> {
  const cands: NameCandidate[] = [];

  if (email && email.trim()) {
    // Escape double-quotes in the search term.
    const safe = email.trim().replace(/"/g, '\\"');
    const data = await shopifyGraphql(
      `query($q: String!) {
        orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
          nodes {
            shippingAddress { firstName lastName name }
            billingAddress { firstName lastName name }
            customer { firstName lastName }
          }
        }
      }`,
      { q: `email:"${safe}"` },
    );
    for (const o of data?.data?.orders?.nodes ?? []) {
      if (o.shippingAddress) pushAddressCand(cands, o.shippingAddress.firstName, o.shippingAddress.lastName, o.shippingAddress.name, 'shopify_order_shipping');
      if (o.billingAddress) pushAddressCand(cands, o.billingAddress.firstName, o.billingAddress.lastName, o.billingAddress.name, 'shopify_order_billing');
      if (o.customer) pushAddressCand(cands, o.customer.firstName, o.customer.lastName, null, 'shopify_order_customer');
    }
    if (pickName(cands)) return cands;
  }

  // Fallback: the customer record + default address + its linked orders.
  if (customerId) {
    const data = await shopifyGraphql(
      `query($id: ID!) {
        customer(id: $id) {
          firstName lastName
          defaultAddress { firstName lastName name }
          orders(first: 5, sortKey: CREATED_AT, reverse: true) {
            nodes { shippingAddress { firstName lastName name } billingAddress { firstName lastName name } }
          }
        }
      }`,
      { id: `gid://shopify/Customer/${customerId}` },
    );
    const c = data?.data?.customer;
    if (c) {
      pushAddressCand(cands, c.firstName, c.lastName, null, 'shopify_customer');
      if (c.defaultAddress) pushAddressCand(cands, c.defaultAddress.firstName, c.defaultAddress.lastName, c.defaultAddress.name, 'shopify_default_address');
      for (const o of c.orders?.nodes ?? []) {
        if (o.shippingAddress) pushAddressCand(cands, o.shippingAddress.firstName, o.shippingAddress.lastName, o.shippingAddress.name, 'shopify_order_shipping');
        if (o.billingAddress) pushAddressCand(cands, o.billingAddress.firstName, o.billingAddress.lastName, o.billingAddress.name, 'shopify_order_billing');
      }
    }
  }

  return cands;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
