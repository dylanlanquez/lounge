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
