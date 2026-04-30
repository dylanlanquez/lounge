import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Staff = any accounts row with a login_email set. Powers the
// Admin > Staff tab. Two toggles per row:
//
//   • is_manager — boolean column. Lets the row authorise discounts /
//     voids; managers re-enter their password when signing off, the
//     dropdown alone isn't enough.
//   • is_admin    — derived from account_types containing 'admin'.
//     Admins can open the Admin tab itself. Only the super admin can
//     flip this on/off (UI gate, see currentAccount.ts). Read by the
//     /admin route gate + the kiosk Settings button.
//
// Names come from accounts.first_name / last_name (the Meridian
// migration backfilled these from auth display names). The legacy
// `name` column is the last-ditch fallback so a row that pre-dates
// the migration still reads as something other than its uuid.

export interface StaffRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  login_email: string;
  account_types: string[];
  is_manager: boolean;
  is_admin: boolean;
}

interface Result {
  data: StaffRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useStaff(): Result {
  const [data, setData] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('accounts')
        .select('id, first_name, last_name, name, login_email, is_manager, account_types')
        .not('login_email', 'is', null);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const mapped: StaffRow[] = ((rows ?? []) as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        name: string | null;
        login_email: string | null;
        is_manager: boolean | null;
        account_types: string[] | null;
      }>)
        .map((r) => {
          const fn = r.first_name?.trim() ?? null;
          const ln = r.last_name?.trim() ?? null;
          const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? r.name?.trim() ?? r.login_email ?? r.id;
          const types = r.account_types ?? [];
          return {
            id: r.id,
            first_name: fn,
            last_name: ln,
            display_name: display,
            login_email: r.login_email ?? '',
            account_types: types,
            is_manager: r.is_manager === true,
            is_admin: types.includes('admin'),
          };
        })
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

export async function setIsManager(accountId: string, isManager: boolean): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ is_manager: isManager })
    .eq('id', accountId);
  if (error) throw new Error(error.message);
}

// Adds or removes 'admin' from account_types. Other roles in the
// array (lab, dental_practice, internal, etc.) are preserved — the
// Lounge admin toggle only manages the 'admin' membership flag, never
// the broader Meridian account-type model. Reads the existing array
// first so we don't overwrite roles set elsewhere.
export async function setIsAdmin(accountId: string, isAdmin: boolean): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from('accounts')
    .select('account_types')
    .eq('id', accountId)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  const current = ((row as { account_types: string[] | null } | null)?.account_types ?? []) as string[];
  let next: string[];
  if (isAdmin) {
    if (current.includes('admin')) return; // no-op
    next = ['admin', ...current.filter((t) => t !== 'admin')];
  } else {
    if (!current.includes('admin')) return; // no-op
    next = current.filter((t) => t !== 'admin');
    if (next.length === 0) next = ['internal']; // schema requires non-empty
  }
  const { error } = await supabase
    .from('accounts')
    .update({ account_types: next })
    .eq('id', accountId);
  if (error) throw new Error(error.message);
}

// First-name / last-name editor. Lounge surfaces these on every
// signature attribution and the witness default — staff add or
// correct them from the Admin > Staff tab so the witness field
// auto-populates correctly.
export async function setStaffName(
  accountId: string,
  firstName: string | null,
  lastName: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({
      first_name: firstName?.trim() || null,
      last_name: lastName?.trim() || null,
    })
    .eq('id', accountId);
  if (error) throw new Error(error.message);
}
