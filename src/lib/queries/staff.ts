import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Lounge staff registry. Backed by public.lng_staff_members (one row
// per active or inactive Lounge staff member) joined to
// public.accounts for identity. The shared accounts table holds name,
// email, auth_user_id; this module owns Lounge-specific concerns:
// is_admin, is_manager, status, hire/deactivation timestamps.
//
// Why the join: Meridian and Lounge share `accounts` for identity but
// nothing else. Demoting a Lounge admin must not demote a Meridian
// admin, and Meridian-only people (Omar in CAD, lab team, dental
// practices) must never appear on the Lounge Staff tab. The
// presence-of-row pattern handles all of that without flag checks.

export interface StaffRow {
  // lng_staff_members columns
  staff_member_id: string;
  is_admin: boolean;
  is_manager: boolean;
  // Granular permission flags introduced alongside Reports + Financials.
  // Reports defaults true (every staff member sees operational reports);
  // Financials and cash counting default false (super-admin grants
  // them deliberately).
  can_view_reports: boolean;
  can_view_financials: boolean;
  can_count_cash: boolean;
  status: 'active' | 'inactive';
  hired_at: string;
  deactivated_at: string | null;
  // accounts columns (joined for display)
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  login_email: string;
}

interface Result {
  data: StaffRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface RawJoinedRow {
  id: string;
  account_id: string;
  is_admin: boolean | null;
  is_manager: boolean | null;
  can_view_reports: boolean | null;
  can_view_financials: boolean | null;
  can_count_cash: boolean | null;
  status: 'active' | 'inactive';
  hired_at: string;
  deactivated_at: string | null;
  account: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
  } | {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
  }[] | null;
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

function mapRow(r: RawJoinedRow): StaffRow {
  const a = pickOne(r.account);
  const fn = a?.first_name?.trim() ?? null;
  const ln = a?.last_name?.trim() ?? null;
  const email = a?.login_email ?? '';
  const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? a?.name?.trim() ?? email ?? r.account_id;
  return {
    staff_member_id: r.id,
    is_admin: r.is_admin === true,
    is_manager: r.is_manager === true,
    can_view_reports: r.can_view_reports === true,
    can_view_financials: r.can_view_financials === true,
    can_count_cash: r.can_count_cash === true,
    status: r.status,
    hired_at: r.hired_at,
    deactivated_at: r.deactivated_at,
    account_id: r.account_id,
    first_name: fn,
    last_name: ln,
    display_name: display,
    login_email: email,
  };
}

const STAFF_SELECT =
  'id, account_id, is_admin, is_manager, can_view_reports, can_view_financials, can_count_cash, status, hired_at, deactivated_at, account:accounts!account_id(id, first_name, last_name, name, login_email)';

// Lists every staff member, active and inactive, sorted alphabetically
// by display name. Inactive rows render with a "Deactivated" badge in
// the Staff tab so admins can re-activate or audit past staff.
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
        .from('lng_staff_members')
        .select(STAFF_SELECT);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const mapped = ((rows ?? []) as RawJoinedRow[])
        .map(mapRow)
        .sort((a, b) => {
          // Active first, then inactive. Within each group,
          // alphabetical by display name.
          if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
          return a.display_name.localeCompare(b.display_name);
        });
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

export async function setIsManager(staffMemberId: string, isManager: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ is_manager: isManager })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

export async function setIsAdmin(staffMemberId: string, isAdmin: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ is_admin: isAdmin })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Toggles can_view_reports. Default-true column; flipping off removes
// a staff member's access to the operational Reports tab.
export async function setCanViewReports(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ can_view_reports: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Toggles can_view_financials. Super-admin-grants only — the UI gates
// the toggle, but the column itself is just a boolean here. Granting
// this opens the Financials tab and the cash reconciliation read
// view.
export async function setCanViewFinancials(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ can_view_financials: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Toggles can_count_cash. Granting this lets the staff member
// initiate a new cash reconciliation count. They still need a manager
// re-auth at sign-off time (different staff than counter), so this
// flag alone is not "do whatever you want with the safe".
export async function setCanCountCash(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ can_count_cash: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// First-name / last-name editor. These land on every signature
// attribution and the witness default. Writes to public.accounts
// because identity is shared with Meridian.
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

// Soft-delete: status='inactive' + deactivated_at + deactivated_by.
// Their attribution on every past signature/payment/audit row stays
// intact. They can no longer sign in to Lounge once the UI gates on
// status='active'.
export async function deactivateStaffMember(staffMemberId: string): Promise<void> {
  const { data: meId } = await supabase.rpc('auth_account_id');
  const { error } = await supabase
    .from('lng_staff_members')
    .update({
      status: 'inactive',
      deactivated_at: new Date().toISOString(),
      deactivated_by: (meId as string | null) ?? null,
    })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Re-activate a previously deactivated staff member. Clears the
// deactivated_at + deactivated_by fields so the row passes the
// status_pair check.
export async function reactivateStaffMember(staffMemberId: string): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({
      status: 'active',
      deactivated_at: null,
      deactivated_by: null,
    })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Adds an existing accounts row (looked up by login_email) to the
// Lounge staff list. Used by the "Add staff member" sheet on the
// admin tab when the email Dylan types already exists in accounts —
// e.g. someone Meridian-side who's now also working at the clinic, or
// an account that pre-dates Lounge. If no account is found this
// returns null so the UI can fall through to the invite flow.
export interface AddByEmailResult {
  staff_member_id: string;
  account_id: string;
  display_name: string;
}

export async function addStaffMemberByEmail(
  email: string,
  options: { is_admin?: boolean; is_manager?: boolean } = {},
): Promise<AddByEmailResult | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) throw new Error('Email is required.');

  // Find an existing accounts row (case-insensitive). login_email is
  // unique on accounts so .maybeSingle() is safe.
  const { data: row, error: lookupErr } = await supabase
    .from('accounts')
    .select('id, first_name, last_name, name, login_email')
    .ilike('login_email', trimmed)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  if (!row) return null;

  const account = row as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
  };

  // Re-activate if a row exists; otherwise insert a new one.
  const { data: existing, error: existingErr } = await supabase
    .from('lng_staff_members')
    .select('id, status')
    .eq('account_id', account.id)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    const e = existing as { id: string; status: string };
    const update: Record<string, unknown> = {
      is_admin: options.is_admin ?? false,
      is_manager: options.is_manager ?? false,
    };
    if (e.status === 'inactive') {
      update.status = 'active';
      update.deactivated_at = null;
      update.deactivated_by = null;
    }
    const { error: updateErr } = await supabase
      .from('lng_staff_members')
      .update(update)
      .eq('id', e.id);
    if (updateErr) throw new Error(updateErr.message);
    return {
      staff_member_id: e.id,
      account_id: account.id,
      display_name: composeDisplay(account),
    };
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('lng_staff_members')
    .insert({
      account_id: account.id,
      is_admin: options.is_admin ?? false,
      is_manager: options.is_manager ?? false,
    })
    .select('id')
    .single();
  if (insertErr) throw new Error(insertErr.message);
  return {
    staff_member_id: (inserted as { id: string }).id,
    account_id: account.id,
    display_name: composeDisplay(account),
  };
}

function composeDisplay(a: {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  login_email: string | null;
}): string {
  const fn = a.first_name?.trim();
  const ln = a.last_name?.trim();
  if (fn && ln) return `${fn} ${ln}`;
  return fn ?? ln ?? a.name?.trim() ?? a.login_email ?? '';
}

// Manager dropdown — lng_staff_members where is_manager = true and
// status = 'active'. Sorted alphabetically by display name. Used by
// the discount + void approval sheets.
export interface ManagerRow {
  staff_member_id: string;
  account_id: string;
  name: string;
  login_email: string;
}

export async function listManagers(): Promise<ManagerRow[]> {
  const { data, error } = await supabase
    .from('lng_staff_members')
    .select(STAFF_SELECT)
    .eq('is_manager', true)
    .eq('status', 'active');
  if (error) {
    if (error.code === '42P01' /* table missing pre-migration */) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as RawJoinedRow[])
    .map(mapRow)
    .map((s) => ({
      staff_member_id: s.staff_member_id,
      account_id: s.account_id,
      name: s.display_name,
      login_email: s.login_email,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Resolves the signed-in account's lng_staff_members row, if any.
// Used by the auth gate to decide whether the user can use Lounge at
// all (no row → not Lounge staff → redirect away) and whether they
// can open the Admin tab (is_admin = true).
export interface CurrentStaffMembership {
  staff_member_id: string;
  is_admin: boolean;
  is_manager: boolean;
  can_view_reports: boolean;
  can_view_financials: boolean;
  can_count_cash: boolean;
  status: 'active' | 'inactive';
}

export async function fetchCurrentStaffMembership(
  accountId: string,
): Promise<CurrentStaffMembership | null> {
  const { data, error } = await supabase
    .from('lng_staff_members')
    .select('id, is_admin, is_manager, can_view_reports, can_view_financials, can_count_cash, status')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    // Pre-migration safety: if the table doesn't exist yet, treat as
    // "no membership" rather than throwing. Older code paths still
    // call this before the foundation migration is applied in dev.
    if (error.code === '42P01') return null;
    throw new Error(error.message);
  }
  if (!data) return null;
  const r = data as {
    id: string;
    is_admin: boolean;
    is_manager: boolean;
    can_view_reports: boolean | null;
    can_view_financials: boolean | null;
    can_count_cash: boolean | null;
    status: 'active' | 'inactive';
  };
  return {
    staff_member_id: r.id,
    is_admin: r.is_admin === true,
    is_manager: r.is_manager === true,
    can_view_reports: r.can_view_reports === true,
    can_view_financials: r.can_view_financials === true,
    can_count_cash: r.can_count_cash === true,
    status: r.status,
  };
}
