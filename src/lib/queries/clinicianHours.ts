import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { OpeningHoursDay, OpeningHoursWeek } from './clinicSettings.ts';

// Per-clinician (staff member) virtual availability: weekly hours +
// date overrides. Stored in lng_clinician_hours / lng_clinician_overrides
// keyed on staff_member_id (migration 20260609000006), written through
// the is_admin-gated RPCs.
//
// The weekly grid reuses the clinic opening-hours shape (OpeningHoursWeek)
// so the editor matches the clinic editor exactly. A day with a midday
// break is stored as TWO windows (open->break, break->close); a day
// without is one window; a closed day has no rows.

export interface ClinicianOverride {
  id: string;
  override_date: string; // 'YYYY-MM-DD'
  kind: 'available' | 'off';
  start_local: string | null; // 'HH:MM' or null for a whole-day off
  end_local: string | null;
  note: string | null;
}

export interface ClinicianSchedule {
  weekly: OpeningHoursWeek;
  overrides: ClinicianOverride[];
}

interface HourRow {
  day_of_week: number;
  start_local: string;
  end_local: string;
}

const trim5 = (t: string | null): string => (t ? t.slice(0, 5) : '');

const CLOSED: OpeningHoursDay = { closed: true };

// DB rows -> OpeningHoursWeek. One window = open/close; two windows =
// open/close with the gap read as a break; zero = closed.
function rowsToWeek(rows: HourRow[]): OpeningHoursWeek {
  const byDay: HourRow[][] = [[], [], [], [], [], [], []];
  for (const r of rows) {
    if (r.day_of_week >= 0 && r.day_of_week <= 6) byDay[r.day_of_week]!.push(r);
  }
  const week = byDay.map((dayRows): OpeningHoursDay => {
    if (dayRows.length === 0) return CLOSED;
    const sorted = [...dayRows].sort((a, b) => a.start_local.localeCompare(b.start_local));
    const open = trim5(sorted[0]!.start_local);
    const close = trim5(sorted[sorted.length - 1]!.end_local);
    if (sorted.length === 2) {
      return {
        open,
        close,
        break: [trim5(sorted[0]!.end_local), trim5(sorted[1]!.start_local)] as [string, string],
      };
    }
    return { open, close };
  });
  return week as unknown as OpeningHoursWeek;
}

// OpeningHoursWeek -> the jsonb window array the RPC expects.
function weekToWindows(week: OpeningHoursWeek): Array<{ day_of_week: number; start: string; end: string }> {
  const out: Array<{ day_of_week: number; start: string; end: string }> = [];
  week.forEach((day, dow) => {
    if (day.closed === true || !day.open || !day.close) return;
    const br = day.break;
    if (br && br[0] > day.open && br[1] < day.close && br[1] > br[0]) {
      out.push({ day_of_week: dow, start: day.open, end: br[0] });
      out.push({ day_of_week: dow, start: br[1], end: day.close });
    } else {
      out.push({ day_of_week: dow, start: day.open, end: day.close });
    }
  });
  return out;
}

export async function fetchClinicianSchedule(staffMemberId: string): Promise<ClinicianSchedule> {
  const [hoursRes, overridesRes] = await Promise.all([
    supabase
      .from('lng_clinician_hours')
      .select('day_of_week, start_local, end_local')
      .eq('staff_member_id', staffMemberId)
      .order('day_of_week', { ascending: true })
      .order('start_local', { ascending: true }),
    supabase
      .from('lng_clinician_overrides')
      .select('id, override_date, kind, start_local, end_local, note')
      .eq('staff_member_id', staffMemberId)
      .order('override_date', { ascending: true }),
  ]);
  if (hoursRes.error) throw new Error(hoursRes.error.message);
  if (overridesRes.error) throw new Error(overridesRes.error.message);

  const weekly = rowsToWeek((hoursRes.data ?? []) as HourRow[]);
  const overrides: ClinicianOverride[] = (overridesRes.data ?? []).map((r) => ({
    id: r.id as string,
    override_date: r.override_date as string,
    kind: r.kind as 'available' | 'off',
    start_local: r.start_local ? trim5(r.start_local as string) : null,
    end_local: r.end_local ? trim5(r.end_local as string) : null,
    note: (r.note as string | null) ?? null,
  }));
  return { weekly, overrides };
}

export async function setClinicianHours(staffMemberId: string, week: OpeningHoursWeek): Promise<void> {
  const { error } = await supabase.rpc('lng_set_clinician_hours', {
    p_staff_member_id: staffMemberId,
    p_windows: weekToWindows(week),
  });
  if (error) throw new Error(error.message);
}

export async function addClinicianOverride(args: {
  staffMemberId: string;
  date: string; // 'YYYY-MM-DD'
  kind: 'available' | 'off';
  start?: string | null; // 'HH:MM'
  end?: string | null;
  note?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('lng_add_clinician_override', {
    p_staff_member_id: args.staffMemberId,
    p_date: args.date,
    p_kind: args.kind,
    p_start_local: args.start ?? null,
    p_end_local: args.end ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function deleteClinicianOverride(overrideId: string): Promise<void> {
  const { error } = await supabase.rpc('lng_delete_clinician_override', {
    p_override_id: overrideId,
  });
  if (error) throw new Error(error.message);
}

// ── Clinician picker (staff booking sheets) ──────────────────────
export interface VirtualClinician {
  staff_member_id: string;
  display_name: string;
  clinician_self_serve: boolean;
}

interface ClinicianAccountJoin {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}

// Active virtual impression clinicians, for the staff New Booking /
// Reschedule clinician picker. Read-only; authenticated staff can read
// lng_staff_members under its RLS select policy.
export function useVirtualClinicians(): { clinicians: VirtualClinician[]; loading: boolean; error: string | null } {
  const [clinicians, setClinicians] = useState<VirtualClinician[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_staff_members')
        .select('id, clinician_self_serve, account:accounts!account_id(first_name, last_name, name)')
        .eq('is_virtual_impression_clinician', true)
        .eq('status', 'active');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const rows: VirtualClinician[] = (data ?? []).map((r) => {
        const raw = r as { id: string; clinician_self_serve: boolean | null; account: ClinicianAccountJoin | ClinicianAccountJoin[] | null };
        const a = Array.isArray(raw.account) ? raw.account[0] : raw.account;
        const fn = a?.first_name?.trim() ?? null;
        const ln = a?.last_name?.trim() ?? null;
        const display = fn && ln ? `${fn} ${ln}` : fn ?? ln ?? a?.name?.trim() ?? 'Clinician';
        return {
          staff_member_id: raw.id,
          display_name: display,
          clinician_self_serve: raw.clinician_self_serve !== false,
        };
      });
      rows.sort((x, y) => x.display_name.localeCompare(y.display_name, 'en-GB'));
      setError(null);
      setClinicians(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { clinicians, loading, error };
}

// Dates a clinician has availability for, driving the booking calendar's
// per-day enabled state for virtual impressions (clinician hours, not
// clinic hours). Empty set when no clinician/window is given.
export function useClinicianAvailableDates(args: {
  staffMemberId: string | null;
  selfServeOnly?: boolean;
  fromIso: string | null;
  toIso: string | null;
}): { dates: ReadonlySet<string>; loading: boolean } {
  const { staffMemberId, fromIso, toIso } = args;
  const selfServeOnly = args.selfServeOnly ?? false;
  const [dates, setDates] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!staffMemberId || !fromIso || !toIso) {
      setDates(new Set());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.rpc('lng_clinician_available_dates', {
        p_staff_member_id: staffMemberId,
        p_self_serve_only: selfServeOnly,
        p_from: fromIso,
        p_to: toIso,
      });
      if (cancelled) return;
      if (error) {
        setDates(new Set());
        setLoading(false);
        return;
      }
      setDates(new Set<string>((data ?? []).map((r: { date: string }) => r.date)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [staffMemberId, selfServeOnly, fromIso, toIso]);

  return { dates, loading };
}
