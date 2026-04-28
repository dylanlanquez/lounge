import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface SystemFailureRow {
  id: string;
  occurred_at: string;
  source: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  context: Record<string, unknown> | null;
  resolved_at: string | null;
}

export interface ReceptionistSessionRow {
  id: string;
  account_id: string;
  device_id: string;
  device_label: string | null;
  signed_in_at: string;
  last_seen_at: string;
  locked_at: string | null;
  ended_at: string | null;
  revoked_at: string | null;
}

export interface ReportingTotalsRow {
  date: string;
  payments_count: number;
  payments_total_pence: number;
  cash_pence: number;
  card_pence: number;
  klarna_pence: number;
  clearpay_pence: number;
}

export function useUnresolvedFailures() {
  const [data, setData] = useState<SystemFailureRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('lng_system_failures')
        .select('id, occurred_at, source, severity, message, context, resolved_at')
        .is('resolved_at', null)
        .order('occurred_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      setData((rows ?? []) as SystemFailureRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);
  return { data, loading };
}

export function useReceptionistSessions() {
  const [data, setData] = useState<ReceptionistSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('lng_receptionist_sessions')
        .select('id, account_id, device_id, device_label, signed_in_at, last_seen_at, locked_at, ended_at, revoked_at')
        .order('signed_in_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      setData((rows ?? []) as ReceptionistSessionRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);
  return { data, loading };
}

export interface PendingReceiptRow {
  id: string;
  payment_id: string;
  channel: 'email' | 'sms' | 'print' | 'none';
  recipient: string | null;
  failure_reason: string | null;
  created_at: string;
}

export function usePendingReceipts() {
  const [data, setData] = useState<PendingReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // sent_at IS NULL OR failure_reason IS NOT NULL — anything still owed.
      const { data: rows } = await supabase
        .from('lng_receipts')
        .select('id, payment_id, channel, recipient, failure_reason, created_at, sent_at')
        .or('sent_at.is.null,failure_reason.not.is.null')
        .in('channel', ['email', 'sms'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      setData((rows ?? []).filter((r) => !r.sent_at || r.failure_reason) as PendingReceiptRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tick]);
  return { data, loading, refresh: () => setTick((t) => t + 1) };
}

export async function retrySendReceipt(receiptId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return { ok: false, error: 'Not signed in' };
    const url = new URL(import.meta.env.VITE_SUPABASE_URL);
    const projectRef = url.hostname.split('.')[0];
    const r = await fetch(`https://${projectRef}.functions.supabase.co/send-receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body?.ok) return { ok: false, error: body?.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

export interface DirtyAppointmentRow {
  id: string;
  start_at: string;
  status: string;
  event_type_label: string | null;
  patient_id: string;
  first_name: string | null;
  last_name: string | null;
}

// Lists Calendly appointments that have moved out of the default 'booked'
// state — the typical residue of poking through the app while testing.
// Bounded to past 14 days through next 60 so the list stays useful.
export function useDirtyAppointments() {
  const [data, setData] = useState<DirtyAppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const until = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from('lng_appointments')
        .select(
          `id, start_at, status, event_type_label, patient_id,
           patient:patients ( first_name, last_name )`
        )
        .eq('source', 'calendly')
        .not('status', 'in', '(booked,cancelled,rescheduled)')
        .gte('start_at', since)
        .lte('start_at', until)
        .order('start_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      const mapped: DirtyAppointmentRow[] = (rows ?? []).map((r) => {
        const raw = r as unknown as {
          id: string;
          start_at: string;
          status: string;
          event_type_label: string | null;
          patient_id: string;
          patient:
            | { first_name: string | null; last_name: string | null }
            | { first_name: string | null; last_name: string | null }[]
            | null;
        };
        const p = Array.isArray(raw.patient) ? raw.patient[0] : raw.patient;
        return {
          id: raw.id,
          start_at: raw.start_at,
          status: raw.status,
          event_type_label: raw.event_type_label,
          patient_id: raw.patient_id,
          first_name: p?.first_name ?? null,
          last_name: p?.last_name ?? null,
        };
      });
      setData(mapped);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tick]);

  return { data, loading, refresh: () => setTick((t) => t + 1) };
}

// Reverts a single appointment back to its pristine 'booked' state and
// removes any visit / cart / payments created during testing. Tries to
// honour the schema's restrict-on-delete by deleting children before
// parents. Patient_events are left in place — they're audit history.
export async function resetTestAppointment(appointmentId: string): Promise<void> {
  const { data: visits } = await supabase
    .from('lng_visits')
    .select('id')
    .eq('appointment_id', appointmentId);
  for (const v of (visits ?? []) as Array<{ id: string }>) {
    const { data: carts } = await supabase
      .from('lng_carts')
      .select('id')
      .eq('visit_id', v.id);
    for (const c of (carts ?? []) as Array<{ id: string }>) {
      // Children of payments first
      const { data: pays } = await supabase
        .from('lng_payments')
        .select('id')
        .eq('cart_id', c.id);
      for (const p of (pays ?? []) as Array<{ id: string }>) {
        await supabase.from('lng_terminal_payments').delete().eq('payment_id', p.id);
        await supabase.from('lng_receipts').delete().eq('payment_id', p.id);
      }
      await supabase.from('lng_payments').delete().eq('cart_id', c.id);
      await supabase.from('lng_cart_items').delete().eq('cart_id', c.id);
      await supabase.from('lng_carts').delete().eq('id', c.id);
    }
    await supabase.from('lng_visits').delete().eq('id', v.id);
  }
  await supabase.from('lng_appointments').update({ status: 'booked' }).eq('id', appointmentId);
}

// Aggregates payments by day for the last N days. Falls back to client-side
// roll-up since we don't have a dedicated reporting view yet (slice 22 v2).
export function usePaymentTotals(daysBack = 7) {
  const [data, setData] = useState<ReportingTotalsRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - daysBack);
      const { data: rows } = await supabase
        .from('lng_payments')
        .select('amount_pence, method, payment_journey, status, succeeded_at, created_at')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false });

      if (cancelled) return;
      const buckets = new Map<string, ReportingTotalsRow>();
      (rows ?? []).forEach((p) => {
        if (p.status !== 'succeeded') return;
        const at = new Date(p.succeeded_at ?? p.created_at);
        const key = at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        let row = buckets.get(key);
        if (!row) {
          row = {
            date: key,
            payments_count: 0,
            payments_total_pence: 0,
            cash_pence: 0,
            card_pence: 0,
            klarna_pence: 0,
            clearpay_pence: 0,
          };
          buckets.set(key, row);
        }
        row.payments_count++;
        row.payments_total_pence += p.amount_pence;
        if (p.method === 'cash') row.cash_pence += p.amount_pence;
        else if (p.payment_journey === 'klarna' || p.payment_journey === 'klarna_legacy_shopify') row.klarna_pence += p.amount_pence;
        else if (p.payment_journey === 'clearpay' || p.payment_journey === 'clearpay_legacy_shopify') row.clearpay_pence += p.amount_pence;
        else row.card_pence += p.amount_pence;
      });
      setData(Array.from(buckets.values()));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [daysBack]);
  return { data, loading };
}
