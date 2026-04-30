import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Card payments admin log + health.
//
// Two surfaces:
//
//   1. useStripePaymentsLog — calls the terminal-list-payments edge
//      function which pulls the most-recent PaymentIntents off Stripe
//      and zips each one against the local lng_payments / cart / visit
//      / patient join. Used by Admin > Payments to show staff what
//      Stripe has captured vs. what Lounge recorded — the exact drift
//      detection that nearly produced a double-charge tonight.
//
//   2. useCardPaymentHealth — derives two health signals:
//        • webhook last seen — MAX(updated_at) on lng_terminal_payments
//          where raw_event is set. The webhook updates raw_event on
//          every event it processes, so this is a clean heartbeat.
//        • reconciler reachable — OPTIONS-style probe against
//          terminal-payment-status. Confirms the function is deployed
//          and Stripe creds are wired.
//
// Both refresh on demand via the returned `refresh` callback. The
// log calls Stripe's API every refresh; pagination is via the
// returned `ending_before` cursor (PI ids ordered desc by Stripe).
// ─────────────────────────────────────────────────────────────────────────────

export interface StripePaymentRow {
  stripe: {
    id: string;
    amount_pence: number;
    currency: string;
    status: string;
    created: number; // unix seconds
    last_payment_error: string | null;
  };
  local: {
    payment_id: string | null;
    status: string | null;
    succeeded_at: string | null;
    cancelled_at: string | null;
    failure_reason: string | null;
    amount_pence: number | null;
    payment_journey: string | null;
    cart_id: string | null;
    cart_status: string | null;
    cart_total_pence: number | null;
    visit_id: string | null;
    patient_id: string | null;
    patient_name: string | null;
    appointment_ref: string | null;
    taken_by: string | null;
  } | null;
  drift: boolean;
  orphan: boolean;
  expected_local_status: string | null;
}

interface PaymentsLogResult {
  rows: StripePaymentRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useStripePaymentsLog(limit: number = 50): PaymentsLogResult {
  const [rows, setRows] = useState<StripePaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error('Not signed in');
        const r = await fetch(
          `https://${supabaseProjectRef()}.functions.supabase.co/terminal-list-payments?limit=${limit}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error ?? 'Could not list payments');
        if (cancelled) return;
        setRows((body.rows ?? []) as StripePaymentRow[]);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not list payments');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [limit, tick]);

  return { rows, loading, error, refresh };
}

export interface CardPaymentHealth {
  webhookLastSeenISO: string | null;
  webhookState: 'green' | 'amber' | 'red' | 'unknown';
  reconcilerReachable: boolean | null;
  loading: boolean;
  refresh: () => void;
}

// 30 minutes → green, 24 hours → amber, beyond → red. Unknown when
// no terminal payments have ever been processed (a fresh deploy).
const WEBHOOK_GREEN_MS = 30 * 60 * 1000;
const WEBHOOK_AMBER_MS = 24 * 60 * 60 * 1000;

export function useCardPaymentHealth(): CardPaymentHealth {
  const [webhookLastSeen, setWebhookLastSeen] = useState<string | null>(null);
  const [webhookState, setWebhookState] = useState<'green' | 'amber' | 'red' | 'unknown'>('unknown');
  const [reconcilerReachable, setReconcilerReachable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Webhook heartbeat: most recent lng_terminal_payments row whose
      // raw_event is non-null. raw_event is written by terminal-webhook
      // on every event it processes, so MAX(updated_at) where
      // raw_event is not null is the freshest webhook timestamp. We
      // sort desc and take the top row to avoid relying on aggregate
      // queries through PostgREST.
      const { data: latestWebhook } = await supabase
        .from('lng_terminal_payments')
        .select('updated_at')
        .not('raw_event', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const ts = (latestWebhook as { updated_at: string } | null)?.updated_at ?? null;
      setWebhookLastSeen(ts);
      setWebhookState(classifyWebhookFreshness(ts));

      // Reconciler probe: OPTIONS preflight request returns 200 with
      // CORS headers when the function is deployed. We don't even need
      // to POST — preflight is the cheapest reachability signal and
      // doesn't risk side effects.
      try {
        const r = await fetch(
          `https://${supabaseProjectRef()}.functions.supabase.co/terminal-payment-status`,
          {
            method: 'OPTIONS',
            headers: { 'Access-Control-Request-Method': 'POST' },
          },
        );
        if (cancelled) return;
        setReconcilerReachable(r.ok);
      } catch {
        if (cancelled) return;
        setReconcilerReachable(false);
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { webhookLastSeenISO: webhookLastSeen, webhookState, reconcilerReachable, loading, refresh };
}

function classifyWebhookFreshness(iso: string | null): 'green' | 'amber' | 'red' | 'unknown' {
  if (!iso) return 'unknown';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < WEBHOOK_GREEN_MS) return 'green';
  if (ms < WEBHOOK_AMBER_MS) return 'amber';
  return 'red';
}

// Calls terminal-payment-status to reconcile a single Lounge payment
// row against Stripe. Returns the local_status the function landed
// on so the UI can refresh + report success/no-op to staff.
export async function reconcileTerminalPayment(paymentId: string): Promise<{
  local_status: string | null;
  stripe_status: string;
}> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const r = await fetch(
    `https://${supabaseProjectRef()}.functions.supabase.co/terminal-payment-status`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_id: paymentId }),
    },
  );
  const body = await r.json();
  if (!r.ok) throw new Error(body?.error ?? 'Reconcile failed');
  return body as { local_status: string | null; stripe_status: string };
}

function supabaseProjectRef(): string {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
