import { useEffect, useRef } from 'react';
import { supabase } from './supabase.ts';

// One-stop helper for "this hook should auto-refresh whenever a row in
// these tables changes." Subscribes to Supabase Realtime postgres_changes
// for each entry in `subscriptions` and invokes the latest `onChange`
// every time the server pushes an event.
//
// Wiring contract:
//
//   useRealtimeRefresh(
//     [{ table: 'lng_appointments', filter: `patient_id=eq.${patientId}` }],
//     refresh,
//   );
//
// Each entry can specify table (required), filter (optional, server-
// side filter expression — same syntax as PostgREST `eq.value`), event
// (defaults to '*' so insert/update/delete all trigger), and schema
// (defaults to 'public').
//
// onChange is captured in a ref so callers can pass an inline arrow
// function without re-subscribing on every render. The channel only
// rebuilds when the *subscription set* changes (table list / filters /
// event types), which avoids tearing down a working CDC stream every
// time a parent component renders.
//
// Cleanup: removes the channel on unmount and on subscription change.
// Strict-mode double-mount in dev is handled because the cleanup runs
// before the second mount's effect.

export interface RealtimeSubscription {
  table: string;
  schema?: string;
  filter?: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
}

export function useRealtimeRefresh(
  subscriptions: RealtimeSubscription[],
  onChange: () => void,
): void {
  const onChangeRef = useRef(onChange);
  // Keep onChangeRef pointing at the latest closure so callbacks fire
  // with current state. (The channel callback below reads via .current.)
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Stable signature of the subscription set. The effect re-subscribes
  // only when this string changes — same set across renders => one
  // channel for the whole mount.
  const key = subscriptions
    .map((s) => `${s.schema ?? 'public'}.${s.table}|${s.event ?? '*'}|${s.filter ?? ''}`)
    .sort()
    .join(';');

  useEffect(() => {
    if (subscriptions.length === 0) return;
    // Channel name needs to be unique per mount so two components
    // listening to overlapping tables don't collide. A random suffix
    // keeps it cheap; supabase doesn't care what the channel is named
    // as long as the topic is unique within the connection.
    const channelName = `realtime-${Math.random().toString(36).slice(2, 10)}`;
    let channel = supabase.channel(channelName);
    for (const s of subscriptions) {
      channel = channel.on(
        // The supabase-js types are strict about the literal here, but
        // the runtime accepts a plain object. Cast at the boundary.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: s.event ?? '*',
          schema: s.schema ?? 'public',
          table: s.table,
          ...(s.filter ? { filter: s.filter } : {}),
        },
        () => onChangeRef.current(),
      );
    }
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // key encodes everything subscriptions could change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
