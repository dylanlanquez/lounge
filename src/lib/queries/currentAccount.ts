import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useAuth } from '../auth.tsx';

// ─────────────────────────────────────────────────────────────────────────────
// useCurrentAccount — resolves the signed-in user's row from
// public.accounts (Meridian's shared identity table) and exposes the
// fields Lounge surfaces UX-wise.
//
// The auth.users id and accounts.id are different. RPC auth_account_id
// translates between them (the same RPC used everywhere we stamp
// actor ids on inserts). This hook fetches the row in one shot per
// session and caches it in component state.
//
// What we expose:
//   • account_id      — accounts.id (NOT auth.users.id)
//   • first_name, last_name
//   • display_name    — composed: "First Last", falls back to single
//                       name, then email local-part. Used for the
//                       witness field default and any "by Dylan Lane"
//                       attribution.
//   • login_email     — accounts.login_email
//   • account_types   — array; e.g. ['admin', 'lab']
//   • is_admin        — 'admin' is in account_types
//   • is_super_admin  — login_email === SUPER_ADMIN_EMAIL. The super
//                       admin can grant/revoke 'admin' on others; a
//                       normal admin can't promote themselves.
//
// Single super admin for now: dylan@lanquez.com. That's a hard-coded
// rule rather than a database flag because the role is operationally
// fixed (it's the account-owner of the Stripe + Supabase project),
// not something staff toggles. If that ever changes we'd graduate it
// to a column.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPER_ADMIN_EMAIL = 'dylan@lanquez.com';

export interface CurrentAccount {
  account_id: string;
  auth_user_id: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  login_email: string;
  location_id: string | null;
  account_types: string[];
  is_admin: boolean;
  is_super_admin: boolean;
}

interface Result {
  account: CurrentAccount | null;
  loading: boolean;
  error: string | null;
}

export function useCurrentAccount(): Result {
  const { user, loading: authLoading } = useAuth();
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setAccount(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // auth.users.id → accounts.id via the existing RPC.
      const { data: idRaw, error: idErr } = await supabase.rpc('auth_account_id');
      if (cancelled) return;
      if (idErr) {
        setError(idErr.message);
        setLoading(false);
        return;
      }
      const accountId = idRaw as string | null;
      if (!accountId) {
        // Auth user without a paired accounts row — surface as null
        // rather than throwing so callers degrade gracefully (witness
        // fields fall back to email, admin gate fails safely closed).
        setAccount(null);
        setLoading(false);
        return;
      }

      const { data: row, error: rowErr } = await supabase
        .from('accounts')
        .select('id, auth_user_id, first_name, last_name, name, login_email, location_id, account_types')
        .eq('id', accountId)
        .maybeSingle();
      if (cancelled) return;
      if (rowErr) {
        setError(rowErr.message);
        setLoading(false);
        return;
      }
      if (!row) {
        setAccount(null);
        setLoading(false);
        return;
      }
      const r = row as {
        id: string;
        auth_user_id: string | null;
        first_name: string | null;
        last_name: string | null;
        name: string | null;
        login_email: string;
        location_id: string | null;
        account_types: string[] | null;
      };
      const fn = r.first_name?.trim() ?? null;
      const ln = r.last_name?.trim() ?? null;
      const display =
        fn && ln
          ? `${fn} ${ln}`
          : fn ?? ln ?? r.name?.trim() ?? r.login_email.split('@')[0] ?? r.login_email;
      const types = r.account_types ?? [];
      setAccount({
        account_id: r.id,
        auth_user_id: r.auth_user_id,
        first_name: fn,
        last_name: ln,
        display_name: display,
        login_email: r.login_email,
        location_id: r.location_id,
        account_types: types,
        is_admin: types.includes('admin'),
        is_super_admin: r.login_email === SUPER_ADMIN_EMAIL,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  return { account, loading, error };
}
