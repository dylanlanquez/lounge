import { supabase } from '../supabase.ts';

// recordOwedToPatient — best-effort logger for the moment Lounge
// realises it owes the patient money.
//
// Three categories of trigger produce an owed-to-patient state:
//
//   1. Cart edit on a paid visit. The customer paid (deposit, till,
//      or both). Staff removes an item or drops a quantity; the
//      cart total falls below what's already paid. The DELTA is
//      what we owe back.
//
//   2. Visit-level termination on a paid visit. End-early or full
//      cancellation while money is on file means we owe the lot
//      back (less anything we genuinely earned, which staff captures
//      via the refund sheet's amount input — the event just flags
//      the moment).
//
//   3. Appointment cancellation with a paid widget deposit. The
//      visit may not exist yet; the deposit alone is the owed amount.
//
// Every call writes a single patient_events row with event_type
// 'owed_to_patient'. The RefundSheet is the action; this is the
// audit. Failure here is logged to console but never propagates —
// it's never load-bearing on the parent flow (refund happens
// independently; the timeline event is descriptive, not constitutive).

export type OwedTrigger =
  | 'cart_line_removed'
  | 'cart_quantity_decreased'
  | 'cart_discount_applied'
  | 'visit_ended_early'
  | 'visit_cancelled'
  | 'appointment_cancelled';

export interface OwedToPatientInput {
  patient_id: string;
  trigger: OwedTrigger;
  owed_pence: number;
  /** Visit when the trigger sits on a visit. Null for pre-arrival
   *  appointment cancellation. */
  visit_id: string | null;
  /** Appointment when the trigger touches one. Walk-ins set null. */
  appointment_id: string | null;
  /** Human-readable line written verbatim to patient_events.notes
   *  AND patient_events.payload.note. Example: "Removed Whitening
   *  Tray (Upper)" or "Patient asked to cancel via email at 14:02". */
  reason: string;
  /** Extra context the trigger can attach. Anything trigger-specific
   *  goes in here (cart item id, line name, qty before/after,
   *  appointment ref, etc) — kept loose so each call site can
   *  carry the right info without forcing a tight shared shape. */
  context?: Record<string, unknown>;
}

export async function recordOwedToPatient(input: OwedToPatientInput): Promise<void> {
  if (!input.patient_id) return;
  if (!Number.isFinite(input.owed_pence) || input.owed_pence <= 0) return;
  try {
    const { data: accountId } = await supabase.rpc('auth_account_id');
    await supabase.from('patient_events').insert({
      patient_id: input.patient_id,
      event_type: 'owed_to_patient',
      actor_account_id: (accountId as string | null) ?? null,
      notes: input.reason.trim() || null,
      payload: {
        trigger: input.trigger,
        owed_pence: Math.round(input.owed_pence),
        visit_id: input.visit_id,
        appointment_id: input.appointment_id,
        reason: input.reason.trim(),
        ...(input.context ?? {}),
      },
    });
  } catch (e) {
    // Audit miss is not fatal — log + move on. The refund row that
    // (presumably) follows will still create its own patient_events
    // 'refund_issued' entry.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn('[recordOwedToPatient] insert failed', e);
    }
  }
}
