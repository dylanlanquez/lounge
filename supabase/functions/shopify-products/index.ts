// shopify-products
//
// Lists the Venneir Shopify product catalogue for the Admin → Products
// "Import from Shopify" panel. Read-only: it calls the Shopify Admin API
// (read_products) live and returns a normalised list; it never writes.
// The staff app then upserts the picked products into lwo_catalogue.
//
// Auth: anon-key Bearer JWT (signed-in user), and the caller must be an
// admin (is_admin()). The Shopify Admin API token lives ONLY here as an
// edge-function secret, never client-side.
//
// Secrets (set on the Meridian project):
//   SHOPIFY_VENNEIR_ADMIN_TOKEN  — Admin API access token (read_products)
//   SHOPIFY_VENNEIR_SHOP         — myshopify domain, default venneir.myshopify.com
//   SHOPIFY_API_VERSION          — optional, default 2025-07
//
// Body: {} (none). Returns: { products: ShopifyProduct[] } or
// { error: 'shopify_not_configured' } (503) when the token is unset, so
// the UI can show a clear "connect Shopify" message rather than fail.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SHOPIFY_TOKEN = Deno.env.get('SHOPIFY_VENNEIR_ADMIN_TOKEN') ?? '';
const SHOPIFY_SHOP = Deno.env.get('SHOPIFY_VENNEIR_SHOP') ?? 'venneir.myshopify.com';
const SHOPIFY_API_VERSION = Deno.env.get('SHOPIFY_API_VERSION') ?? '2025-07';

// Cap pages so a runaway catalogue can't hammer the API (250 * 12 = 3000).
const MAX_PAGES = 12;
const PAGE_SIZE = 250;

interface ShopifyProduct {
  product_id: string;
  variant_id: string | null;
  title: string;
  sku: string | null;
  price: number | null; // shop currency, major units (pounds)
  currency: string | null;
  image_url: string | null;
  product_type: string | null;
  vendor: string | null;
  status: string | null;
  handle: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // ── Auth: signed-in admin only ──
  const userJwt = req.headers.get('authorization') ?? '';
  if (!userJwt.startsWith('Bearer ')) return jsonResponse(401, { error: 'no_bearer' });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: userJwt } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return jsonResponse(401, { error: 'not_signed_in' });
  const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin');
  if (adminErr) return jsonResponse(500, { error: 'admin_check_failed' });
  if (isAdmin !== true) return jsonResponse(403, { error: 'not_admin' });

  if (!SHOPIFY_TOKEN) {
    // Not an error to log — it's an expected "not connected yet" state.
    return jsonResponse(503, { error: 'shopify_not_configured' });
  }

  try {
    const products = await fetchAllProducts();
    return jsonResponse(200, { products, shop: SHOPIFY_SHOP });
  } catch (e) {
    await logFailure('shopify_products_fetch_failed', {
      shop: SHOPIFY_SHOP,
      error: e instanceof Error ? e.message : String(e),
    });
    return jsonResponse(502, { error: 'shopify_fetch_failed' });
  }
});

// Walk the REST products endpoint, following the Link header's rel="next"
// cursor until exhausted or the page cap is hit.
async function fetchAllProducts(): Promise<ShopifyProduct[]> {
  const out: ShopifyProduct[] = [];
  const base = `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`;
  // First page filters to active products; subsequent pages can only carry
  // limit + page_info (Shopify cursor pagination rule).
  let url: string | null = `${base}/products.json?limit=${PAGE_SIZE}&status=active`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    for (const p of json.products ?? []) out.push(normalise(p));

    url = nextPageUrl(res.headers.get('link'));
  }
  // Stable, human-friendly ordering for the import list.
  out.sort((a, b) => a.title.localeCompare(b.title, 'en-GB'));
  return out;
}

// One Lounge product per Shopify product: take the first/default variant
// for price + SKU, and the first image.
function normalise(p: Record<string, unknown>): ShopifyProduct {
  const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [];
  const v0 = variants[0];
  const images = Array.isArray(p.images) ? (p.images as Record<string, unknown>[]) : [];
  const image =
    (p.image as Record<string, unknown> | null)?.src ?? images[0]?.src ?? null;
  const priceRaw = v0?.price as string | undefined;
  const price = priceRaw != null && priceRaw !== '' ? Number(priceRaw) : null;
  return {
    product_id: String(p.id),
    variant_id: v0?.id != null ? String(v0.id) : null,
    title: String(p.title ?? 'Untitled'),
    sku: (v0?.sku as string | null) || null,
    price: price != null && Number.isFinite(price) ? price : null,
    currency: null, // Shopify REST product payload carries no currency; shop default applies.
    image_url: (image as string | null) ?? null,
    product_type: (p.product_type as string | null) || null,
    vendor: (p.vendor as string | null) || null,
    status: (p.status as string | null) || null,
    handle: (p.handle as string | null) || null,
  };
}

// Parse the RFC-5988 Link header for the rel="next" URL, if present.
function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function logFailure(message: string, context: Record<string, unknown>): Promise<void> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'shopify-products',
      severity: 'error',
      message,
      context,
    });
  } catch {
    // best-effort
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
