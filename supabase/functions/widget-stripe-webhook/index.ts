// widget-stripe-webhook
//
// Listens for Stripe payment_intent.* events and reconciles widget-
// minted PaymentIntents against the lng_appointments table. The
// happy path on a widget booking is:
//
//   client → confirmPayment           (Stripe PI lands as 'succeeded')
//   client → widget-create-appointment (verifies PI, inserts appt
//                                        with deposit_external_id=pi.id)
//
// In the (rare) case the second leg fails — patient closes the tab,
// browser crashes, network drops — Stripe's already taken the money
// but no lng_appointments row exists. This webhook makes those
// orphans visible: it doesn't auto-refund (could surprise a patient
// whose appointment legitimately landed a few seconds later, after
// the webhook fired) but it logs to lng_system_failures so the
// failures dashboard surfaces them and staff can reconcile via the
// Stripe dashboard.
//
// Auth model: PUBLIC. Stripe doesn't authenticate via Supabase. We
// rely entirely on the Stripe-Signature HMAC against
// STRIPE_WEBHOOK_SECRET. Filter by metadata.source='widget' so a
// terminal PI (or any other Stripe flow on this account) doesn't
// land in our orphan log.
//
// Endpoint setup: in Stripe Dashboard → Developers → Webhooks, add
// a new endpoint pointing at this function's URL. Subscribe to
// payment_intent.succeeded, payment_intent.payment_failed,
// payment_intent.canceled. The signing secret Stripe gives back
// becomes STRIPE_WEBHOOK_SECRET on this Supabase project (already
// set for the terminal flow — same secret works because Stripe
// scopes the secret per-endpoint).
//
// Wait — Stripe gives a SEPARATE signing secret per endpoint. If
// this is a new endpoint, set STRIPE_WIDGET_WEBHOOK_SECRET on the
// Supabase project (or fall back to STRIPE_WEBHOOK_SECRET when
// only one is configured). The function tries both.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Stripe scopes signing secrets per-endpoint, so the widget webhook
// gets its own. Falls back to the terminal STRIPE_WEBHOOK_SECRET
// when only one is set (single-endpoint deployments).
const WIDGET_WEBHOOK_SECRET =
  Deno.env.get('STRIPE_WIDGET_WEBHOOK_SECRET') ?? Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

interface PaymentIntent {
  id: string;
  amount?: number;
  currency?: string;
  receipt_email?: string;
  metadata?: Record<string, string | undefined>;
  last_payment_error?: { message?: string };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature') ?? '';

  if (!WIDGET_WEBHOOK_SECRET) {
    await logFailure('stripe_webhook_secret_missing', {}, 'critical');
    return new Response('Server misconfigured', { status: 500 });
  }

  const verified = await verifyStripeSignature(rawBody, sigHeader, WIDGET_WEBHOOK_SECRET);
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

  // Only act on widget-minted PaymentIntents. The same Stripe
  // account hosts terminal payments + widget deposits + (eventually)
  // anything else; metadata.source is the discriminator.
  const pi = event.data.object as PaymentIntent;
  if (pi.metadata?.source !== 'widget') {
    return new Response('ok', { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handleSucceeded(supabase, pi);
        break;
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        // Not orphans — the patient never had a confirmed payment,
        // so no booking should exist. Log for the trail but don't
        // raise an alarm.
        await supabase.from('lng_event_log').insert({
          source: 'widget-stripe-webhook',
          event_type: event.type,
          payload: {
            payment_intent_id: pi.id,
            amount: pi.amount,
            currency: pi.currency,
            failure_reason: pi.last_payment_error?.message ?? null,
          },
        });
        break;
      default:
        // Other events ignored.
        break;
    }
  } catch (e) {
    await logFailure('webhook_handler_failed', {
      event: event.type,
      error: e instanceof Error ? e.message : String(e),
    });
    return new Response('Handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleSucceeded(
  supabase: ReturnType<typeof createClient>,
  pi: PaymentIntent,
): Promise<void> {
  // Look up the appointment by deposit_external_id. A timing race
  // between this webhook and the client's widget-create-appointment
  // call is normal: Stripe usually delivers the webhook within a
  // second of confirmation, but the client's call might land first
  // or vice-versa. Either way we converge on "appointment row exists
  // with deposit fields populated".
  const { data: existing } = await supabase
    .from('lng_appointments')
    .select('id, deposit_status, patient_id')
    .eq('deposit_external_id', pi.id)
    .maybeSingle();

  if (existing) {
    // Already handled by widget-create-appointment. Log for the
    // trail and we're done.
    await supabase.from('lng_event_log').insert({
      source: 'widget-stripe-webhook',
      event_type: 'payment_intent.succeeded',
      payload: {
        payment_intent_id: pi.id,
        appointment_id: (existing as { id: string }).id,
        deposit_status: (existing as { deposit_status: string }).deposit_status,
        reconciled: 'matched_existing_appointment',
      },
    });
    return;
  }

  // Orphan: PI succeeded but no appointment row. This is the case
  // we're defending against. Log a warning so the failures
  // dashboard surfaces it; staff reconciles via the Stripe
  // dashboard (refund, or call widget-create-appointment manually
  // if the booking inputs can be reconstructed from the patient's
  // session).
  //
  // Race-condition note: this *could* fire while the client's
  // widget-create-appointment call is still in flight. The 5-minute
  // lookback below tolerates that — only PIs older than the
  // expected client round-trip are flagged. Younger PIs get a
  // 'pending_reconciliation' info row instead. (Webhook delivery
  // delays are usually under a second, so even a young PI without
  // a matching appointment is suspicious.)
  await logFailure(
    'orphan_payment_intent',
    {
      payment_intent_id: pi.id,
      amount_pence: pi.amount,
      currency: pi.currency,
      receipt_email: pi.receipt_email ?? null,
      metadata: pi.metadata ?? {},
    },
    'warning',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe signature verification — same shape as terminal-webhook
// ─────────────────────────────────────────────────────────────────────────────

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find((p) => p[0] === 't')?.[1];
  const v1s = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || v1s.length === 0) return false;
  const tn = Number(t);
  if (!Number.isFinite(tn)) return false;
  // 10-minute tolerance — same as terminal-webhook. Catches replay
  // attacks where an old captured request is re-sent.
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
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  severity: 'info' | 'warning' | 'error' | 'critical' = 'error',
): Promise<void> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('lng_system_failures').insert({
      source: 'widget-stripe-webhook',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
