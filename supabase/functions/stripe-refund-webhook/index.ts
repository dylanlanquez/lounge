// stripe-refund-webhook
//
// Listens for charge.refund.* Stripe events and reconciles
// lng_payment_refunds rows that landed in 'pending' state.
//
// Why we need this: terminal-refund inserts the refund row BEFORE
// calling Stripe and flips it to 'succeeded' / 'failed' based on
// the API's IMMEDIATE response. Stripe refunds can settle async
// — the synchronous response says 'pending' and the actual outcome
// arrives minutes (sometimes hours) later via webhook. Without this
// listener the row would sit 'pending' forever and the patient
// would think they're still owed money.
//
// Auth model: PUBLIC. Stripe webhooks don't use Supabase auth. We
// verify the Stripe-Signature HMAC against STRIPE_*_WEBHOOK_SECRET
// before reading anything. Filter by metadata.refund_id (set on
// every refund minted by terminal-refund via the idempotency key)
// so other Stripe accounts / endpoints can't poison our refund
// table.
//
// Endpoint setup: Stripe Dashboard → Webhooks → Add endpoint
// pointing at this function's URL. Subscribe to:
//   charge.refund.created
//   charge.refund.updated
//   charge.refund.failed
// The signing secret Stripe returns goes on this Supabase project
// as STRIPE_REFUND_WEBHOOK_SECRET (separate from the widget +
// terminal webhook secrets — Stripe scopes secrets per endpoint).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REFUND_WEBHOOK_SECRET_LIVE =
  Deno.env.get('STRIPE_REFUND_WEBHOOK_SECRET') ??
  Deno.env.get('STRIPE_REFUND_WEBHOOK_SECRET_LIVE') ??
  '';
const REFUND_WEBHOOK_SECRET_TEST =
  Deno.env.get('STRIPE_REFUND_WEBHOOK_SECRET_TEST') ?? '';

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

interface StripeRefund {
  id: string;
  status?: string;          // succeeded | pending | failed | canceled | requires_action
  failure_reason?: string;
  amount?: number;
  currency?: string;
  payment_intent?: string;
  charge?: string;
  metadata?: Record<string, string | undefined>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature') ?? '';

  if (!REFUND_WEBHOOK_SECRET_LIVE && !REFUND_WEBHOOK_SECRET_TEST) {
    await logFailure('refund_webhook_secret_missing', {}, 'critical');
    return new Response('Server misconfigured', { status: 500 });
  }

  let verified = false;
  if (REFUND_WEBHOOK_SECRET_LIVE) {
    verified = await verifyStripeSignature(rawBody, sigHeader, REFUND_WEBHOOK_SECRET_LIVE);
  }
  if (!verified && REFUND_WEBHOOK_SECRET_TEST) {
    verified = await verifyStripeSignature(rawBody, sigHeader, REFUND_WEBHOOK_SECRET_TEST);
  }
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

  // Only act on refund events. Stripe historically published these
  // under charge.refund.* (charge.refund.updated) and now publishes
  // a fuller set under the top-level refund.* namespace
  // (refund.created / refund.updated / refund.failed). Accept both
  // so older accounts on the legacy API version keep working
  // alongside fresh ones subscribed to the new events. Anything
  // else returns 200 (Stripe stops retrying).
  const isRefundEvent =
    event.type.startsWith('charge.refund.') || event.type.startsWith('refund.');
  if (!isRefundEvent) {
    return new Response('ok', { status: 200 });
  }

  const refund = event.data.object as StripeRefund;
  if (!refund?.id) {
    return new Response('ok', { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    await reconcileRefund(supabase, event.type, refund);
  } catch (e) {
    await logFailure('webhook_handler_failed', {
      event: event.type,
      stripe_refund_id: refund.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return new Response('Handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});

async function reconcileRefund(
  supabase: ReturnType<typeof createClient>,
  eventType: string,
  refund: StripeRefund,
): Promise<void> {
  // Two-step lookup. terminal-refund:
  //   1. Inserts the local row with stripe_refund_id NULL.
  //   2. Calls Stripe /v1/refunds (stamping metadata[refund_id]
  //      with the local row id).
  //   3. Updates the local row with stripe_refund_id from the
  //      Stripe response.
  //
  // Stripe can deliver charge.refund.* in the window between (2)
  // and (3). If we only matched on stripe_refund_id we'd miss the
  // row and log it as an orphan. Metadata fallback closes that:
  //
  //   • Fast path: match on stripe_refund_id (terminal-refund has
  //     stamped it by now).
  //   • Race path: match on metadata.refund_id (the local row id
  //     we baked into the Stripe Refund object). When we hit this
  //     path we ALSO write stripe_refund_id onto the row so any
  //     subsequent retry of the same event goes through the fast
  //     path and the audit trail carries the cross-reference.
  //   • True orphan: no stripe_refund_id match, no metadata.
  //     refund_id (or metadata.refund_id present but no row) →
  //     log + 200 only when metadata.refund_id is absent
  //     (dashboard-issued refund). When metadata.refund_id IS
  //     set but the row isn't there yet, we throw so the handler
  //     returns 5xx and Stripe retries — that path catches the
  //     extreme case where the webhook somehow arrives before the
  //     initial INSERT has committed.
  const metaRefundId =
    typeof refund.metadata?.refund_id === 'string'
      ? refund.metadata.refund_id
      : null;
  const fastReadRes = await supabase
    .from('lng_payment_refunds')
    .select('id, status, payment_id, deposit_appointment_id, amount_pence, visit_id, appointment_id, stripe_refund_id')
    .eq('stripe_refund_id', refund.id)
    .maybeSingle();
  if (fastReadRes.error) {
    await logFailure('refund_row_read_failed', {
      error: fastReadRes.error.message,
      stripe_refund_id: refund.id,
    });
    return;
  }
  let row = fastReadRes.data;
  let matchedViaMetadata = false;
  if (!row && metaRefundId) {
    const metaReadRes = await supabase
      .from('lng_payment_refunds')
      .select('id, status, payment_id, deposit_appointment_id, amount_pence, visit_id, appointment_id, stripe_refund_id')
      .eq('id', metaRefundId)
      .maybeSingle();
    if (metaReadRes.error) {
      await logFailure('refund_row_read_failed_metadata_path', {
        error: metaReadRes.error.message,
        stripe_refund_id: refund.id,
        meta_refund_id: metaRefundId,
      });
      return;
    }
    row = metaReadRes.data;
    matchedViaMetadata = !!row;
  }
  if (!row) {
    if (metaRefundId) {
      // Stripe says we minted this refund (metadata.refund_id is
      // ours) but the row isn't in the DB yet. Stripe's retry
      // policy is our friend here — return 5xx, Stripe re-delivers
      // after the row has had a chance to settle.
      await logFailure(
        'refund_webhook_metadata_no_row',
        {
          stripe_refund_id: refund.id,
          meta_refund_id: metaRefundId,
          stripe_event_type: eventType,
        },
        'warning',
      );
      throw new Error('refund_row_not_yet_visible');
    }
    // No metadata.refund_id — this is a refund issued outside
    // Lounge (Stripe dashboard, partner integration, etc). Log
    // for audit + 200 so Stripe stops retrying. The audit table
    // requires performer + approver ids the webhook doesn't have.
    await supabase.from('lng_event_log').insert({
      source: 'stripe-refund-webhook',
      event_type: 'orphan_refund',
      payload: {
        stripe_refund_id: refund.id,
        stripe_event_type: eventType,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        payment_intent: refund.payment_intent,
      },
    });
    return;
  }

  const r = row as {
    id: string;
    status: string;
    payment_id: string | null;
    deposit_appointment_id: string | null;
    amount_pence: number;
    visit_id: string | null;
    appointment_id: string | null;
    stripe_refund_id: string | null;
  };

  // When we matched via metadata, the row's stripe_refund_id is
  // still null — terminal-refund hadn't written it back yet.
  // Write it now so the next webhook delivery for the same Stripe
  // refund goes through the fast path. Best-effort: if the write
  // fails we'll just take the metadata path again next time.
  if (matchedViaMetadata && r.stripe_refund_id !== refund.id) {
    await supabase
      .from('lng_payment_refunds')
      .update({ stripe_refund_id: refund.id })
      .eq('id', r.id);
  }

  const nextStatus = mapStripeStatus(refund.status);

  // Idempotency: if the local row already settled (succeeded /
  // failed) and the webhook re-fires (Stripe retries on 5xx, plus
  // delivery-can-repeat), no-op. Only act when the local row is
  // still 'pending' OR when Stripe is downgrading us from succeeded
  // → failed (very rare, but Stripe can claw back authorisation).
  if (r.status === nextStatus) {
    return;
  }
  if (r.status === 'succeeded' && nextStatus !== 'failed') {
    return;
  }

  const updates: Record<string, unknown> = {
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  if (nextStatus === 'failed') {
    updates.failure_reason = refund.failure_reason ?? `Stripe status: ${refund.status}`;
  } else {
    updates.failure_reason = null;
  }
  const { error: updErr } = await supabase
    .from('lng_payment_refunds')
    .update(updates)
    .eq('id', r.id);
  if (updErr) {
    await logFailure('refund_row_update_failed', {
      error: updErr.message,
      refund_id: r.id,
    });
    return;
  }

  // Side-effect cascade — only on succeeded transitions. Mirrors
  // the synchronous logic in terminal-refund:
  //   • Payment-source full-refund threshold → flip payment to
  //     cancelled + re-open cart.
  //   • Patient timeline 'refund_issued' event so the audit
  //     captures the moment Stripe actually settled (terminal-
  //     refund's synchronous insert already wrote an entry when
  //     the API call returned pending; this one supplements with
  //     the settlement-confirmed payload).
  if (nextStatus !== 'succeeded') return;

  if (r.payment_id) {
    const { data: paymentRow } = await supabase
      .from('lng_payments')
      .select('id, amount_pence, cart_id, status')
      .eq('id', r.payment_id)
      .maybeSingle();
    const p = paymentRow as {
      id: string;
      amount_pence: number;
      cart_id: string;
      status: string;
    } | null;
    if (p && p.status === 'succeeded') {
      const { data: refundedRows } = await supabase
        .from('lng_payment_refunds')
        .select('amount_pence')
        .eq('payment_id', p.id)
        .eq('status', 'succeeded');
      const totalRefunded = ((refundedRows ?? []) as { amount_pence: number }[]).reduce(
        (acc, x) => acc + (x.amount_pence ?? 0),
        0,
      );
      if (totalRefunded >= p.amount_pence) {
        await supabase
          .from('lng_payments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', p.id);
        await supabase
          .from('lng_carts')
          .update({ status: 'open', closed_at: null })
          .eq('id', p.cart_id);
      }
    }
  }

  // Settlement-confirmed timeline supplement. The original
  // 'refund_issued' row from terminal-refund captured the moment
  // the refund was AUTHORISED; this one captures the moment Stripe
  // actually SETTLED. Two rows on the timeline reads as one
  // continuous narrative ("Refund issued · pending → succeeded").
  if (r.appointment_id || r.visit_id) {
    const patientId = await resolvePatientId(supabase, r);
    if (patientId) {
      await supabase.from('patient_events').insert({
        patient_id: patientId,
        event_type: 'refund_settled',
        actor_account_id: null,
        notes: 'Stripe confirmed the refund has settled.',
        payload: {
          refund_id: r.id,
          stripe_refund_id: refund.id,
          amount_pence: r.amount_pence,
          payment_id: r.payment_id,
          deposit_appointment_id: r.deposit_appointment_id,
          visit_id: r.visit_id,
          appointment_id: r.appointment_id,
          source: 'webhook',
        },
      });
    }
  }

  // Auto-resolve owed timeline narrative when the async settlement
  // brings the patient back to balanced.
  const patientId = await resolvePatientId(supabase, r);
  if (patientId) {
    await maybeResolveOwedEvent(supabase, {
      patientId,
      visitId: r.visit_id,
      appointmentId: r.appointment_id ?? r.deposit_appointment_id,
      refundId: r.id,
      refundedPence: r.amount_pence,
    });
  }

  // Refund receipt — fire only on async settlement (the synchronous
  // path in terminal-refund fires its own). Best-effort.
  try {
    await fetch(
      `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/send-refund-receipt`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refundId: r.id }),
      },
    );
  } catch (e) {
    await logFailure('refund_receipt_invoke_failed', {
      refund_id: r.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function maybeResolveOwedEvent(
  supabase: ReturnType<typeof createClient>,
  args: {
    patientId: string;
    visitId: string | null;
    appointmentId: string | null;
    refundId: string;
    refundedPence: number;
  },
): Promise<void> {
  try {
    let balanced = false;
    if (args.visitId) {
      const { data: paidRow } = await supabase
        .from('lng_visit_paid_status')
        .select('amount_due_pence, amount_paid_pence')
        .eq('visit_id', args.visitId)
        .maybeSingle();
      const p = paidRow as {
        amount_due_pence: number | null;
        amount_paid_pence: number;
      } | null;
      if (p) {
        balanced = p.amount_paid_pence <= (p.amount_due_pence ?? 0);
      }
    } else if (args.appointmentId) {
      const { data: apptRow } = await supabase
        .from('lng_appointments')
        .select('deposit_pence, deposit_status')
        .eq('id', args.appointmentId)
        .maybeSingle();
      const a = apptRow as {
        deposit_pence: number | null;
        deposit_status: string | null;
      } | null;
      if (a?.deposit_status === 'paid' && a.deposit_pence) {
        const { data: refundsRows } = await supabase
          .from('lng_payment_refunds')
          .select('amount_pence')
          .eq('deposit_appointment_id', args.appointmentId)
          .eq('status', 'succeeded');
        const totalRefunded = ((refundsRows ?? []) as { amount_pence: number }[]).reduce(
          (acc, x) => acc + (x.amount_pence ?? 0),
          0,
        );
        balanced = totalRefunded >= a.deposit_pence;
      } else {
        balanced = true;
      }
    }
    if (!balanced) return;
    const { data: recent } = await supabase
      .from('patient_events')
      .select('id')
      .eq('patient_id', args.patientId)
      .eq('event_type', 'owed_to_patient')
      .order('created_at', { ascending: false })
      .limit(1);
    const owed = (recent ?? [])[0] as { id: string } | undefined;
    await supabase.from('patient_events').insert({
      patient_id: args.patientId,
      event_type: 'owed_to_patient_resolved',
      payload: {
        resolved_by_refund_id: args.refundId,
        refunded_pence: args.refundedPence,
        resolved_owed_event_id: owed?.id ?? null,
        visit_id: args.visitId,
        appointment_id: args.appointmentId,
        source: 'webhook',
      },
    });
  } catch {
    // best-effort
  }
}

async function resolvePatientId(
  supabase: ReturnType<typeof createClient>,
  row: {
    visit_id: string | null;
    appointment_id: string | null;
    deposit_appointment_id: string | null;
  },
): Promise<string | null> {
  if (row.visit_id) {
    const { data } = await supabase
      .from('lng_visits')
      .select('patient_id')
      .eq('id', row.visit_id)
      .maybeSingle();
    const id = (data as { patient_id: string | null } | null)?.patient_id ?? null;
    if (id) return id;
  }
  const apptId = row.appointment_id ?? row.deposit_appointment_id;
  if (apptId) {
    const { data } = await supabase
      .from('lng_appointments')
      .select('patient_id')
      .eq('id', apptId)
      .maybeSingle();
    const id = (data as { patient_id: string | null } | null)?.patient_id ?? null;
    if (id) return id;
  }
  return null;
}

function mapStripeStatus(s: string | undefined): 'pending' | 'succeeded' | 'failed' {
  switch ((s ?? '').toLowerCase()) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'pending':
    case 'requires_action':
    default:
      return 'pending';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe signature verification — same shape as widget-stripe-webhook
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
      source: 'stripe-refund-webhook',
      severity,
      message,
      context,
    });
  } catch {
    // best-effort
  }
}
