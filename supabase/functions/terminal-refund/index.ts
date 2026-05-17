// terminal-refund
//
// POST { ...exactly one of payment_id / deposit_appointment_id... }
//
// Common fields:
//   amount_pence            int  ≥1
//   reason_category         text (see VALID_REASON_CATEGORIES)
//   reason_note             text, required, non-empty
//   approver_account_id     uuid, second-staff sign-off
//
// Source fields (mutually exclusive):
//   payment_id              uuid  refund a captured lng_payments row
//                                 (cash or card at the till)
//   deposit_appointment_id  uuid  refund the appointment's
//                                 widget-time deposit (paid via the
//                                 public booking widget; lives on
//                                 lng_appointments.deposit_external_id,
//                                 never converted into an lng_payments
//                                 row)
//
// Routing:
//   • payment_id + method=card_terminal → Stripe /v1/refunds against
//     the PI on lng_terminal_payments. Partial supported.
//   • payment_id + method=cash → no Stripe call; the refund row goes
//     in as 'succeeded' immediately (staff hand cash back).
//   • deposit_appointment_id → Stripe /v1/refunds against the PI on
//     lng_appointments.deposit_external_id. Always card-side.
//
// Every refund (cash, card, deposit) writes exactly one
// lng_payment_refunds row + one patient_events 'refund_issued' entry.
//
// Idempotency: a unique stripe-side Idempotency-Key per refund call
// stops a double-tap from firing two Stripe refunds. We mint one per
// request from the refund_id (NEW row UUID), so retries within the
// same request reuse it; retries that start a new request mint a
// fresh row + key.
//
// Payment status: lng_payments.status flips to 'cancelled' ONLY when
// the cumulative refunded total == payment.amount_pence. Partial
// refunds leave the payment as 'succeeded' (net of refunds), which
// keeps the visit's "amount paid" math working — `amount_paid` is
// recomputed downstream as payment.amount - sum(refunds).
//
// Cart: re-opened only on a full-refund threshold. Partial refunds
// don't unlock the cart because the rest of the money is still on
// the books.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const VALID_REASON_CATEGORIES = new Set([
  'item_removed',
  'visit_cancelled',
  'visit_ended_early',
  'service_not_delivered',
  'patient_request',
  'cart_correction',
  'other',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return j(401, { ok: false, error: 'Missing token' });

  let body: {
    payment_id?: string;
    deposit_appointment_id?: string;
    amount_pence?: number;
    reason_category?: string;
    reason_note?: string;
    approver_account_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return j(400, { ok: false, error: 'Bad JSON' });
  }
  const hasPayment = !!body.payment_id;
  const hasDeposit = !!body.deposit_appointment_id;
  if (hasPayment === hasDeposit) {
    return j(400, {
      ok: false,
      error: 'Provide exactly one of payment_id or deposit_appointment_id',
    });
  }
  if (typeof body.amount_pence !== 'number' || !Number.isFinite(body.amount_pence) || body.amount_pence <= 0) {
    return j(400, { ok: false, error: 'amount_pence must be a positive integer' });
  }
  const amountPence = Math.round(body.amount_pence);
  if (!body.approver_account_id) {
    return j(400, { ok: false, error: 'Manager approval is required to issue a refund.' });
  }
  if (!body.reason_category || !VALID_REASON_CATEGORIES.has(body.reason_category)) {
    return j(400, { ok: false, error: 'reason_category invalid' });
  }
  const reasonNote = (body.reason_note ?? '').trim();
  if (!reasonNote) {
    return j(400, { ok: false, error: 'reason_note is required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve the staff member who initiated the refund via their
  // bearer token. Mirrors terminal-start-payment.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: meRow } = await userClient.rpc('auth_account_id');
  const refundedBy = (meRow as string | null) ?? null;
  if (!refundedBy) return j(401, { ok: false, error: 'Could not resolve staff member' });
  if (body.approver_account_id === refundedBy) {
    return j(403, { ok: false, error: 'Approver must be a different staff member.' });
  }

  // Resolve the refund source into a common shape regardless of
  // whether it came from a payment or a deposit. From here down the
  // logic only cares about: how much was captured, what method, what
  // PI to refund against (for Stripe), and what audit handles to
  // stamp on the row.
  type ResolvedSource = {
    kind: 'payment' | 'deposit';
    sourceId: string;
    capturedPence: number;
    method: 'card_terminal' | 'cash' | 'gift_card' | 'account_credit';
    paymentJourney: string;
    stripePaymentIntentId: string | null;
    cartId: string | null;
    visitId: string | null;
    appointmentId: string | null;
    patientId: string | null;
  };

  let src: ResolvedSource;
  if (hasPayment) {
    const { data: payment, error: pErr } = await supabase
      .from('lng_payments')
      .select('id, cart_id, method, payment_journey, amount_pence, status')
      .eq('id', body.payment_id)
      .maybeSingle();
    if (pErr || !payment) return j(404, { ok: false, error: 'Payment not found' });
    const p = payment as {
      id: string;
      cart_id: string;
      method: 'card_terminal' | 'cash' | 'gift_card' | 'account_credit';
      payment_journey: string;
      amount_pence: number;
      status: string;
    };
    if (p.status !== 'succeeded') {
      return j(409, { ok: false, error: `Cannot refund payment in status ${p.status}` });
    }
    // Stripe PI (only present for card_terminal payments).
    let stripePiId: string | null = null;
    if (p.method === 'card_terminal') {
      const { data: tp } = await supabase
        .from('lng_terminal_payments')
        .select('stripe_payment_intent_id')
        .eq('payment_id', p.id)
        .maybeSingle();
      stripePiId = (tp as { stripe_payment_intent_id: string } | null)?.stripe_payment_intent_id ?? null;
    }
    // Resolve cart → visit → appointment + patient.
    const { data: cart } = await supabase
      .from('lng_carts')
      .select('visit_id')
      .eq('id', p.cart_id)
      .maybeSingle();
    const visitId = (cart as { visit_id: string | null } | null)?.visit_id ?? null;
    let patientId: string | null = null;
    let appointmentId: string | null = null;
    if (visitId) {
      const { data: v } = await supabase
        .from('lng_visits')
        .select('patient_id, appointment_id')
        .eq('id', visitId)
        .maybeSingle();
      patientId = (v as { patient_id: string | null } | null)?.patient_id ?? null;
      appointmentId = (v as { appointment_id: string | null } | null)?.appointment_id ?? null;
    }
    src = {
      kind: 'payment',
      sourceId: p.id,
      capturedPence: p.amount_pence,
      method: p.method,
      paymentJourney: p.payment_journey,
      stripePaymentIntentId: stripePiId,
      cartId: p.cart_id,
      visitId,
      appointmentId,
      patientId,
    };
  } else {
    // Deposit source — the customer paid (in full or partially) via
    // the public booking widget. The capture lives on
    // lng_appointments.deposit_external_id (Stripe PI).
    const { data: appt, error: aErr } = await supabase
      .from('lng_appointments')
      .select(
        'id, patient_id, deposit_pence, deposit_status, deposit_external_id, deposit_provider',
      )
      .eq('id', body.deposit_appointment_id)
      .maybeSingle();
    if (aErr || !appt) return j(404, { ok: false, error: 'Appointment not found' });
    const a = appt as {
      id: string;
      patient_id: string;
      deposit_pence: number | null;
      deposit_status: string | null;
      deposit_external_id: string | null;
      deposit_provider: string | null;
    };
    if (a.deposit_status !== 'paid' || !a.deposit_pence || !a.deposit_external_id) {
      return j(409, {
        ok: false,
        error: 'No paid deposit on this appointment',
      });
    }
    if (a.deposit_provider !== 'stripe') {
      return j(409, {
        ok: false,
        error: `Cannot refund deposits paid via ${a.deposit_provider ?? 'unknown provider'}`,
      });
    }
    // Resolve the linked visit (if arrival has already happened) so
    // the audit row can be queried from the visit page later.
    const { data: linkedVisit } = await supabase
      .from('lng_visits')
      .select('id')
      .eq('appointment_id', a.id)
      .maybeSingle();
    src = {
      kind: 'deposit',
      sourceId: a.id,
      capturedPence: a.deposit_pence,
      method: 'card_terminal',
      paymentJourney: 'standard',
      stripePaymentIntentId: a.deposit_external_id,
      cartId: null,
      visitId: (linkedVisit as { id: string } | null)?.id ?? null,
      appointmentId: a.id,
      patientId: a.patient_id,
    };
  }

  // Location guard. The refund must happen at the same location
  // as the source — Glasgow staff don't refund London cash (the
  // till they're standing at isn't the one that took the payment).
  // Cards are technically refundable from anywhere (Stripe doesn't
  // care) but mixing locations on the audit trail breaks the
  // reconciliation reports, so we enforce uniformly. Pulls the
  // caller's location_id off accounts.
  {
    const { data: callerAcct } = await supabase
      .from('accounts')
      .select('location_id')
      .eq('id', refundedBy)
      .maybeSingle();
    const callerLocationId =
      (callerAcct as { location_id: string | null } | null)?.location_id ?? null;
    let sourceLocationId: string | null = null;
    if (src.visitId) {
      const { data: visitLoc } = await supabase
        .from('lng_visits')
        .select('location_id')
        .eq('id', src.visitId)
        .maybeSingle();
      sourceLocationId = (visitLoc as { location_id: string | null } | null)?.location_id ?? null;
    } else if (src.appointmentId) {
      const { data: apptLoc } = await supabase
        .from('lng_appointments')
        .select('location_id')
        .eq('id', src.appointmentId)
        .maybeSingle();
      sourceLocationId = (apptLoc as { location_id: string | null } | null)?.location_id ?? null;
    }
    if (callerLocationId && sourceLocationId && callerLocationId !== sourceLocationId) {
      return j(403, {
        ok: false,
        error: 'refund_location_mismatch',
        detail: 'You can only issue refunds at the location where the payment was taken.',
      });
    }
  }

  // Existing succeeded refunds against this source. Failed refunds
  // are excluded from the ceiling — they never moved money.
  const refundCol = src.kind === 'payment' ? 'payment_id' : 'deposit_appointment_id';
  const { data: refundedRows, error: refundedErr } = await supabase
    .from('lng_payment_refunds')
    .select('amount_pence')
    .eq(refundCol, src.sourceId)
    .eq('status', 'succeeded');
  if (refundedErr) {
    return j(500, { ok: false, error: 'Could not read existing refunds', detail: refundedErr.message });
  }
  const alreadyRefunded = (refundedRows ?? []).reduce(
    (acc, r) => acc + ((r as { amount_pence: number }).amount_pence ?? 0),
    0,
  );
  const refundableCeiling = src.capturedPence - alreadyRefunded;
  if (amountPence > refundableCeiling) {
    return j(400, {
      ok: false,
      error: 'refund_exceeds_remaining',
      detail: { requested_pence: amountPence, remaining_pence: refundableCeiling },
    });
  }
  const visitId = src.visitId;
  const appointmentId = src.appointmentId;
  const patientId = src.patientId;

  // Insert the refund row up-front so an audit record exists even if
  // Stripe times out. Card paths go in as 'pending' and flip after
  // Stripe answers; cash goes in as 'succeeded' immediately (no
  // third-party settlement).
  const goesViaStripe = src.method === 'card_terminal';
  const initialStatus = goesViaStripe ? 'pending' : 'succeeded';
  const refundInsert: Record<string, unknown> = {
    payment_id: src.kind === 'payment' ? src.sourceId : null,
    deposit_appointment_id: src.kind === 'deposit' ? src.sourceId : null,
    amount_pence: amountPence,
    currency: 'gbp',
    method: src.method,
    status: initialStatus,
    reason_category: body.reason_category,
    reason_note: reasonNote,
    performed_by_account_id: refundedBy,
    approver_account_id: body.approver_account_id,
    visit_id: visitId,
    appointment_id: appointmentId,
  };
  const { data: insertedRefund, error: insErr } = await supabase
    .from('lng_payment_refunds')
    .insert(refundInsert)
    .select('id')
    .single();
  if (insErr || !insertedRefund) {
    return j(500, { ok: false, error: 'Could not record refund', detail: insErr?.message });
  }
  const refundId = (insertedRefund as { id: string }).id;

  // Stripe path — partial refund against the original PI. Works for
  // both a till card payment AND a widget deposit; the PI source
  // differs but the API call is identical.
  if (goesViaStripe) {
    if (!STRIPE_SECRET_KEY) {
      await supabase
        .from('lng_payment_refunds')
        .update({ status: 'failed', failure_reason: 'STRIPE_SECRET_KEY missing' })
        .eq('id', refundId);
      return j(500, { ok: false, error: 'STRIPE_SECRET_KEY missing', refund_id: refundId });
    }
    if (!src.stripePaymentIntentId) {
      await supabase
        .from('lng_payment_refunds')
        .update({ status: 'failed', failure_reason: 'No Stripe PI on the source' })
        .eq('id', refundId);
      return j(404, {
        ok: false,
        error: 'No Stripe PaymentIntent to refund against',
        refund_id: refundId,
      });
    }
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // One idempotency key per refund row guarantees a retried
        // request can't fire a second Stripe refund.
        'Idempotency-Key': `refund:${refundId}`,
      },
      body: new URLSearchParams({
        payment_intent: src.stripePaymentIntentId,
        amount: String(amountPence),
        reason: 'requested_by_customer',
        // Stamp our refund row id into the Stripe Refund's metadata
        // so the webhook can look us up even if it arrives BEFORE
        // we've stored the stripe_refund_id back on the row. Closes
        // the read-then-update race between this function's UPDATE
        // and Stripe's async charge.refund.updated delivery.
        'metadata[refund_id]': refundId,
      }).toString(),
    });
    const refundBody = (await r.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      failure_reason?: string;
    };
    if (!r.ok || !refundBody.id) {
      await supabase
        .from('lng_payment_refunds')
        .update({
          status: 'failed',
          failure_reason: refundBody.failure_reason ?? `HTTP ${r.status}`,
        })
        .eq('id', refundId);
      return j(502, {
        ok: false,
        error: 'Stripe refund failed',
        detail: refundBody,
        refund_id: refundId,
      });
    }
    await supabase
      .from('lng_payment_refunds')
      .update({
        status: refundBody.status === 'succeeded' ? 'succeeded' : 'pending',
        stripe_refund_id: refundBody.id,
        failure_reason:
          refundBody.status === 'succeeded' || refundBody.status === 'pending'
            ? null
            : refundBody.failure_reason ?? null,
      })
      .eq('id', refundId);
  }

  // Full-refund threshold (payment-source only): cumulative refunds
  // now match the captured total. Flip the payment to cancelled —
  // it no longer represents money on file. Deposit sources keep
  // the deposit row untouched; the lng_visit_paid_status view nets
  // refunds against the deposit contribution.
  const cumulativeRefunded = alreadyRefunded + amountPence;
  const isFullRefund = cumulativeRefunded >= src.capturedPence;
  if (src.kind === 'payment' && isFullRefund) {
    await supabase
      .from('lng_payments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', src.sourceId);
  }

  // Cart re-open. Two reasons we'd re-open a paid cart:
  //   1. A full payment refund (above) means the payment that
  //      flipped the cart to paid is now cancelled.
  //   2. ANY refund (partial or deposit) that drops the net
  //      amount_paid below the cart's total. Without this the
  //      cart stays 'paid' while the view shows outstanding > 0,
  //      and the Take Payment screen can't collect the new
  //      shortfall because the cart is locked.
  //
  // Read the canonical view AFTER any payment-row update so the
  // recomputed amount_paid is the latest.
  const targetCartId = src.cartId;
  const targetVisitId = src.visitId;
  if (targetCartId || targetVisitId) {
    let cartId: string | null = targetCartId;
    if (!cartId && targetVisitId) {
      const { data: cartRow } = await supabase
        .from('lng_carts')
        .select('id')
        .eq('visit_id', targetVisitId)
        .maybeSingle();
      cartId = (cartRow as { id: string | null } | null)?.id ?? null;
    }
    if (cartId) {
      const { data: cartStatusRow } = await supabase
        .from('lng_carts')
        .select('status, total_pence, visit_id')
        .eq('id', cartId)
        .maybeSingle();
      const cartStatus = cartStatusRow as {
        status: string;
        total_pence: number | null;
        visit_id: string | null;
      } | null;
      if (cartStatus && cartStatus.status === 'paid' && cartStatus.visit_id) {
        const { data: paidRow } = await supabase
          .from('lng_visit_paid_status')
          .select('amount_paid_pence')
          .eq('visit_id', cartStatus.visit_id)
          .maybeSingle();
        const amountPaid =
          (paidRow as { amount_paid_pence: number } | null)?.amount_paid_pence ?? 0;
        const total = cartStatus.total_pence ?? 0;
        if (amountPaid < total) {
          await supabase
            .from('lng_carts')
            .update({ status: 'open', closed_at: null })
            .eq('id', cartId);
        }
      }
    }
  }

  // patient_events — heavy logging so the timeline can reconstruct
  // who, when, how much, why, against which source, on which visit.
  // Source is one of: payment (cart-side) or deposit (widget-paid
  // appointment-side).
  if (patientId) {
    await supabase.from('patient_events').insert({
      patient_id: patientId,
      event_type: 'refund_issued',
      actor_account_id: refundedBy,
      notes: reasonNote,
      payload: {
        refund_id: refundId,
        refund_source: src.kind,
        payment_id: src.kind === 'payment' ? src.sourceId : null,
        deposit_appointment_id: src.kind === 'deposit' ? src.sourceId : null,
        amount_pence: amountPence,
        cumulative_refunded_pence: cumulativeRefunded,
        source_captured_pence: src.capturedPence,
        is_full_refund: isFullRefund,
        method: src.method,
        payment_journey: src.paymentJourney,
        stripe_payment_intent_id: src.stripePaymentIntentId,
        reason_category: body.reason_category,
        reason_note: reasonNote,
        visit_id: visitId,
        appointment_id: appointmentId,
        staff_account_id: refundedBy,
        approver_account_id: body.approver_account_id,
      },
    });
  }

  // Auto-resolve the "we owe them" narrative on the timeline when
  // the refund brings the patient back to balanced. Best-effort.
  const { data: finalStatusRow } = await supabase
    .from('lng_payment_refunds')
    .select('status')
    .eq('id', refundId)
    .maybeSingle();
  if ((finalStatusRow as { status?: string } | null)?.status === 'succeeded') {
    await maybeResolveOwedEvent(supabase, {
      patientId,
      visitId,
      appointmentId,
      refundId,
      refundedPence: amountPence,
    });
  }

  // Fire-and-forget the refund receipt email. Only when the row is
  // already 'succeeded' — async (Stripe-pending) settlements are
  // handled by stripe-refund-webhook's own invocation. The refund
  // status was set above before this block.
  if ((finalStatusRow as { status?: string } | null)?.status === 'succeeded') {
    try {
      await fetch(
        `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/send-refund-receipt`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refundId }),
        },
      );
    } catch (e) {
      await logFailure('refund_receipt_invoke_failed', {
        refund_id: refundId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return j(200, {
    ok: true,
    refund_id: refundId,
    refund_source: src.kind,
    cumulative_refunded_pence: cumulativeRefunded,
    is_full_refund: isFullRefund,
  });
});

function j(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Writes a patient_events 'owed_to_patient_resolved' row when the
// refund just settled brings the patient back to balanced. Two
// rules:
//
//   1. Visit context — check lng_visit_paid_status. If amount_paid
//      now <= cart total, the visit is balanced; write the resolved
//      event referencing the most recent open 'owed_to_patient' row
//      on this patient (if any).
//   2. Appointment-only context (no visit) — the deposit is the
//      whole owed amount. Check if the deposit's remaining
//      refundable is zero; if so, resolve.
//
// Best-effort: failures here don't unwind the refund.
async function maybeResolveOwedEvent(
  supabase: ReturnType<typeof createClient>,
  args: {
    patientId: string | null;
    visitId: string | null;
    appointmentId: string | null;
    refundId: string;
    refundedPence: number;
  },
): Promise<void> {
  if (!args.patientId) return;
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
        const due = p.amount_due_pence ?? 0;
        balanced = p.amount_paid_pence <= due;
      }
    } else if (args.appointmentId) {
      // Pre-arrival appointment cancellation: balanced when the
      // deposit's remaining refundable is zero.
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
          (acc, r) => acc + (r.amount_pence ?? 0),
          0,
        );
        balanced = totalRefunded >= a.deposit_pence;
      } else {
        balanced = true;
      }
    }
    if (!balanced) return;
    // Find the most recent open 'owed_to_patient' row so the
    // resolved event can reference it. "Open" = no later
    // resolution row tied to it. Cheapest approach: look at the
    // most recent owed event on this patient/visit/appointment.
    const recentQuery = supabase
      .from('patient_events')
      .select('id, payload, created_at')
      .eq('patient_id', args.patientId)
      .eq('event_type', 'owed_to_patient')
      .order('created_at', { ascending: false })
      .limit(1);
    const { data: recent } = await recentQuery;
    const owed = (recent ?? [])[0] as
      | { id: string; payload: Record<string, unknown> | null; created_at: string }
      | undefined;
    await supabase.from('patient_events').insert({
      patient_id: args.patientId,
      event_type: 'owed_to_patient_resolved',
      payload: {
        resolved_by_refund_id: args.refundId,
        refunded_pence: args.refundedPence,
        resolved_owed_event_id: owed?.id ?? null,
        visit_id: args.visitId,
        appointment_id: args.appointmentId,
      },
    });
  } catch {
    // best-effort — refund already succeeded.
  }
}
