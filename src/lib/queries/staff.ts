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
  // Customer Service agents lose every clinic-floor affordance (cart,
  // payment, arrival, no-show, tech notes, print LWO, end visit
  // early) while keeping patient-comms actions (reschedule, cancel,
  // resend, book). Gating uses an is_cs_only derived flag in
  // useCurrentAccount so admins or managers flagged as CS aren't
  // restricted.
  is_customer_service: boolean;
  // Virtual impression clinician capability. When true the staff member
  // can run the video-call controls (Join/Rejoin/Mark complete) AND is a
  // bookable clinician whose hours (lng_clinician_hours) drive virtual
  // availability. clinician_self_serve gates whether they appear in
  // self-serve availability (public widget) or are staff-placement only.
  is_virtual_impression_clinician: boolean;
  clinician_self_serve: boolean;
  // Granular permission flags introduced alongside Reports + Financials.
  // Reports defaults true (every staff member sees operational reports);
  // Financials and cash counting default false (super-admin grants
  // them deliberately).
  can_view_reports: boolean;
  can_view_financials: boolean;
  can_count_cash: boolean;
  // Per-staff "Require 2FA" policy. Stored alone for now; the
  // sign-in gate that enforces AAL2 lands in chunk 3 alongside the
  // /enroll-2fa and /verify-2fa screens.
  require_2fa: boolean;
  // Per-admin-page grants for staff who aren't full admins. When
  // is_admin = false but this array has entries, the Admin tab opens
  // and only the listed tab keys are visible. Full admins (is_admin =
  // true) see every tab regardless. Valid keys live in ADMIN_TABS
  // in src/routes/Admin.tsx.
  admin_page_access: string[];
  // Job title FK into lng_staff_roles. Informational only —
  // independent of admin/manager/page permissions. Null = no role
  // assigned yet.
  role_id: string | null;
  role_name: string | null;
  status: 'active' | 'inactive';
  hired_at: string;
  deactivated_at: string | null;
  // Staff-invite lifecycle (Phase: post-pre-launch). All four are
  // nullable: invite_sent_at + invite_expires_at + invite_accepted_at
  // are written by lng-create-staff-account / lng-accept-invite /
  // lng-resend-staff-invite. last_sign_in_at is bumped by the
  // lng_record_staff_sign_in RPC fired from AuthProvider on every
  // SIGNED_IN event. Existing pre-feature staff have invite_accepted_at
  // backfilled to hired_at so the Admin UI doesn't read "never
  // accepted" for everyone with a working account.
  invite_sent_at: string | null;
  invite_expires_at: string | null;
  invite_accepted_at: string | null;
  last_sign_in_at: string | null;
  // accounts columns (joined for display)
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  login_email: string;
  // Which clinic this staff member is bound to. Drives the
  // deterministic useCurrentLocation hook — every booking the staff
  // member creates from the Schedule / Walk-in flows is written at
  // this location. Surfaced in the Admin → Staff list as a small
  // "Lab · Glasgow" chip so an admin can see at a glance who's
  // assigned where. Null when a row was created before the
  // accounts.location_id column landed, or when an admin hasn't
  // assigned them yet.
  location_id: string | null;
  location_name: string | null;
  location_type: string | null;
  location_city: string | null;
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
  is_customer_service: boolean | null;
  is_virtual_impression_clinician: boolean | null;
  clinician_self_serve: boolean | null;
  can_view_reports: boolean | null;
  can_view_financials: boolean | null;
  can_count_cash: boolean | null;
  require_2fa: boolean | null;
  admin_page_access: string[] | null;
  role_id: string | null;
  role: { id: string; name: string } | { id: string; name: string }[] | null;
  status: 'active' | 'inactive';
  hired_at: string;
  deactivated_at: string | null;
  invite_sent_at: string | null;
  invite_expires_at: string | null;
  invite_accepted_at: string | null;
  last_sign_in_at: string | null;
  account: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
    location_id: string | null;
    location: { id: string; name: string | null; type: string | null; city: string | null } | { id: string; name: string | null; type: string | null; city: string | null }[] | null;
  } | {
    id: string;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    login_email: string | null;
    location_id: string | null;
    location: { id: string; name: string | null; type: string | null; city: string | null } | { id: string; name: string | null; type: string | null; city: string | null }[] | null;
  }[] | null;
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

function mapRow(r: RawJoinedRow): StaffRow {
  const a = pickOne(r.account);
  const role = pickOne(r.role);
  const fn = a?.first_name?.trim() ?? null;
  const ln = a?.last_name?.trim() ?? null;
  const email = a?.login_email ?? '';
  const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? a?.name?.trim() ?? email ?? r.account_id;
  const loc = a ? pickOne(a.location) : null;
  return {
    staff_member_id: r.id,
    is_admin: r.is_admin === true,
    is_manager: r.is_manager === true,
    is_customer_service: r.is_customer_service === true,
    is_virtual_impression_clinician: r.is_virtual_impression_clinician === true,
    clinician_self_serve: r.clinician_self_serve !== false,
    can_view_reports: r.can_view_reports === true,
    can_view_financials: r.can_view_financials === true,
    can_count_cash: r.can_count_cash === true,
    require_2fa: r.require_2fa === true,
    admin_page_access: Array.isArray(r.admin_page_access)
      ? r.admin_page_access.filter((k): k is string => typeof k === 'string')
      : [],
    role_id: r.role_id,
    role_name: role?.name ?? null,
    status: r.status,
    hired_at: r.hired_at,
    deactivated_at: r.deactivated_at,
    invite_sent_at: r.invite_sent_at,
    invite_expires_at: r.invite_expires_at,
    invite_accepted_at: r.invite_accepted_at,
    last_sign_in_at: r.last_sign_in_at,
    account_id: r.account_id,
    first_name: fn,
    last_name: ln,
    display_name: display,
    login_email: email,
    location_id: a?.location_id ?? null,
    location_name: loc?.name ?? null,
    location_type: loc?.type ?? null,
    location_city: loc?.city ?? null,
  };
}

const STAFF_SELECT =
  'id, account_id, is_admin, is_manager, is_customer_service, is_virtual_impression_clinician, clinician_self_serve, can_view_reports, can_view_financials, can_count_cash, require_2fa, admin_page_access, role_id, status, hired_at, deactivated_at, invite_sent_at, invite_expires_at, invite_accepted_at, last_sign_in_at, account:accounts!account_id(id, first_name, last_name, name, login_email, location_id, location:locations!location_id(id, name, type, city)), role:lng_staff_roles!role_id(id, name)';

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

// Toggles is_customer_service. Combined with !is_admin / !is_manager
// (via useCurrentAccount.is_cs_only) this hides clinic-floor
// affordances. Admins / managers flagged as CS aren't restricted —
// the gate is intentional opt-in for CS-only staff.
export async function setIsCustomerService(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ is_customer_service: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Toggles the virtual impression clinician capability: grants the
// in-call controls AND makes the staff member a bookable clinician
// whose hours drive virtual availability.
export async function setIsVirtualImpressionClinician(
  staffMemberId: string,
  value: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ is_virtual_impression_clinician: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// For a virtual impression clinician: whether they appear in self-serve
// availability (public widget) or are staff-placement only.
export async function setClinicianSelfServe(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ clinician_self_serve: value })
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

// Sets the clinic location a staff member is bound to. Writes to
// public.accounts (identity is shared with Meridian — accounts.location_id
// drives location filtering across both apps). Required by the
// staff-list "No location assigned" warning: until this is set, the
// receptionist deterministic-location hook can't decide which clinic
// bookings the staff member creates land at, and large parts of the
// Lounge UI render empty for them. Pass null to clear.
export async function setStaffLocation(accountId: string, locationId: string | null): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update({ location_id: locationId })
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

// Provisions a brand-new Lounge identity end-to-end: auth.users +
// accounts + lng_staff_members + invite email via Resend. Uses the
// lng-create-staff-account edge function because creating auth users
// requires the service role. Used by the Add staff sheet when the
// supplied email has no existing accounts row, so the new staff
// member gets two distinct sign-ins from any Meridian identity
// (different login_email → different auth.users → completely
// separate from Meridian).
//
// Returns the standard AddByEmailResult plus delivery telemetry:
// emailSent indicates whether Resend accepted the invite email. If
// emailSent is false, manualInviteLink contains the action_link the
// admin can copy and deliver themselves rather than re-running the
// flow (which would fail because the auth user already exists).
// inviteUrl is the same URL but returned on every success too — a
// belt-and-braces fallback for the case where Resend reports send
// success but the email is silently filtered (corporate ATP /
// DKIM / spam quarantines do this without any failure signal).
export interface InviteResult extends AddByEmailResult {
  emailSent: boolean;
  inviteUrl: string;
  manualInviteLink?: string;
  emailError?: string;
}

export async function inviteNewStaffMember(args: {
  email: string;
  first_name: string;
  last_name: string;
  is_admin?: boolean;
  is_manager?: boolean;
}): Promise<InviteResult> {
  const { data: invocation, error } = await supabase.functions.invoke<{
    ok: boolean;
    error?: string;
    staff_member_id?: string;
    account_id?: string;
    display_name?: string;
    email_sent?: boolean;
    invite_url?: string;
    manual_invite_link?: string;
    email_error?: string;
  }>('lng-create-staff-account', {
    body: {
      email: args.email.trim().toLowerCase(),
      first_name: args.first_name.trim(),
      last_name: args.last_name.trim(),
      is_admin: args.is_admin === true,
      is_manager: args.is_manager === true,
    },
  });
  if (error) throw new Error(error.message);
  if (!invocation || invocation.ok !== true) {
    throw new Error(invocation?.error ?? 'Could not provision the staff account.');
  }
  return {
    staff_member_id: invocation.staff_member_id!,
    account_id: invocation.account_id!,
    display_name: invocation.display_name!,
    emailSent: invocation.email_sent === true,
    // invite_url is always returned by the function. Fall back to
    // manual_invite_link for older deployments that haven't been
    // upgraded yet.
    inviteUrl: invocation.invite_url ?? invocation.manual_invite_link ?? '',
    manualInviteLink: invocation.manual_invite_link,
    emailError: invocation.email_error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Account actions (chunk 2). Per-staff one-shot actions an admin can
// take from the Staff tab → "Account actions" sheet:
//   • sendPasswordReset   — emails a one-time recovery link
//   • sendMagicLink       — emails a one-time sign-in link (no password)
//   • resetTwoFactor      — wipes the staff member's enrolled MFA factors
//   • setRequire2fa       — toggles whether 2FA is required at sign-in
//                           (enforcement wires up in chunk 3)
//
// All four reuse the admin RLS already in place on lng_staff_members
// for the boolean toggle, and edge functions for everything that
// needs the service role (link minting, email send, MFA factor
// deletion).
// ─────────────────────────────────────────────────────────────────────────────

export interface SendLinkResult {
  emailSent: boolean;
  manualLink?: string;
  // inviteUrl is set only by the staff invite path (resend + create);
  // it carries the active /welcome?invite=<token> URL so the UI can
  // copy and surface it whether or not Resend delivered. magic-link /
  // password-reset endpoints leave it undefined.
  inviteUrl?: string;
  emailError?: string;
}

interface SendLinkResponse {
  ok: boolean;
  error?: string;
  email_sent?: boolean;
  email_error?: string;
  manual_recovery_link?: string;
  manual_signin_link?: string;
}

async function invokeAndUnpackLink(
  fn: 'lng-send-password-reset' | 'lng-send-magic-link',
  staffMemberId: string,
): Promise<SendLinkResult> {
  const { data, error } = await supabase.functions.invoke<SendLinkResponse>(fn, {
    body: { staff_member_id: staffMemberId },
  });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) {
    throw new Error(data?.error ?? 'The action could not be completed.');
  }
  return {
    emailSent: data.email_sent === true,
    manualLink: data.manual_recovery_link ?? data.manual_signin_link,
    emailError: data.email_error,
  };
}

export async function sendPasswordReset(staffMemberId: string): Promise<SendLinkResult> {
  return invokeAndUnpackLink('lng-send-password-reset', staffMemberId);
}

export async function sendMagicLink(staffMemberId: string): Promise<SendLinkResult> {
  return invokeAndUnpackLink('lng-send-magic-link', staffMemberId);
}

// Re-sends the staff_invite email with a freshly-minted Lounge
// invite_token + 7-day expiry. Used by the Manage staff sheet when
// a staff member never accepted (token expired, or scanner ate the
// previous link). Refuses if the staff already accepted — admins
// should send a password reset in that case instead.
export async function resendStaffInvite(staffMemberId: string): Promise<SendLinkResult> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    error?: string;
    email_sent?: boolean;
    email_error?: string;
    invite_url?: string;
    manual_invite_link?: string;
  }>('lng-resend-staff-invite', {
    body: { staff_member_id: staffMemberId },
  });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) {
    throw new Error(data?.error ?? 'Could not resend the invite.');
  }
  return {
    emailSent: data.email_sent === true,
    manualLink: data.manual_invite_link,
    inviteUrl: data.invite_url ?? data.manual_invite_link,
    emailError: data.email_error,
  };
}

// Read-only fetch of the *currently active* invite URL for a pending
// staff member. Admin-only (gated server-side by lng-get-staff-invite-
// link). Returns null when the staff member has already accepted or
// has no token on file. Crucially this does NOT mint a new token —
// the existing email already in the staff member's inbox stays valid.
export interface StaffInviteLink {
  inviteUrl: string | null;
  hasToken: boolean;
  expired: boolean;
  accepted: boolean;
  inviteSentAt: string | null;
  inviteExpiresAt: string | null;
}

export async function getStaffInviteLink(staffMemberId: string): Promise<StaffInviteLink> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    error?: string;
    invite_url?: string | null;
    has_token?: boolean;
    expired?: boolean;
    accepted?: boolean;
    invite_sent_at?: string | null;
    invite_expires_at?: string | null;
  }>('lng-get-staff-invite-link', { body: { staff_member_id: staffMemberId } });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) {
    throw new Error(data?.error ?? 'Could not fetch the invite link.');
  }
  return {
    inviteUrl: data.invite_url ?? null,
    hasToken: data.has_token === true,
    expired: data.expired === true,
    accepted: data.accepted === true,
    inviteSentAt: data.invite_sent_at ?? null,
    inviteExpiresAt: data.invite_expires_at ?? null,
  };
}

export interface Reset2faResult {
  factorsRemoved: number;
}

export async function resetTwoFactor(staffMemberId: string): Promise<Reset2faResult> {
  const { data, error } = await supabase.functions.invoke<{
    ok: boolean;
    error?: string;
    factors_removed?: number;
  }>('lng-reset-2fa', {
    body: { staff_member_id: staffMemberId },
  });
  if (error) throw new Error(error.message);
  if (!data || data.ok !== true) {
    throw new Error(data?.error ?? 'Could not reset 2FA.');
  }
  return { factorsRemoved: data.factors_removed ?? 0 };
}

// Direct boolean update on lng_staff_members. RLS already gates
// writes to admins via lng_staff_members_write, so no edge function
// is needed.
export async function setRequire2fa(staffMemberId: string, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ require_2fa: value })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// Writes the full admin_page_access array for a staff member. Replaces
// the existing list rather than appending so the UI can present a set
// of toggles and persist the whole state on each change. Empty array
// means no per-page grants (the staff member is not a limited admin).
export async function setAdminPageAccess(
  staffMemberId: string,
  pages: string[],
): Promise<void> {
  const unique = Array.from(new Set(pages.map((p) => p.trim()).filter(Boolean))).sort();
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ admin_page_access: unique })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff roles (job titles). Curated lookup table managed from Admin >
// Staff > Manage roles. Independent of the permission flags above:
// "Receptionist" is what someone does, not what the system lets them
// do. See migration 20260513000007.
// ─────────────────────────────────────────────────────────────────────────────

export interface StaffRoleRow {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  archived_at: string | null;
  member_count: number;
}

interface StaffRolesResult {
  data: StaffRoleRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Returns every role (active and archived) plus a count of how many
// active staff members are currently assigned to each. The count is
// what gates the "you're about to archive a role 4 people use"
// confirmation; without it, archives feel risk-free even when they
// silently clear several role pills.
export function useStaffRoles(): StaffRolesResult {
  const [data, setData] = useState<StaffRoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [rolesRes, countsRes] = await Promise.all([
        supabase
          .from('lng_staff_roles')
          .select('id, name, description, sort_order, archived_at')
          .order('sort_order', { ascending: true })
          .order('name', { ascending: true }),
        // One round-trip per role would be N+1 — instead pull every
        // active staff row's role_id and aggregate client-side. Tiny
        // dataset (typically <50 rows), so a JOIN aggregate isn't
        // worth the extra view.
        supabase
          .from('lng_staff_members')
          .select('role_id')
          .eq('status', 'active'),
      ]);
      if (cancelled) return;
      if (rolesRes.error) {
        setError(rolesRes.error.message);
        setLoading(false);
        return;
      }
      const counts = new Map<string, number>();
      if (!countsRes.error && Array.isArray(countsRes.data)) {
        for (const r of countsRes.data as { role_id: string | null }[]) {
          if (!r.role_id) continue;
          counts.set(r.role_id, (counts.get(r.role_id) ?? 0) + 1);
        }
      }
      const rows = ((rolesRes.data ?? []) as Array<{
        id: string;
        name: string;
        description: string | null;
        sort_order: number;
        archived_at: string | null;
      }>).map((r) => ({
        ...r,
        member_count: counts.get(r.id) ?? 0,
      }));
      setData(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

// Convenience: just the active roles, ordered by sort_order then
// name. The Manage sheet's role dropdown reads this — archived roles
// stay readable on existing staff but disappear from new assignments.
export async function listActiveStaffRoles(): Promise<StaffRoleRow[]> {
  const { data, error } = await supabase
    .from('lng_staff_roles')
    .select('id, name, description, sort_order, archived_at')
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) {
    if (error.code === '42P01') return []; // pre-migration safety
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<Omit<StaffRoleRow, 'member_count'>>).map((r) => ({
    ...r,
    member_count: 0,
  }));
}

export async function createStaffRole(input: {
  name: string;
  description?: string | null;
}): Promise<StaffRoleRow> {
  const name = input.name.trim();
  if (!name) throw new Error('Role name is required.');
  // Match the SORT_ORDER convention: new roles land at the end. We
  // read the current max and add a sensible step (10) so manual
  // re-ordering in the future doesn't have to renumber the whole
  // list.
  const { data: maxRow } = await supabase
    .from('lng_staff_roles')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = ((maxRow as { sort_order: number } | null)?.sort_order ?? 0) + 10;
  const { data, error } = await supabase
    .from('lng_staff_roles')
    .insert({
      name,
      description: input.description?.trim() || null,
      sort_order: nextSort,
    })
    .select('id, name, description, sort_order, archived_at')
    .single();
  if (error) throw new Error(error.message);
  return { ...(data as Omit<StaffRoleRow, 'member_count'>), member_count: 0 };
}

export async function updateStaffRole(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (typeof patch.name === 'string') {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error('Role name cannot be empty.');
    update.name = trimmed;
  }
  if (patch.description !== undefined) {
    update.description = patch.description?.trim() || null;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await supabase
    .from('lng_staff_roles')
    .update(update)
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function archiveStaffRole(id: string): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_roles')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function unarchiveStaffRole(id: string): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_roles')
    .update({ archived_at: null })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// Assigns or clears a staff member's role. Pass null to clear.
export async function setStaffRole(
  staffMemberId: string,
  roleId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('lng_staff_members')
    .update({ role_id: roleId })
    .eq('id', staffMemberId);
  if (error) throw new Error(error.message);
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
  is_customer_service: boolean;
  // Whether the signed-in staff member can run virtual impression calls.
  is_virtual_impression_clinician: boolean;
  can_view_reports: boolean;
  can_view_financials: boolean;
  can_count_cash: boolean;
  require_2fa: boolean;
  admin_page_access: string[];
  // Job-title FK + resolved display name from lng_staff_roles. Both
  // nullable: a staff member without a role assigned, or with a role
  // that's been archived since assignment, lands here with null
  // role_name (we still keep the role_id so the relationship survives
  // a future restore from archive).
  role_id: string | null;
  role_name: string | null;
  status: 'active' | 'inactive';
}

export async function fetchCurrentStaffMembership(
  accountId: string,
): Promise<CurrentStaffMembership | null> {
  // Primary query: staff member columns including role_id. The role
  // name is fetched via a separate lookup below rather than an
  // embedded `role:lng_staff_roles(name)` select. Why: this function
  // runs on every app load via useCurrentAccount, so a stale
  // PostgREST schema cache on the role relationship would brick the
  // entire auth gate. Two cheap round-trips, no schema-cache risk.
  const { data, error } = await supabase
    .from('lng_staff_members')
    .select('id, is_admin, is_manager, is_customer_service, is_virtual_impression_clinician, can_view_reports, can_view_financials, can_count_cash, require_2fa, admin_page_access, role_id, status')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    // Pre-migration safety: if the table doesn't exist yet, treat as
    // "no membership" rather than throwing. Older code paths still
    // call this before the foundation migration is applied in dev.
    if (error.code === '42P01') return null;
    // admin_page_access is added by 20260513000005 and role_id by
    // 20260513000007. If either column doesn't exist yet on this DB,
    // fall back to a query without them so older deploys keep
    // working until the migrations land.
    if (error.code === '42703') {
      const { data: legacy, error: legacyErr } = await supabase
        .from('lng_staff_members')
        .select('id, is_admin, is_manager, can_view_reports, can_view_financials, can_count_cash, require_2fa, status')
        .eq('account_id', accountId)
        .maybeSingle();
      if (legacyErr) throw new Error(legacyErr.message);
      if (!legacy) return null;
      const l = legacy as {
        id: string;
        is_admin: boolean;
        is_manager: boolean;
        can_view_reports: boolean | null;
        can_view_financials: boolean | null;
        can_count_cash: boolean | null;
        require_2fa: boolean | null;
        status: 'active' | 'inactive';
      };
      return {
        staff_member_id: l.id,
        is_admin: l.is_admin === true,
        is_manager: l.is_manager === true,
        is_customer_service: false,
        is_virtual_impression_clinician: false,
        can_view_reports: l.can_view_reports === true,
        can_view_financials: l.can_view_financials === true,
        can_count_cash: l.can_count_cash === true,
        require_2fa: l.require_2fa === true,
        admin_page_access: [],
        role_id: null,
        role_name: null,
        status: l.status,
      };
    }
    throw new Error(error.message);
  }
  if (!data) return null;
  const r = data as {
    id: string;
    is_admin: boolean;
    is_manager: boolean;
    is_customer_service: boolean | null;
    is_virtual_impression_clinician: boolean | null;
    can_view_reports: boolean | null;
    can_view_financials: boolean | null;
    can_count_cash: boolean | null;
    require_2fa: boolean | null;
    admin_page_access: unknown;
    role_id: string | null;
    status: 'active' | 'inactive';
  };

  // Resolve role name if a role is assigned. Done as a separate
  // lookup so a missing lng_staff_roles table (42P01 — migration not
  // applied yet) or stale PostgREST relationship cache degrades to
  // "no role name" instead of breaking the auth gate.
  let roleName: string | null = null;
  if (r.role_id) {
    const { data: roleRow, error: roleErr } = await supabase
      .from('lng_staff_roles')
      .select('name')
      .eq('id', r.role_id)
      .maybeSingle();
    if (!roleErr && roleRow) {
      roleName = (roleRow as { name: string }).name ?? null;
    }
  }

  return {
    staff_member_id: r.id,
    is_admin: r.is_admin === true,
    is_manager: r.is_manager === true,
    is_customer_service: r.is_customer_service === true,
    is_virtual_impression_clinician: r.is_virtual_impression_clinician === true,
    can_view_reports: r.can_view_reports === true,
    can_view_financials: r.can_view_financials === true,
    can_count_cash: r.can_count_cash === true,
    require_2fa: r.require_2fa === true,
    admin_page_access: Array.isArray(r.admin_page_access)
      ? r.admin_page_access.filter((k): k is string => typeof k === 'string')
      : [],
    role_id: r.role_id,
    role_name: roleName,
    status: r.status,
  };
}
