// terminal-webhook
//
// Receives payment_intent.succeeded / payment_intent.payment_failed /
// payment_intent.canceled / payment_intent.requires_action from Stripe.
// Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET.
// Updates lng_terminal_payments + parent lng_payments + writes a
// patient_events row.
//
// Per brief §5.5 and `01-architecture-decision.md §3.5`. Auth model:
// PUBLIC (Stripe doesn't use Supabase auth). Signature is the auth.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature') ?? '';

  if (!STRIPE_WEBHOOK_SECRET) {
    await logFailure('stripe_webhook_secret_missing', {}, 'critical');
    return new Response('Server misconfigured', { status: 500 });
  }

  const verified = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    await logFailure('stripe_signature_invalid', { sigHeader }, 'critical');
    return new Response('Bad signature', { status: 401 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as PaymentIntent;
        await markStatus(supabase, pi.id, 'succeeded', { raw_event: event, succeeded_at: new Date().toISOString() });
        await emitPatientEvent(supabase, pi, 'payment_succeeded');
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as PaymentIntent;
        await markStatus(supabase, pi.id, 'failed', {
          raw_event: event,
          failure_reason: pi.last_payment_error?.message ?? 'unknown',
        });
        await emitPatientEvent(supabase, pi, 'payment_failed');
        break;
      }
      case 'payment_intent.canceled': {
        const pi = event.data.object as PaymentIntent;
        await markStatus(supabase, pi.id, 'cancelled', { raw_event: event, cancelled_at: new Date().toISOString() });
        await emitPatientEvent(supabase, pi, 'payment_cancelled');
        break;
      }
      case 'payment_intent.requires_action': {
        // SCA flow — keep as 'processing' but record the latest event.
        const pi = event.data.object as PaymentIntent;
        await supabase
          .from('lng_terminal_payments')
          .update({ raw_event: event, reader_action_status: 'requires_action' })
          .eq('stripe_payment_intent_id', pi.id);
        break;
      }
      default:
        // Other events get logged but ignored.
        break;
    }
  } catch (e) {
    await logFailure('webhook_handler_failed', { event: event.type, error: String(e) });
    return new Response('Handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});

// ---------- helpers ----------

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}
interface PaymentIntent {
  id: string;
  metadata?: { visit_id?: string; cart_id?: string; payment_journey?: string };
  last_payment_error?: { message?: string };
}

async function markStatus(
  supabase: ReturnType<typeof createClient>,
  paymentIntentId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  extra: { raw_event?: unknown; succeeded_at?: string; cancelled_at?: string; failure_reason?: string }
) {
  // Update lng_terminal_payments
  const tpUpdate: Record<string, unknown> = {};
  if (extra.raw_event) tpUpdate.raw_event = extra.raw_event;
  if (extra.succeeded_at) tpUpdate.succeeded_at = extra.succeeded_at;
  await supabase
    .from('lng_terminal_payments')
    .update(tpUpdate)
    .eq('stripe_payment_intent_id', paymentIntentId);

  // Update parent lng_payments
  const { data: tp } = await supabase
    .from('lng_terminal_payments')
    .select('payment_id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();
  if (!tp) return;

  const pUpdate: Record<string, unknown> = { status };
  if (extra.succeeded_at) pUpdate.succeeded_at = extra.succeeded_at;
  if (extra.cancelled_at) pUpdate.cancelled_at = extra.cancelled_at;
  if (extra.failure_reason) pUpdate.failure_reason = extra.failure_reason;

  await supabase.from('lng_payments').update(pUpdate).eq('id', (tp as { payment_id: string }).payment_id);
}

async function emitPatientEvent(
  supabase: ReturnType<typeof createClient>,
  pi: PaymentIntent,
  eventType: 'payment_succeeded' | 'payment_failed' | 'payment_cancelled'
) {
  const cartId = pi.metadata?.cart_id;
  if (!cartId) return;
  // Find visit + patient
  const { data: cart } = await supabase
    .from('lng_carts')
    .select('visit_id')
    .eq('id', cartId)
    .maybeSingle();
  if (!cart) return;
  const { data: visit } = await supabase
    .from('lng_visits')
    .select('patient_id')
    .eq('id', (cart as { visit_id: string }).visit_id)
    .maybeSingle();
  if (!visit) return;
  await supabase.from('patient_events').insert({
    patient_id: (visit as { patient_id: string }).patient_id,
    event_type: eventType,
    payload: {
      payment_intent_id: pi.id,
      payment_journey: pi.metadata?.payment_journey ?? 'standard',
    },
  });
}

async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string): Promise<boolean> {
  // Stripe-Signature: t=<timestamp>,v1=<hex>,v1=<hex>
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find((p) => p[0] === 't')?.[1];
  const v1s = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || v1s.length === 0) return false;
  const tn = Number(t);
  if (!Number.isFinite(tn)) return false;
  if (Math.abs(Date.now() / 1000 - tn) > 600) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return v1s.some((v) => constantTimeEqual(v, expected));
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

async function logFailure(
  message: string,
  context: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error'
) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'terminal-webhook',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
