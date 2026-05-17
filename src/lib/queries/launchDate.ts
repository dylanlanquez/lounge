// Lounge launch-date settings + pre-launch no-show backfill.
//
// Reads / writes the `lounge.launch_date` row in lng_settings and
// invokes the lng_pre_launch_no_show_backfill() RPC defined in
// 20260517000001_lng_pre_launch_no_show_backfill.sql. Used by the
// Admin > Testing tab's Launch card so Dylan can set the launch date
// and run the cleanup without dropping into psql.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

const SETTING_KEY = 'lounge.launch_date';

interface UseLaunchDate {
  /** ISO timestamptz string the launch_date is set to, or null when unset. */
  data: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLaunchDate(): UseLaunchDate {
  const [data, setData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const res = await supabase
        .from('lng_settings')
        .select('value')
        .is('location_id', null)
        .eq('key', SETTING_KEY)
        .maybeSingle();
      if (cancelled) return;
      if (res.error) {
        setError(res.error.message);
        setLoading(false);
        return;
      }
      // JSONB value can be the JSON null literal when unset — strip it.
      const raw = res.data?.value ?? null;
      const iso = typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
      setData(iso);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

/**
 * Upsert the launch_date value. Pass null to clear it back to the
 * "not set" state (which causes the backfill RPC to refuse to run).
 * The settings row is created by the 20260517000001 migration, so this
 * function only updates an existing row; if it's missing somehow we
 * insert defensively rather than 404.
 */
export async function setLaunchDate(iso: string | null): Promise<void> {
  // jsonb literal 'null' when clearing; JSON-encoded string otherwise.
  const value: unknown = iso === null ? null : iso;
  const { data: existing, error: readErr } = await supabase
    .from('lng_settings')
    .select('key')
    .is('location_id', null)
    .eq('key', SETTING_KEY)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  if (existing) {
    const { error } = await supabase
      .from('lng_settings')
      .update({ value })
      .is('location_id', null)
      .eq('key', SETTING_KEY);
    if (error) throw new Error(error.message);
    return;
  }

  // Settings row missing — recreate so the function can find it next
  // call. Mirrors the migration's description verbatim.
  const { error } = await supabase.from('lng_settings').insert({
    location_id: null,
    key: SETTING_KEY,
    value,
    description:
      'The instant Lounge went live (ISO timestamptz string in JSONB). Drives lng_pre_launch_no_show_backfill() and any future "since launch" reporting filters.',
  });
  if (error) throw new Error(error.message);
}

/**
 * Invoke lng_pre_launch_no_show_backfill(). Returns the number of
 * rows flipped to no_show. The function reads launch_date itself from
 * lng_settings — the date passed here is purely for the optimistic
 * "X rows will flip" preview shown in the UI.
 */
export async function runPreLaunchBackfill(): Promise<number> {
  const { data, error } = await supabase.rpc('lng_pre_launch_no_show_backfill');
  if (error) throw new Error(error.message);
  if (typeof data !== 'number' || !Number.isFinite(data)) {
    throw new Error('Unexpected response from lng_pre_launch_no_show_backfill');
  }
  return data;
}

/**
 * Preview how many rows the backfill would flip if it ran right now
 * against the supplied launch instant. Pure read — does not modify
 * any rows. Used by the Admin card to show "X rows will be flipped"
 * before the operator commits.
 */
export async function previewPreLaunchBackfillCount(iso: string): Promise<number> {
  const { count, error } = await supabase
    .from('lng_appointments')
    .select('id', { head: true, count: 'exact' })
    .eq('status', 'booked')
    .lt('end_at', iso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
