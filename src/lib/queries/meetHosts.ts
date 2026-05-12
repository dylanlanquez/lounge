import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';

// Public-facing slice of lng_meet_hosts. The token columns
// (access_token, refresh_token, token_expiry) are intentionally NEVER
// read from the client — they live in edge functions running as
// service-role only. Front-end consumers see display_name +
// google_email + is_active so the dropdown can render and the admin
// list can show "Connected" / "Inactive".
export interface MeetHostPublic {
  id: string;
  display_name: string;
  google_email: string;
  is_active: boolean;
  created_at: string;
}

// Sort priority: karly.innes@venneir.com first, lab@venneir.com
// second, then alphabetical by display_name. Mirrors the brief —
// receptionists pick the same host 95% of the time and the
// preferred host should land at the top regardless of when it was
// connected.
const HOST_SORT_PRIORITY: Record<string, number> = {
  'karly.innes@venneir.com': 0,
  'lab@venneir.com': 1,
};

function sortHosts(rows: MeetHostPublic[]): MeetHostPublic[] {
  return [...rows].sort((a, b) => {
    const ap = HOST_SORT_PRIORITY[a.google_email.toLowerCase()] ?? 100;
    const bp = HOST_SORT_PRIORITY[b.google_email.toLowerCase()] ?? 100;
    if (ap !== bp) return ap - bp;
    return a.display_name.localeCompare(b.display_name, 'en-GB');
  });
}

interface UseMeetHostsResult {
  hosts: MeetHostPublic[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useMeetHosts(opts: { activeOnly?: boolean } = {}): UseMeetHostsResult {
  const activeOnly = opts.activeOnly ?? false;
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
        .select('id, display_name, google_email, is_active, created_at');
      if (activeOnly) q = q.eq('is_active', true);
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
  }, [activeOnly, tick, settle]);

  useRealtimeRefresh([{ table: 'lng_meet_hosts' }], refresh);

  return { hosts, loading, error, refresh };
}

// Kicks off the OAuth flow. Edge function returns the consent URL,
// caller replaces window.location with it. The returnTo string lets
// the callback page route back to the right admin tab on success.
export async function startMeetHostOAuth(returnTo: string | null = null): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke<{ ok: boolean; url?: string; error?: string }>(
    'meet-auth-init',
    { body: { return_to: returnTo } },
  );
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { ok?: boolean; url?: string; error?: string };
  if (!payload.ok || !payload.url) return { ok: false, error: payload.error ?? 'OAuth init failed' };
  return { ok: true, url: payload.url };
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

// Booking-flow caller: invoke the space-creation edge function once
// the appointment row is inserted. Caller passes appointment_id +
// host_id. The function writes meet_* + join_url onto the row.
export async function createMeetSpaceForAppointment(args: {
  appointment_id: string;
  host_id: string;
}): Promise<{
  ok: boolean;
  cached?: boolean;
  meet_space_id?: string;
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
    meet_space_id?: string;
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
        .select('id, appointment_id, participant_name, participant_email, joined_at, left_at, duration_seconds')
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
