import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../supabase.ts';
import { useAuth } from '../auth.tsx';
import { fetchCurrentStaffMembership } from './staff.ts';
import { isConnectivityError } from '../connectivity.ts';

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
  // app; is_admin gates /admin specifically. The three can_* flags
  // are introduced alongside Reports + Financials and gate the
  // matching top-level destinations.
  staff_member_id: string | null;
  is_lng_staff: boolean;
  is_admin: boolean;
  is_manager: boolean;
  // Customer Service flag (raw): true when the staff_members row sets
  // is_customer_service. Admin / manager / super-admin users can be
  // CS-flagged without losing their elevated access.
  is_customer_service: boolean;
  // Derived "CS only" flag: true when is_customer_service is on AND
  // no other elevated permission is. THIS is the flag the UI button
  // gates check — admins + managers flagged as CS keep their floor
  // affordances; only pure-CS staff lose them.
  is_cs_only: boolean;
  // Whether this staff member is a virtual impression clinician — gates
  // the in-call controls (Join/Rejoin/Mark complete) on a virtual
  // appointment. Only flagged clinicians can run the call.
  is_virtual_impression_clinician: boolean;
  // Whether this clinician may edit their own availability (Profile menu).
  clinician_can_edit_own_hours: boolean;
  can_view_reports: boolean;
  can_view_financials: boolean;
  can_count_cash: boolean;
  can_write_off: boolean;
  // Per-page admin grants. When is_admin = false but this array has
  // entries, /admin opens and only the listed tab keys are shown.
  // Super admins and full admins see every tab regardless.
  admin_page_access: string[];
  // Per-staff gate (allowlist, default false) for the marketing-content
  // walkthrough — the guided tour auto-start and the Schedule "Show me
  // how" banner both read this. Off for everyone until an admin opts a
  // staff member in.
  marketing_walkthrough_enabled: boolean;
  // Job title (Receptionist, Hygienist, etc.) from lng_staff_roles.
  // Informational only — shown on the profile sheet and anywhere we
  // attribute work to a staff member. Null when no role is assigned
  // or the assigned role has been archived. Independent of all the
  // permission flags above.
  role_name: string | null;
  // Per-staff "Require 2FA" policy. Read by the auth gate to decide
  // whether to route into /enroll-2fa or /verify-2fa before granting
  // access to protected routes. Super admin always passes the gate
  // regardless to avoid a bootstrap chicken-and-egg.
  require_2fa: boolean;
  is_super_admin: boolean;
}

interface Result {
  account: CurrentAccount | null;
  loading: boolean;
  error: string | null;
  // True when the most recent fetch failed because Supabase was
  // unreachable (Cloudflare 5xx, network offline, request aborted,
  // DNS failure). RequireStaff renders a "Can't reach Lounge servers"
  // surface with a retry button instead of routing the user to
  // /no-access — which would falsely tell them they're not on the
  // staff list when the real reason is platform-side. See
  // src/lib/connectivity.ts for the detector.
  connectivityError: boolean;
  // Trigger a re-fetch of the account row. Wired to the retry button
  // on the connectivity surface so the user can recover without a
  // full page reload (which would otherwise discard router state,
  // open sheets, in-flight forms, etc.).
  retry: () => void;
}

// CurrentAccountContext — single source of truth for the signed-in
// staff member's identity row + Lounge-staff permission flags.
//
// Why a context (not a hand-rolled hook per consumer): the previous
// shape had `useCurrentAccount()` mint its own state + fetch on every
// call site (~40 across the app). RequireStaff resolved its copy
// first, the route mounted, then inner components rendered with
// account=null + loading=true and re-rendered a tick later when their
// own fetch landed — that race produced visible flicker on every
// permission-gated affordance (CS-only button hides, walk-in
// explainer swap, etc).
//
// Now the provider mounts once near the top of the tree (next to
// AuthProvider), fires exactly one fetch when auth resolves, and
// every consumer reads the same resolved value. By the time any
// route inside RequireStaff renders, the account is settled — gates
// evaluate correctly on first paint. No flicker by construction.
const CurrentAccountContext = createContext<Result | null>(null);

export function CurrentAccountProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectivityError, setConnectivityError] = useState(false);
  // Bumped by retry() to force the effect to re-run without going
  // through a full page reload. Re-running this effect refires the
  // auth_account_id + accounts/staff fetches under the same React
  // tree, so router state, modals, and in-flight forms survive.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setAccount(null);
      setError(null);
      setConnectivityError(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Clear the previous user's account before flipping loading
    // back to true. Without this, when auth swaps user1 → user2
    // mid-session (rare but real — admin impersonation, dev
    // switching accounts in one tab, etc) consumers would briefly
    // read user1's permissions tagged with loading=true. Setting
    // account to null guarantees the only state a consumer can
    // observe between user changes is { account: null, loading:
    // true } — same shape as the very first mount.
    setAccount(null);
    setLoading(true);
    setError(null);
    setConnectivityError(false);
    (async () => {
      // Outer try/catch/finally guarantees loading always settles.
      // Without it, any thrown await (network blip, gotrue lock
      // recovery surfacing a rejection, RPC transport error) leaves
      // loading=true forever — RequireStaff then renders the
      // "Loading…" route fallback indefinitely and the user is
      // trapped. We log the failure loudly per the project's
      // "no silent fallbacks" rule and degrade to a no-account
      // state so the routing gate can decide what to do (typically
      // a redirect to /sign-in or /no-access).
      try {
        const { data: idRaw, error: idErr } = await supabase.rpc('auth_account_id');
        if (cancelled) return;
        if (idErr) {
          // Connectivity errors get their own flag so RequireStaff
          // can route to a recovery surface instead of /no-access.
          // Application-level errors (auth_invalid, RLS denials,
          // malformed RPC) still fall through to setError + the
          // existing routing path.
          setError(idErr.message);
          if (isConnectivityError(idErr)) setConnectivityError(true);
          return;
        }
        const accountId = idRaw as string | null;
        if (!accountId) {
          setAccount(null);
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
          if (isConnectivityError(accountRes.error)) setConnectivityError(true);
          return;
        }
        if (!accountRes.data) {
          setAccount(null);
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
        // Permission resolution: the super admin always passes every
        // gate (so a brand new install can be administered without
        // bootstrap chicken-and-egg). For everyone else, the flag must
        // be explicitly true on the staff_members row AND the row must
        // be active.
        const isAdminEff =
          (isActiveStaff && membership?.is_admin === true) || isSuperAdmin;
        const isManagerEff = isActiveStaff && membership?.is_manager === true;
        const isCustomerService =
          isActiveStaff && membership?.is_customer_service === true;
        // CS-only = flagged as CS AND no elevated permission. Super
        // admin always exits this branch because they're an admin.
        const isCsOnly =
          isCustomerService && !isAdminEff && !isManagerEff && !isSuperAdmin;
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
          is_admin: isAdminEff,
          is_manager: isManagerEff,
          is_customer_service: isCustomerService,
          is_cs_only: isCsOnly,
          is_virtual_impression_clinician:
            isActiveStaff && membership?.is_virtual_impression_clinician === true,
          clinician_can_edit_own_hours:
            isActiveStaff && membership?.clinician_can_edit_own_hours === true,
          can_view_reports:
            (isActiveStaff && membership?.can_view_reports === true) || isSuperAdmin,
          can_view_financials:
            (isActiveStaff && membership?.can_view_financials === true) || isSuperAdmin,
          can_count_cash:
            (isActiveStaff && membership?.can_count_cash === true) || isSuperAdmin,
          can_write_off:
            (isActiveStaff && membership?.can_write_off === true) || isSuperAdmin,
          admin_page_access: isActiveStaff ? (membership?.admin_page_access ?? []) : [],
          marketing_walkthrough_enabled:
            isActiveStaff && membership?.marketing_walkthrough_enabled === true,
          role_name: isActiveStaff ? (membership?.role_name ?? null) : null,
          // Super admin is exempt from the require_2fa gate so a
          // brand-new install can never lock itself out. Every other
          // staff member's flag mirrors lng_staff_members.require_2fa.
          require_2fa: isActiveStaff && membership?.require_2fa === true && !isSuperAdmin,
          is_super_admin: isSuperAdmin,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('[currentAccount] account resolution threw', err);
        setError(err instanceof Error ? err.message : 'Account fetch failed');
        if (isConnectivityError(err)) setConnectivityError(true);
        setAccount(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, retryTick]);

  // Stable identity for the context value so consumers don't re-render
  // on every parent re-render — only when one of the tracked fields
  // genuinely changes. retry is stable across renders because it's
  // a setter wrapper, not a fresh closure each render.
  const value = useMemo<Result>(
    () => ({
      account,
      loading,
      error,
      connectivityError,
      retry: () => setRetryTick((t) => t + 1),
    }),
    [account, loading, error, connectivityError],
  );

  return (
    <CurrentAccountContext.Provider value={value}>
      {children}
    </CurrentAccountContext.Provider>
  );
}

export function useCurrentAccount(): Result {
  const ctx = useContext(CurrentAccountContext);
  if (ctx === null) {
    // Loud failure: a consumer is being rendered outside the
    // provider tree. Far better than the previous silent shape
    // where every consumer did its own fetch.
    throw new Error(
      'useCurrentAccount must be used inside <CurrentAccountProvider>. ' +
        'Check the component tree in App.tsx.',
    );
  }
  return ctx;
}
