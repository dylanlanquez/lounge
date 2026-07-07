import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Balance write-offs — forgiving an uncollectable outstanding balance.
//
// A write-off is neither a payment nor a refund. It records that the
// clinic has stopped chasing an outstanding balance (e.g. a patient
// paid a deposit then never came back and never answered the phone),
// closes the sale off the in-clinic board, and leaves the collected
// money untouched so revenue reporting stays honest. It is fully
// reversible: reinstating reopens the balance so staff can take
// payment if the patient returns.
//
// All the heavy lifting is in two SECURITY DEFINER RPCs
// (lng_write_off_balance / lng_reinstate_written_off_balance), both
// gated on auth_can_write_off(). This module is a thin client over
// them plus the Admin list read.

export type WriteOffReasonCategory =
  | 'uncontactable'
  | 'goodwill'
  | 'duplicate'
  | 'other';

export const WRITE_OFF_REASONS: { category: WriteOffReasonCategory; label: string }[] = [
  { category: 'uncontactable', label: 'Could not reach the patient to collect' },
  { category: 'goodwill', label: 'Goodwill gesture' },
  { category: 'duplicate', label: 'Duplicate or erroneous charge' },
  { category: 'other', label: 'Other' },
];

const REASON_LABELS: Record<WriteOffReasonCategory, string> = Object.fromEntries(
  WRITE_OFF_REASONS.map((r) => [r.category, r.label]),
) as Record<WriteOffReasonCategory, string>;

export function writeOffReasonLabel(category: string): string {
  return REASON_LABELS[category as WriteOffReasonCategory] ?? category;
}

// Write off the outstanding balance on an open, arrived visit's cart.
// The RPC computes the exact outstanding, records the write-off, and
// closes the visit. Returns the new write-off id. Throws loudly on any
// invalid state (nothing owed, cart not open, not authorised).
export async function writeOffBalance(input: {
  cartId: string;
  reasonCategory: WriteOffReasonCategory;
  note: string;
}): Promise<string> {
  const note = input.note.trim();
  if (note.length === 0) throw new Error('A reason is required to write off a balance.');
  const { data, error } = await supabase.rpc('lng_write_off_balance', {
    p_cart_id: input.cartId,
    p_reason_category: input.reasonCategory,
    p_note: note,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

// Reverse a live write-off: reopen the cart and the visit so the
// balance can be collected if the patient comes back.
export async function reinstateWriteOff(input: {
  cartId: string;
  note: string;
}): Promise<void> {
  const note = input.note.trim();
  if (note.length === 0) throw new Error('A reason is required to reinstate a written-off balance.');
  const { error } = await supabase.rpc('lng_reinstate_written_off_balance', {
    p_cart_id: input.cartId,
    p_note: note,
  });
  if (error) throw new Error(error.message);
}

export interface BalanceWriteoffRow {
  id: string;
  cartId: string;
  visitId: string;
  patientId: string;
  patientName: string;
  /** LAP-NNNNN appointment ref for the visit, when it has one. */
  appointmentRef: string | null;
  amountPence: number;
  reasonCategory: string;
  reasonNote: string;
  writtenOffByName: string | null;
  writtenOffAt: string;
  reinstatedAt: string | null;
  reinstatedByName: string | null;
  reinstatedReason: string | null;
  /** True while the write-off is live (not reinstated). */
  isLive: boolean;
}

// Compose a display name from an embedded accounts / patients row.
function nameOf(
  row: { first_name?: string | null; last_name?: string | null; name?: string | null } | null,
): string | null {
  if (!row) return null;
  const fn = row.first_name?.trim() ?? null;
  const ln = row.last_name?.trim() ?? null;
  if (fn && ln) return `${fn} ${ln}`;
  return fn ?? ln ?? row.name?.trim() ?? null;
}

interface RawWriteoff {
  id: string;
  cart_id: string;
  visit_id: string;
  patient_id: string;
  amount_pence: number;
  reason_category: string;
  reason_note: string;
  written_off_at: string;
  reinstated_at: string | null;
  reinstated_reason: string | null;
  patient: { first_name: string | null; last_name: string | null } | null;
  written_off_by_account: { first_name: string | null; last_name: string | null; name: string | null } | null;
  reinstated_by_account: { first_name: string | null; last_name: string | null; name: string | null } | null;
  visit: {
    appointment: { appointment_ref: string | null } | null;
    walk_in: { appointment_ref: string | null } | null;
  } | null;
}

const WRITEOFF_SELECT =
  'id, cart_id, visit_id, patient_id, amount_pence, reason_category, reason_note, ' +
  'written_off_at, reinstated_at, reinstated_reason, ' +
  'patient:patients!patient_id(first_name, last_name), ' +
  'written_off_by_account:accounts!written_off_by(first_name, last_name, name), ' +
  'reinstated_by_account:accounts!reinstated_by(first_name, last_name, name), ' +
  'visit:lng_visits!visit_id(' +
  'appointment:lng_appointments!appointment_id(appointment_ref), ' +
  'walk_in:lng_walk_ins!walk_in_id(appointment_ref))';

export async function listBalanceWriteoffs(): Promise<BalanceWriteoffRow[]> {
  const { data, error } = await supabase
    .from('lng_balance_writeoffs')
    .select(WRITEOFF_SELECT)
    .order('written_off_at', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RawWriteoff[];
  return rows.map((r) => ({
    id: r.id,
    cartId: r.cart_id,
    visitId: r.visit_id,
    patientId: r.patient_id,
    patientName: nameOf(r.patient) ?? 'Unknown patient',
    appointmentRef:
      r.visit?.appointment?.appointment_ref ?? r.visit?.walk_in?.appointment_ref ?? null,
    amountPence: r.amount_pence,
    reasonCategory: r.reason_category,
    reasonNote: r.reason_note,
    writtenOffByName: nameOf(r.written_off_by_account),
    writtenOffAt: r.written_off_at,
    reinstatedAt: r.reinstated_at,
    reinstatedByName: nameOf(r.reinstated_by_account),
    reinstatedReason: r.reinstated_reason,
    isLive: r.reinstated_at === null,
  }));
}

export function useBalanceWriteoffs() {
  const [rows, setRows] = useState<BalanceWriteoffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await listBalanceWriteoffs();
        if (cancelled) return;
        setRows(list);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load write-offs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { rows, loading, error, refresh };
}
