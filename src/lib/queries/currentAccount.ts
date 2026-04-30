import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useAuth } from '../auth.tsx';
import { fetchCurrentStaffMembership } from './staff.ts';

// useCurrentAccount — resolves the signed-in user's identity row from
// public.accounts (shared with Meridian) PLUS their lng_staff_members
// row (Lounge-only). The accounts row gives identity (name, email,
// auth pairing); the staff row gives Lounge-specific permission flags.
//
// Permission flags now live on lng_staff_members rather than
// accounts.account_types — that's what keeps Lounge admin and
// Meridian admin completely independent. Demoting a Lounge admin
// flips one boolean here; it doesn't touch Meridian's role model.
//
// Three derived booleans the rest of Lounge cares about:
//
//   • is_lng_staff   — has an active row in lng_staff_members. False
//                      means this account exists in Meridian-land but
//                      isn't part of the Lounge clinic. UI gates on
//                      this everywhere; non-staff land on a "you don't
//                      have access" surface rather than the till.
//   • is_admin       — is_lng_staff && lng_staff_members.is_admin.
//                      Gates the Admin tab + Settings entry points.
//   • is_super_admin — login_email === SUPER_ADMIN_EMAIL. Only the
//                      super admin can promote/demote other admins
//                      via the Staff tab UI.
//
// `is_admin` aliasing: we keep the existing field name so the Admin
// tab gate code doesn't have to migrate. It now means "Lounge admin"
// rather than "Meridian admin" — distinct concept, same shape.

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
  // Lounge-staff membership flags. is_lng_staff is the gate to the
  // app; is_admin gates /admin specifically.
  staff_member_id: string | null;
  is_lng_staff: boolean;
  is_admin: boolean;
  is_manager: boolean;
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
      const { data: idRaw, error: idErr } = await supabase.rpc('auth_account_id');
      if (cancelled) return;
      if (idErr) {
        setError(idErr.message);
        setLoading(false);
        return;
      }
      const accountId = idRaw as string | null;
      if (!accountId) {
        setAccount(null);
        setLoading(false);
        return;
      }

      const [accountRes, membership] = await Promise.all([
        supabase
          .from('accounts')
          .select('id, auth_user_id, first_name, last_name, name, login_email, location_id, account_types')
          .eq('id', accountId)
          .maybeSingle(),
        fetchCurrentStaffMembership(accountId).catch(() => null),
      ]);
      if (cancelled) return;
      if (accountRes.error) {
        setError(accountRes.error.message);
        setLoading(false);
        return;
      }
      if (!accountRes.data) {
        setAccount(null);
        setLoading(false);
        return;
      }
      const r = accountRes.data as {
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
      const isSuperAdmin = r.login_email === SUPER_ADMIN_EMAIL;
      const isActiveStaff = membership?.status === 'active';
      setAccount({
        account_id: r.id,
        auth_user_id: r.auth_user_id,
        first_name: fn,
        last_name: ln,
        display_name: display,
        login_email: r.login_email,
        location_id: r.location_id,
        account_types: r.account_types ?? [],
        staff_member_id: membership?.staff_member_id ?? null,
        is_lng_staff: isActiveStaff || isSuperAdmin,
        is_admin: (isActiveStaff && membership?.is_admin === true) || isSuperAdmin,
        is_manager: isActiveStaff && membership?.is_manager === true,
        is_super_admin: isSuperAdmin,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  return { account, loading, error };
}
