import { supabase } from '../supabase.ts';

// Staff sessions admin data. Backed by two SECURITY DEFINER RPCs
// (lng_admin_staff_sessions / lng_admin_force_logout, migration
// 20260611000003) that read GoTrue's auth.sessions / auth.users and revoke
// a staff member's server-side sessions. Both are gated by
// auth_is_lng_admin() server-side, so a non-admin gets a thrown error, never
// a silent empty result. Geolocation of session IPs is resolved client-side
// (ipwho.is) and degrades to the raw IP if the lookup is unavailable.

export interface StaffSession {
  id: string;
  /** Session creation = the sign-in that started this device's chain. */
  created_at: string;
  /** Last token refresh = most recent activity on this device. */
  refreshed_at: string | null;
  not_after: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface StaffSessionRow {
  staff_member_id: string;
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  login_email: string;
  status: string;
  is_admin: boolean;
  is_manager: boolean;
  last_sign_in_at: string | null;
  sessions: StaffSession[];
}

export async function getStaffSessions(): Promise<StaffSessionRow[]> {
  const { data, error } = await supabase.rpc('lng_admin_staff_sessions');
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffSessionRow[];
}

/**
 * Revokes every server-side session for one staff member. Returns the number
 * of sessions removed. The account keeps its credentials, it is simply signed
 * out everywhere and must sign in again.
 */
export async function forceLogoutStaff(staffMemberId: string): Promise<number> {
  const { data, error } = await supabase.rpc('lng_admin_force_logout', {
    p_staff_member_id: staffMemberId,
  });
  if (error) throw new Error(error.message);
  return typeof data === 'number' ? data : 0;
}

export interface IpLocation {
  /** "Glasgow, United Kingdom" — ready to render. */
  label: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
}

const geoCache = new Map<string, IpLocation | null>();

async function lookupOne(ip: string): Promise<IpLocation | null> {
  if (geoCache.has(ip)) return geoCache.get(ip) ?? null;
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    if (!res.ok) throw new Error(`geo ${res.status}`);
    const j = (await res.json()) as {
      success?: boolean;
      city?: string;
      country?: string;
      country_code?: string;
    };
    if (!j.success || !j.country) {
      geoCache.set(ip, null);
      return null;
    }
    const loc: IpLocation = {
      city: j.city ?? null,
      country: j.country,
      countryCode: j.country_code ?? null,
      label: j.city ? `${j.city}, ${j.country}` : j.country,
    };
    geoCache.set(ip, loc);
    return loc;
  } catch {
    // Geo is an enhancement, not the data. On failure the caller falls back
    // to showing the raw IP, which is still truthful.
    geoCache.set(ip, null);
    return null;
  }
}

/** Resolves a set of IPs to locations. Deduplicates and caches. */
export async function lookupIpLocations(
  ips: string[],
): Promise<Map<string, IpLocation>> {
  const unique = Array.from(new Set(ips.filter(Boolean)));
  const out = new Map<string, IpLocation>();
  await Promise.all(
    unique.map(async (ip) => {
      const loc = await lookupOne(ip);
      if (loc) out.set(ip, loc);
    }),
  );
  return out;
}
