import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface TerminalReaderRow {
  id: string;
  friendly_name: string;
  stripe_reader_id: string;
  stripe_location_id: string;
  status: 'online' | 'offline' | 'unknown';
  last_seen_at: string | null;
}

interface Result {
  data: TerminalReaderRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Returns readers visible to the receptionist (RLS scopes to their location).
export function useTerminalReaders(): Result {
  const [data, setData] = useState<TerminalReaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_terminal_readers')
        .select('id, friendly_name, stripe_reader_id, stripe_location_id, status, last_seen_at')
        .order('friendly_name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as TerminalReaderRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

// Stripe Terminal Locations fetched via the terminal-list-locations
// edge function. Used by the Register reader form on Admin Devices.
export interface StripeTerminalLocation {
  id: string; // tml_…
  display_name: string;
  address: string | null;
}

export async function listStripeLocations(): Promise<StripeTerminalLocation[]> {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  const projectRef = url.hostname.split('.')[0];
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const r = await fetch(`https://${projectRef}.functions.supabase.co/terminal-list-locations`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; locations?: StripeTerminalLocation[]; error?: string };
  if (!r.ok || !body.ok) {
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return body.locations ?? [];
}

export interface RegisterReaderInput {
  registration_code: string;
  friendly_name: string;
  stripe_location_id: string;
  // Lounge-internal locations.id (UUID). Scopes the reader to a
  // clinic site; RLS reads it on subsequent queries.
  location_id: string;
}

export async function registerReader(input: RegisterReaderInput): Promise<void> {
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  const projectRef = url.hostname.split('.')[0];
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const r = await fetch(`https://${projectRef}.functions.supabase.co/terminal-register-reader`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok || !body.ok) {
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

// Lounge-internal locations table. Used to populate the
// Lounge-side picker on the register reader form.
export interface LoungeLocation {
  id: string;
  name: string | null;
}

export async function listLoungeLocations(): Promise<LoungeLocation[]> {
  const { data, error } = await supabase
    .from('locations')
    .select('id, name')
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as LoungeLocation[];
}
