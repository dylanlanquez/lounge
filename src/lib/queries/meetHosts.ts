import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';

// Public-facing slice of lng_meet_hosts. The token columns
// (access_token, refresh_token, token_expiry) are intentionally NEVER
// read from the client — they live in edge functions running as
// service-role only, and a DB-level column grant revoke now blocks
// client reads of them outright. Front-end consumers see the
// non-secret columns so the dropdown can render and the admin list can
// show "Connected" / "Inactive".
//
// kind:
//   'oauth' — Google-connected host that owns Meet spaces and whose
//             grant the attendance fetch runs through. Has google_email.
//   'staff' — name-recognition only host (no Google tokens). Represents
//             a staff member who runs calls but doesn't connect their
//             own Google account. google_email is null; the attendance
//             pipeline matches them by display name and auto-binds their
//             google_user_id on first exact match.
export interface MeetHostPublic {
  id: string;
  display_name: string;
  google_email: string | null;
  is_active: boolean;
  created_at: string;
  kind: 'oauth' | 'staff';
  staff_member_id: string | null;
  // Captured stable Google id. For staff hosts, non-null means the
  // pipeline has locked onto them once and now matches by id, not name.
  google_user_id: string | null;
  // Admin-controlled display order (lower = earlier).
  sort_order: number;
}

// Display order is admin-controlled via sort_order (set by the reorder
// arrows in Admin > Services). Lower = earlier; ties fall back to
// display name so the list is always stable.
function sortHosts(rows: MeetHostPublic[]): MeetHostPublic[] {
  return [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.display_name.localeCompare(b.display_name, 'en-GB');
  });
}

interface UseMeetHostsResult {
  hosts: MeetHostPublic[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ownersOnly: restrict to kind = 'oauth' hosts. The booking + appointment
// flows need a host that can actually OWN the Meet space (only OAuth
// hosts have a Google grant), so they pass ownersOnly. The admin manager
// leaves it off to see staff recognition hosts too.
export function useMeetHosts(opts: { activeOnly?: boolean; ownersOnly?: boolean } = {}): UseMeetHostsResult {
  const activeOnly = opts.activeOnly ?? false;
  const ownersOnly = opts.ownersOnly ?? false;
  const [hosts, setHosts] = useState<MeetHostPublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(activeOnly ? 'meet-hosts-active' : 'meet-hosts-all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('lng_meet_hosts')
        .select('id, display_name, google_email, is_active, created_at, kind, staff_member_id, google_user_id, sort_order');
      if (activeOnly) q = q.eq('is_active', true);
      if (ownersOnly) q = q.eq('kind', 'oauth');
      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        setError(err.message);
        settle();
        return;
      }
      setError(null);
      setHosts(sortHosts((data ?? []) as MeetHostPublic[]));
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeOnly, ownersOnly, tick, settle]);

  useRealtimeRefresh([{ table: 'lng_meet_hosts' }], refresh);

  return { hosts, loading, error, refresh };
}

// A connectable workspace (Google OAuth app). The admin picks which one
// to connect a host through when more than one is configured.
export interface MeetOAuthClient {
  key: string;
  label: string;
}

// Lists the workspaces whose OAuth secrets are configured server-side,
// so the Connect control only offers apps that can actually complete a
// grant. Returns [] on error (the Connect button then falls back to the
// default workspace).
export async function listMeetOAuthClients(): Promise<MeetOAuthClient[]> {
  const { data, error } = await supabase.functions.invoke<{ ok: boolean; clients?: MeetOAuthClient[] }>(
    'meet-auth-init',
    { body: { list: true } },
  );
  if (error) return [];
  const payload = (data ?? {}) as { ok?: boolean; clients?: MeetOAuthClient[] };
  return payload.ok && Array.isArray(payload.clients) ? payload.clients : [];
}

// Kicks off the OAuth flow. Edge function returns the consent URL,
// caller replaces window.location with it. The returnTo string lets
// the callback page route back to the right admin tab on success.
// client selects which workspace's OAuth app to connect through; null
// uses the server default (venneir). token is for the remote
// self-connect path: when present the call needs no Lounge session and
// the token determines the workspace (client is ignored server-side).
export async function startMeetHostOAuth(
  returnTo: string | null = null,
  client: string | null = null,
  token: string | null = null,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke<{ ok: boolean; url?: string; error?: string }>(
    'meet-auth-init',
    { body: { return_to: returnTo, client: client ?? undefined, token: token ?? undefined } },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { ok?: boolean; url?: string; error?: string };
  if (!payload.ok || !payload.url) return { ok: false, error: payload.error ?? 'OAuth init failed' };
  return { ok: true, url: payload.url };
}

// Admin: mint a one-time connect link to send to a remote host. client
// picks the workspace; label is a free-text "who this is for".
export async function createMeetHostInvite(args: {
  client: string;
  label: string | null;
}): Promise<{ ok: boolean; url?: string; expiresAt?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke<unknown>('meet-host-invite', {
    body: { client: args.client, label: args.label ?? undefined },
  });
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { ok?: boolean; url?: string; expiresAt?: string; error?: string };
  if (!payload.ok || !payload.url) return { ok: false, error: payload.error ?? 'Could not create the link' };
  return { ok: true, url: payload.url, expiresAt: payload.expiresAt };
}

// Public (no auth): validate a connect token so the connect page can
// show who it's for and reject expired / used links up front.
export async function validateMeetHostInvite(
  token: string,
): Promise<{ ok: boolean; label?: string | null; workspaceLabel?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke<unknown>('meet-host-invite', {
    body: { action: 'validate', token },
  });
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { ok?: boolean; label?: string | null; workspaceLabel?: string; error?: string };
  if (!payload.ok) return { ok: false, error: payload.error ?? 'This link is not valid.' };
  return { ok: true, label: payload.label ?? null, workspaceLabel: payload.workspaceLabel };
}

// Finishes the OAuth round-trip. Called by /auth/google/callback
// after Google redirects back with ?code= + ?state=. Returns the
// freshly-saved host record on success.
export async function completeMeetHostOAuth(args: {
  code: string;
  state: string | null;
}): Promise<{ ok: boolean; host?: MeetHostPublic; error?: string }> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'meet-auth-callback',
    { body: args },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { ok?: boolean; host?: MeetHostPublic; error?: string };
  if (!payload.ok) return { ok: false, error: payload.error ?? 'OAuth completion failed' };
  return { ok: true, host: payload.host };
}

// Register a staff member as a name-recognition Meet host. No Google
// OAuth involved: the row carries kind = 'staff' + the staff member's
// display name, and the attendance pipeline matches them by name (then
// auto-binds their stable Google id on first exact sighting). Used for
// staff who run virtual appointments but don't connect their own Google
// account. Insert is gated to admins by RLS.
export async function addStaffMeetHost(args: {
  staffMemberId: string;
  displayName: string;
}): Promise<void> {
  const displayName = args.displayName.trim();
  if (!displayName) throw new Error('Staff member has no name to match against');
  // A staff member can only ever have one lng_meet_hosts row (unique on
  // staff_member_id). One can already exist — they were added then
  // deactivated (the active-only list no longer shows them, so the picker
  // still offers them), or they connected a Google account. Re-inserting
  // would violate the constraint and surface a raw DB error. Instead,
  // reactivate the existing row so "add" is idempotent.
  const { data: existing, error: selErr } = await supabase
    .from('lng_meet_hosts')
    .select('id, kind')
    .eq('staff_member_id', args.staffMemberId)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);
  if (existing) {
    const row = existing as { id: string; kind: string };
    const patch: Record<string, unknown> = { is_active: true };
    // Only relabel a staff-kind row; never overwrite an OAuth host's
    // own Google display name.
    if (row.kind === 'staff') patch.display_name = displayName;
    const { error: updErr } = await supabase
      .from('lng_meet_hosts')
      .update(patch)
      .eq('id', row.id);
    if (updErr) throw new Error(updErr.message);
    return;
  }
  const { error } = await supabase.from('lng_meet_hosts').insert({
    kind: 'staff',
    staff_member_id: args.staffMemberId,
    display_name: displayName,
  });
  if (error) throw new Error(error.message);
}

// Soft-disable a host. Keeps the row + tokens so a future
// reactivation doesn't force the admin through OAuth again.
export async function setMeetHostActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase
    .from('lng_meet_hosts')
    .update({ is_active: active })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteMeetHost(id: string): Promise<void> {
  const { error } = await supabase.from('lng_meet_hosts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Persist a reordered host list. Each id gets sort_order = its new index
// × 10 (spacing so a later insertion doesn't force a full rewrite).
// Admin-gated by RLS. Mirrors the catalogue batchUpdateSortOrders helper.
export async function batchUpdateMeetHostSortOrders(
  updates: Array<{ id: string; sort_order: number }>,
): Promise<void> {
  await Promise.all(
    updates.map(({ id, sort_order }) =>
      supabase
        .from('lng_meet_hosts')
        .update({ sort_order })
        .eq('id', id)
        .then(({ error }) => {
          if (error) throw new Error(error.message);
        }),
    ),
  );
}

// Booking-flow caller: invoke the space-creation edge function once
// the appointment row is inserted. Caller passes appointment_id +
// host_id. The function writes meet_* + join_url onto the row.
export async function createMeetSpaceForAppointment(args: {
  appointment_id: string;
  host_id: string;
}): Promise<{
  ok: boolean;
  cached?: boolean;
  // meet_space_id is null when meet-create-space could not resolve the
  // canonical Meet space resource name via spaces.get. Booking still
  // succeeds in that case — the Calendar event and Meet join URL are
  // live, and meet-fetch-attendance keys off meet_meeting_code which
  // is always set. The failure is logged to lng_system_failures.
  meet_space_id?: string | null;
  meet_meeting_code?: string;
  join_url?: string;
  error?: string;
}> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'meet-create-space',
    { body: args },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as {
    ok?: boolean;
    cached?: boolean;
    meet_space_id?: string | null;
    meet_meeting_code?: string;
    join_url?: string;
    error?: string;
  };
  if (!payload.ok) return { ok: false, error: payload.error ?? 'Meet space creation failed' };
  return {
    ok: true,
    cached: payload.cached,
    meet_space_id: payload.meet_space_id,
    meet_meeting_code: payload.meet_meeting_code,
    join_url: payload.join_url,
  };
}

// Attendance fetch from the detail page's Refresh button.
export async function fetchMeetAttendance(appointmentId: string): Promise<{
  ok: boolean;
  waitingForMeeting?: boolean;
  upserts?: number;
  message?: string;
  error?: string;
}> {
  const { data, error } = await supabase.functions.invoke<unknown>(
    'meet-fetch-attendance',
    { body: { appointment_id: appointmentId } },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as {
    ok?: boolean;
    waitingForMeeting?: boolean;
    upserts?: number;
    message?: string;
    error?: string;
  };
  if (!payload.ok) return { ok: false, error: payload.error ?? 'Attendance fetch failed' };
  return {
    ok: true,
    waitingForMeeting: payload.waitingForMeeting,
    upserts: payload.upserts,
    message: payload.message,
  };
}

// Hook for the Appointment detail page. Reads lng_meet_attendance
// rows for the appointment, live-refreshes on inserts/updates so a
// manual sync from another tab reflects here too.
export interface MeetAttendanceRow {
  id: string;
  appointment_id: string;
  participant_name: string | null;
  participant_email: string | null;
  joined_at: string | null;
  left_at: string | null;
  duration_seconds: number | null;
  // is_host: matched against lng_meet_hosts.display_name when the row
  // was fetched. False for the patient + any non-host participant.
  is_host: boolean;
  // Google's stable user-resource id ("users/abc"). Same person across
  // sessions resolves to the same id, so the card groups by this when
  // available and by participant_name when null (anonymous / phone).
  meet_user_id: string | null;
}

export function useMeetAttendance(appointmentId: string | null | undefined): {
  rows: MeetAttendanceRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [rows, setRows] = useState<MeetAttendanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(`meet-attendance|${appointmentId ?? ''}`);

  useEffect(() => {
    if (!appointmentId) {
      setRows([]);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_meet_attendance')
        .select('id, appointment_id, participant_name, participant_email, joined_at, left_at, duration_seconds, is_host, meet_user_id')
        .eq('appointment_id', appointmentId)
        .order('joined_at', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        settle();
        return;
      }
      setError(null);
      setRows((data ?? []) as MeetAttendanceRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, tick, settle]);

  useRealtimeRefresh(
    appointmentId ? [{ table: 'lng_meet_attendance', filter: `appointment_id=eq.${appointmentId}` }] : [],
    refresh,
  );

  return { rows, loading, error, refresh };
}
