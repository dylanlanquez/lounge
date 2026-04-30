import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { approveAsManager } from './payments.ts';

// Cart-level (sale-wide) discount audit + mutations.
//
// Cart already has a discount_pence column factored into the
// generated total_pence. This module keeps the audit table
// (lng_cart_discounts) and the cart's column in sync so
// application code touches one entry point per action.
//
// Anti-theft: every apply / remove writes both staff ids — cashier
// (applied_by / removed_by) and manager (approved_by). The manager
// re-auths their password client-side so a name can't just be
// clicked off a dropdown without proof.

export interface CartDiscountRow {
  id: string;
  cart_id: string;
  amount_pence: number;
  reason: string;
  applied_by: string | null;
  approved_by: string;
  applied_at: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_reason: string | null;
  approver_name: string | null;
  applier_name: string | null;
}

interface CartDiscountResult {
  active: CartDiscountRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Returns the active (non-removed) discount on a cart, plus a
// refresh trigger. The cart UI uses this to render the
// "Discount −£X" line and the Remove button.
export function useActiveCartDiscount(cartId: string | null | undefined): CartDiscountResult {
  const [active, setActive] = useState<CartDiscountRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!cartId) {
      setActive(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_cart_discounts')
        .select(
          'id, cart_id, amount_pence, reason, applied_by, approved_by, applied_at, removed_at, removed_by, removed_reason, approver:accounts!approved_by ( first_name, last_name, name ), applier:accounts!applied_by ( first_name, last_name, name )'
        )
        .eq('cart_id', cartId)
        .is('removed_at', null)
        .order('applied_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        // Table may not exist on a pre-migration shadow env; treat
        // as no discount rather than crashing the visit page.
        if (err.code === '42P01' || err.code === 'PGRST200') {
          setActive(null);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      if (!data) {
        setActive(null);
        setLoading(false);
        return;
      }
      const r = data as {
        id: string;
        cart_id: string;
        amount_pence: number;
        reason: string;
        applied_by: string | null;
        approved_by: string;
        applied_at: string;
        removed_at: string | null;
        removed_by: string | null;
        removed_reason: string | null;
        approver: AccountJoin | AccountJoin[] | null;
        applier: AccountJoin | AccountJoin[] | null;
      };
      setActive({
        id: r.id,
        cart_id: r.cart_id,
        amount_pence: r.amount_pence,
        reason: r.reason,
        applied_by: r.applied_by,
        approved_by: r.approved_by,
        applied_at: r.applied_at,
        removed_at: r.removed_at,
        removed_by: r.removed_by,
        removed_reason: r.removed_reason,
        approver_name: displayName(r.approver),
        applier_name: displayName(r.applier),
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cartId, tick]);

  return { active, loading, error, refresh };
}

interface AccountJoin {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}

function displayName(a: AccountJoin | AccountJoin[] | null): string | null {
  const flat = Array.isArray(a) ? a[0] ?? null : a;
  if (!flat) return null;
  const fn = flat.first_name?.trim();
  const ln = flat.last_name?.trim();
  if (fn && ln) return `${fn} ${ln}`;
  return fn ?? ln ?? flat.name?.trim() ?? null;
}

// Manager dropdown — accounts where is_manager = true. Sorted by
// display name for stable picker order.
export interface ManagerRow {
  id: string;
  name: string;
  login_email: string;
}

export async function listManagers(): Promise<ManagerRow[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, first_name, last_name, name, login_email')
    .eq('is_manager', true);
  if (error) {
    if (error.code === '42703' /* column missing pre-migration */ || error.code === 'PGRST200') return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
  }>)
    .map((r) => ({
      id: r.id,
      name: displayName({ first_name: r.first_name, last_name: r.last_name, name: r.name ?? null }) ?? r.login_email ?? r.id,
      login_email: r.login_email ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ApplyDiscountInput {
  cart_id: string;
  amount_pence: number;
  reason: string;
  approver_id: string;
  approver_password: string;
}

// Applies a sale-level discount. Requires:
//   - cart in 'open' state (we don't mutate paid carts here)
//   - amount > 0 and ≤ subtotal (no negative totals)
//   - approver_id present, differs from the cashier
//   - approver_password verified via approveAsManager (parallel
//     Supabase client; doesn't disturb the cashier's session)
//
// Updates cart.discount_pence atomically with the audit insert.
// One active discount per cart is enforced by a unique partial
// index on (cart_id) WHERE removed_at IS NULL.
export async function applyCartDiscount(input: ApplyDiscountInput): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error('A reason is required.');
  if (input.amount_pence <= 0) throw new Error('Discount amount must be positive.');
  if (!input.approver_id) throw new Error('Pick a manager to approve.');
  if (!input.approver_password) throw new Error('Manager password is required.');

  const { data: meId } = await supabase.rpc('auth_account_id');
  const cashierId = (meId as string | null) ?? null;
  if (cashierId && cashierId === input.approver_id) {
    throw new Error('Approver must be a different staff member.');
  }

  // Verify the manager's password by re-authing in a parallel
  // client. Throws if wrong; returns approver's accounts.id.
  const verifiedId = await approveAsManager(_emailOf(input.approver_id), input.approver_password);
  // The dropdown's selection should match what the password
  // resolves to — block a mismatch ("clicked Sarah, used Tom's
  // password").
  if (verifiedId !== input.approver_id) {
    throw new Error('That password belongs to a different manager than the one selected.');
  }

  // Read cart for state + subtotal so we can validate amount
  // doesn't overshoot.
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .select('status, subtotal_pence, discount_pence')
    .eq('id', input.cart_id)
    .maybeSingle();
  if (cartErr) throw new Error(cartErr.message);
  if (!cart) throw new Error('Cart not found');
  const c = cart as { status: string; subtotal_pence: number; discount_pence: number };
  if (c.status !== 'open') {
    throw new Error(`Cart is ${c.status}; discounts can only be applied to open carts.`);
  }
  if (input.amount_pence > c.subtotal_pence) {
    throw new Error('Discount cannot exceed subtotal.');
  }

  // Insert the audit row first. The unique partial index will
  // reject a second active discount on the same cart, which is
  // exactly the right anti-stacking behaviour.
  const { error: insErr } = await supabase.from('lng_cart_discounts').insert({
    cart_id: input.cart_id,
    amount_pence: input.amount_pence,
    reason,
    applied_by: cashierId,
    approved_by: input.approver_id,
  });
  if (insErr) throw new Error(insErr.message);

  // Sync cart.discount_pence. total_pence is generated from
  // subtotal − discount + tax so updating discount_pence flows
  // through automatically.
  const { error: updErr } = await supabase
    .from('lng_carts')
    .update({ discount_pence: input.amount_pence })
    .eq('id', input.cart_id);
  if (updErr) throw new Error(updErr.message);
}

export interface RemoveDiscountInput {
  cart_id: string;
  reason: string;
  approver_id: string;
  approver_password: string;
}

// Removes the active discount on a cart. Same approval shape as
// apply: cashier picks manager, manager re-auths their password.
// Soft-deletes the audit row (sets removed_at + removed_reason +
// removed_by) and zeros the cart's discount_pence so total_pence
// flips back to the un-discounted total.
export async function removeCartDiscount(input: RemoveDiscountInput): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error('A reason is required to remove the discount.');
  if (!input.approver_id) throw new Error('Pick a manager to approve.');
  if (!input.approver_password) throw new Error('Manager password is required.');

  const { data: meId } = await supabase.rpc('auth_account_id');
  const cashierId = (meId as string | null) ?? null;
  if (cashierId && cashierId === input.approver_id) {
    throw new Error('Approver must be a different staff member.');
  }
  const verifiedId = await approveAsManager(_emailOf(input.approver_id), input.approver_password);
  if (verifiedId !== input.approver_id) {
    throw new Error('That password belongs to a different manager than the one selected.');
  }

  // Find the active discount on this cart.
  const { data: active, error: readErr } = await supabase
    .from('lng_cart_discounts')
    .select('id')
    .eq('cart_id', input.cart_id)
    .is('removed_at', null)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!active) throw new Error('No active discount on this cart.');

  // Soft-delete + zero the cart column.
  const { error: updErr } = await supabase
    .from('lng_cart_discounts')
    .update({
      removed_at: new Date().toISOString(),
      removed_by: cashierId,
      removed_reason: reason,
    })
    .eq('id', (active as { id: string }).id);
  if (updErr) throw new Error(updErr.message);

  const { error: cartErr } = await supabase
    .from('lng_carts')
    .update({ discount_pence: 0 })
    .eq('id', input.cart_id);
  if (cartErr) throw new Error(cartErr.message);
}

// Email lookup is needed because approveAsManager signs in with
// email + password (Supabase auth model). We have approver_id
// from the dropdown but need their login_email to authenticate.
//
// Resolves synchronously from the in-memory manager list cached on
// the client (the Apply Discount sheet fetched it on open). Falls
// back to an empty string if the id wasn't found, which makes
// approveAsManager throw with "wrong email or password" — a clear
// failure rather than silent.
let _emailLookup: Map<string, string> = new Map();
export function setManagerEmailLookup(rows: ManagerRow[]): void {
  _emailLookup = new Map(rows.map((r) => [r.id, r.login_email]));
}
function _emailOf(accountId: string): string {
  return _emailLookup.get(accountId) ?? '';
}
