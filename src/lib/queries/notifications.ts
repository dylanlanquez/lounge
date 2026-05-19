// Notifications query layer for the TopBar bell + drawer.
//
// Architecture (see project_notifications.md memory):
//   • Notifications are NOT materialised. The patient_events table
//     already records every event the drawer surfaces
//     (appointment_booked, appointment_cancelled,
//     appointment_rescheduled, visit_ended_early) from every
//     surface that creates / cancels / reschedules an appointment
//     (Calendly webhook, widget create/cancel/reschedule, native
//     createAppointment/cancelAppointment/rescheduleAppointment,
//     admin paths).
//   • Per-account state (last_viewed_at, disabled_types) lives on
//     lng_account_notification_prefs. The bell badge is "rows newer
//     than last_viewed_at after disabled_types filter".
//   • Realtime: one INSERT subscription on patient_events filtered
//     to the four event_types. The bell mounts once on the home
//     variant and stays subscribed for as long as the staff member
//     is on a Lounge page that renders the TopBar.
//
// The four notification event types are intentionally CLOSED here
// — adding a new one is "extend NOTIFICATION_EVENT_TYPES + handle
// it in NotificationRow / NotificationIcon", not "rebuild a view".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.ts';
import { patientFullName } from './patients.ts';
import { formatCustomerServiceTitleLabel } from './appointments.ts';
import { formatTime } from '../dateFormat.ts';

export const NOTIFICATION_EVENT_TYPES = [
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
  'visit_ended_early',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

// Customer-facing label for each type. Mirrors the verb the user
// asked for in the spec ("booked for / cancelled / rescheduled /
// ended early"). Exposed so the settings sheet renders identical
// copy without re-deriving.
export const NOTIFICATION_TYPE_LABELS: Record<NotificationEventType, {
  // Short label on the row's top line.
  short: string;
  // Action verb in the middle-line sentence ("[patient] [verb] for
  // [booking type]"). Includes any preposition required.
  verb: string;
  // Long label used by the settings toggle.
  settings: string;
  // Hint copy on the settings row.
  hint: string;
}> = {
  appointment_booked: {
    short: 'New booking',
    verb: 'booked for',
    settings: 'New bookings',
    hint: 'When a patient books an appointment via the widget, Calendly, or staff.',
  },
  appointment_rescheduled: {
    short: 'Rescheduled',
    verb: 'rescheduled their',
    settings: 'Rescheduled bookings',
    hint: 'When an appointment is moved to a new date or time.',
  },
  appointment_cancelled: {
    short: 'Cancelled',
    verb: 'cancelled their',
    settings: 'Cancelled bookings',
    hint: 'When a booking is cancelled by the patient or staff.',
  },
  visit_ended_early: {
    short: 'Visit ended early',
    verb: 'had their visit ended early for',
    settings: 'Visits ended early',
    hint: 'When staff ends an in-clinic visit before completion.',
  },
};

// ── Notification row shape ────────────────────────────────────────

export interface NotificationRow {
  // patient_events.id — stable, used as React key + dedupe.
  id: string;
  event_type: NotificationEventType;
  // ISO timestamp of when the event happened. Drives the "2h ago"
  // chip + day-grouping section header.
  created_at: string;
  // Patient handle, pre-formatted.
  patient_id: string;
  patient_name: string;
  // Where to navigate when the row is clicked. Set to the
  // appointment route for appointment_* events; the visit route
  // for visit_ended_early. Null if neither id was present in the
  // payload (defensive — shouldn't happen with current writers).
  link_path: string | null;
  // The booking-type label, arch deliberately stripped per spec.
  booking_type: string;
  // Pre-formatted "Monday, 19 May 2026 at 10:30 BST" string for
  // the middle line. Null when the event didn't carry a start_at
  // (visit_ended_early has only the close time, not a future
  // appointment slot).
  scheduled_at_label: string | null;
}

// ── Booking-type label (no arch) ──────────────────────────────────
// The user's spec: "Do not include arch here at this level". We
// reuse formatCustomerServiceTitleLabel and explicitly null the
// arch — the helper's existing branches handle this cleanly
// (returning "Same-day Night Guard" instead of "Same-day Lower
// Night Guard", etc).
export function formatBookingTypeForNotification(args: {
  service_type: string | null;
  event_type_label: string | null;
  product_key: string | null;
  // We INCLUDE repair_variant for "Denture Repair" rows because
  // it's a useful detail and not arch-coupled — but the base
  // formatter handles that itself. (Denture Repair's variant
  // shows in a sub-table on the detail page; for notifications
  // the bare "Denture Repair" is the right level of detail.)
}): string {
  return formatCustomerServiceTitleLabel({
    service_type: args.service_type,
    event_type_label: args.event_type_label,
    arch: null,                 // ← deliberately stripped
    product_key: args.product_key,
  });
}

// ── Scheduled-at label ────────────────────────────────────────────
// "Monday, 19 May 2026 at 10:30 BST" exactly per spec. Built from
// the existing dateFormat helpers + a single timeZoneName segment
// from Intl.DateTimeFormat (toLocaleString doesn't expose
// timeZoneName cleanly on its own, so we use formatToParts).
export function formatNotificationDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // "Monday, 19 May 2026"
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const dayMonthYear = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  // "10:30"
  const time = formatTime(iso);
  // "BST" — pulled from the parts API; falls back silently if
  // unavailable on the runtime (older Safari).
  let tz = '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZoneName: 'short',
    }).formatToParts(d);
    tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    tz = '';
  }
  return tz
    ? `${weekday}, ${dayMonthYear} at ${time} ${tz}`
    : `${weekday}, ${dayMonthYear} at ${time}`;
}

// ── Compact relative time ─────────────────────────────────────────
// "2h ago" / "3d ago" / "just now". Same input range as
// relativeMinutes but in the short form the spec asked for.
export function formatRelativeShort(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;
  // Fall back to absolute date for events older than a month —
  // "10mo ago" reads ambiguous; "2 Apr" is clearer.
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Section header helper ─────────────────────────────────────────
// Linear/Notion convention: group rows by relative bucket so the
// drawer reads as a timeline, not a homogeneous list.
export function notificationSectionLabel(iso: string): 'Today' | 'Yesterday' | 'This week' | 'Earlier' {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return 'Earlier';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(target)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 7) return 'This week';
  return 'Earlier';
}

// ── Loader ────────────────────────────────────────────────────────

interface PatientEventReadRow {
  id: string;
  event_type: string;
  created_at: string;
  patient_id: string;
  payload: Record<string, unknown> | null;
  patient: {
    first_name: string;
    last_name: string;
    email: string | null;
  } | null;
}

interface AppointmentReadRow {
  id: string;
  event_type_label: string | null;
  service_type: string | null;
  product_key: string | null;
  start_at: string | null;
}

// Default look-back. 30 days is plenty for a bell that resets on
// click — anything older is unlikely to be actionable.
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_LIMIT = 80;

interface NotificationsState {
  rows: NotificationRow[];
  loading: boolean;
  error: string | null;
  unseenCount: number;
  lastViewedAt: string | null;
}

export interface UseNotificationsResult extends NotificationsState {
  refresh: () => void;
  markViewed: () => Promise<void>;
}

// Subscribes to patient_events with INSERT filter on the four
// notification event types. Returns the rendered notification rows
// plus the unseen count (rows.created_at > prefs.last_viewed_at).
export function useNotifications(): UseNotificationsResult {
  const [state, setState] = useState<NotificationsState>({
    rows: [],
    loading: true,
    error: null,
    unseenCount: 0,
    lastViewedAt: null,
  });
  // tick bumps refetch without resubscribing. realtime INSERTs bump
  // it; manual refresh() bumps it.
  const [tick, setTick] = useState(0);

  // Cache the prefs separately so the realtime channel can read the
  // current cutoff without a re-mount.
  const prefsRef = useRef<{ last_viewed_at: string; disabled_types: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setState((s) => ({ ...s, loading: true, error: null }));

        // Fetch (or create) the prefs row for the current account.
        // The fallback-to-default path covers a fresh staff account
        // that's never opened the bell — we treat their entire
        // history as "unseen" until first open.
        const { data: accountIdRow } = await supabase.rpc('auth_account_id');
        const accountId = accountIdRow as string | null;
        let prefs: { last_viewed_at: string; disabled_types: string[] } | null = null;
        if (accountId) {
          const { data: prefsRow } = await supabase
            .from('lng_account_notification_prefs')
            .select('last_viewed_at, disabled_types')
            .eq('account_id', accountId)
            .maybeSingle();
          if (prefsRow) {
            prefs = prefsRow as { last_viewed_at: string; disabled_types: string[] };
          }
        }
        prefsRef.current = prefs;

        const disabledTypes = new Set(prefs?.disabled_types ?? []);
        const enabledTypes = NOTIFICATION_EVENT_TYPES.filter((t) => !disabledTypes.has(t));

        if (enabledTypes.length === 0) {
          // All types muted — short-circuit to an empty list so the
          // empty state renders with a hint to re-enable in
          // settings.
          if (cancelled) return;
          setState({
            rows: [],
            loading: false,
            error: null,
            unseenCount: 0,
            lastViewedAt: prefs?.last_viewed_at ?? null,
          });
          return;
        }

        const since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
        const { data: eventRows, error: eventErr } = await supabase
          .from('patient_events')
          .select(
            'id, event_type, created_at, patient_id, payload, patient:patients(first_name, last_name, email)',
          )
          .in('event_type', enabledTypes)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(DEFAULT_LIMIT);
        if (eventErr) throw new Error(eventErr.message);
        const events = (eventRows ?? []) as unknown as PatientEventReadRow[];

        // Collect appointment ids we need event_type_label for. The
        // payload already carries service_type / product_key /
        // start_at, so this is purely to surface the Calendly
        // label for events whose service_type is "other".
        const appointmentIds = Array.from(
          new Set(
            events
              .map((e) => {
                const p = e.payload ?? {};
                return typeof p.appointment_id === 'string' ? p.appointment_id : null;
              })
              .filter((id): id is string => !!id),
          ),
        );
        let appointmentsById = new Map<string, AppointmentReadRow>();
        if (appointmentIds.length > 0) {
          const { data: apptRows } = await supabase
            .from('lng_appointments')
            .select('id, event_type_label, service_type, product_key, start_at')
            .in('id', appointmentIds);
          appointmentsById = new Map(
            ((apptRows ?? []) as AppointmentReadRow[]).map((a) => [a.id, a]),
          );
        }

        const rows: NotificationRow[] = events
          .map((e) => mapEventToRow(e, appointmentsById))
          .filter((r): r is NotificationRow => r !== null);

        const cutoff = prefs?.last_viewed_at ?? null;
        const unseenCount = cutoff
          ? rows.filter((r) => r.created_at > cutoff).length
          : rows.length;

        if (cancelled) return;
        setState({
          rows,
          loading: false,
          error: null,
          unseenCount,
          lastViewedAt: prefs?.last_viewed_at ?? null,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          rows: [],
          loading: false,
          error: e instanceof Error ? e.message : 'Unknown error',
          unseenCount: 0,
          lastViewedAt: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Realtime INSERT subscription. We can't filter by an IN list on
  // the channel (postgres_changes only supports eq/neq), so we
  // listen for every INSERT on patient_events and discard payloads
  // whose event_type isn't one of ours in the handler. The volume
  // is low enough (a few hundred events / day across the whole
  // table) that the client-side discard is cheap.
  useEffect(() => {
    const channel = supabase
      .channel('lng_notifications:patient_events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'patient_events' },
        (payload) => {
          const row = payload.new as { event_type?: string };
          if (!row.event_type) return;
          if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(row.event_type)) return;
          // Defer to the next tick of the loader so the new row is
          // joined to patient + appointment in the same pass as the
          // initial fetch (consistent shape).
          setTick((t) => t + 1);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const markViewed = useCallback(async () => {
    const { data: accountIdRow } = await supabase.rpc('auth_account_id');
    const accountId = accountIdRow as string | null;
    if (!accountId) return;
    const now = new Date().toISOString();
    // Upsert keyed on account_id. We can't use ON CONFLICT directly
    // through the JS client, so a maybeSingle-then-update-or-insert
    // sequence is safer; the worst case is a benign race where two
    // tabs open the bell at the same time and we end up with two
    // upserts — but the UNIQUE constraint on account_id means only
    // one wins, and we surface that no-op via .upsert below.
    const { error: upsertErr } = await supabase
      .from('lng_account_notification_prefs')
      .upsert(
        { account_id: accountId, last_viewed_at: now },
        { onConflict: 'account_id' },
      );
    if (upsertErr) {
      // Don't throw — failure to mark-viewed is a "badge stays on"
      // bug, not a data-loss bug. Log and continue.
      console.warn('[notifications] markViewed failed', upsertErr.message);
      return;
    }
    setState((s) => ({ ...s, lastViewedAt: now, unseenCount: 0 }));
  }, []);

  return { ...state, refresh, markViewed };
}

function mapEventToRow(
  event: PatientEventReadRow,
  appointmentsById: Map<string, AppointmentReadRow>,
): NotificationRow | null {
  const type = event.event_type as NotificationEventType;
  if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) return null;

  const patient = event.patient;
  const patientName = patient ? patientFullName(patient) : 'Patient';

  const payload = event.payload ?? {};
  const apptIdFromPayload =
    typeof payload.appointment_id === 'string' ? payload.appointment_id : null;
  const visitIdFromPayload =
    typeof payload.visit_id === 'string' ? payload.visit_id : null;

  // Resolve booking-type label from payload (the event row freezes
  // the values at the moment the event happened — survives later
  // catalogue changes), falling back to the joined appointment for
  // event_type_label.
  const apptRow = apptIdFromPayload ? appointmentsById.get(apptIdFromPayload) : null;
  const serviceType =
    (typeof payload.service_type === 'string' ? payload.service_type : null) ??
    apptRow?.service_type ?? null;
  const productKey =
    (typeof payload.product_key === 'string' ? payload.product_key : null) ??
    apptRow?.product_key ?? null;
  const eventTypeLabel = apptRow?.event_type_label ?? null;

  const bookingType = formatBookingTypeForNotification({
    service_type: serviceType,
    event_type_label: eventTypeLabel,
    product_key: productKey,
  });

  // Scheduled-at label. visit_ended_early doesn't carry a future
  // start_at — those rows don't show the date/time line. The other
  // three types carry start_at on the payload.
  const startAt =
    (typeof payload.start_at === 'string' ? payload.start_at : null) ??
    apptRow?.start_at ?? null;
  const scheduledAtLabel = startAt ? formatNotificationDateTime(startAt) : null;

  // Link path:
  //   • appointment_* events → /appointment/<id>  (pre-visit)
  //   • visit_ended_early    → /visit/<id>        (after arrival)
  const linkPath =
    type === 'visit_ended_early'
      ? visitIdFromPayload ? `/visit/${visitIdFromPayload}` : null
      : apptIdFromPayload ? `/appointment/${apptIdFromPayload}` : null;

  return {
    id: event.id,
    event_type: type,
    created_at: event.created_at,
    patient_id: event.patient_id,
    patient_name: patientName,
    link_path: linkPath,
    booking_type: bookingType,
    scheduled_at_label: scheduledAtLabel,
  };
}

// ── Prefs hook ────────────────────────────────────────────────────
// Used by the settings panel. Returns the current prefs + a mutator
// for the disabled_types list. The realtime channel above will
// re-fetch the notifications list when the toggle flips.

export interface NotificationPrefs {
  last_viewed_at: string;
  disabled_types: NotificationEventType[];
}

export interface UseNotificationPrefsResult {
  prefs: NotificationPrefs | null;
  loading: boolean;
  error: string | null;
  setTypeEnabled: (type: NotificationEventType, enabled: boolean) => Promise<void>;
}

export function useNotificationPrefs(): UseNotificationPrefsResult {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: accountIdRow } = await supabase.rpc('auth_account_id');
      const accountId = accountIdRow as string | null;
      if (!accountId) {
        setPrefs(null);
        return;
      }
      const { data, error: err } = await supabase
        .from('lng_account_notification_prefs')
        .select('last_viewed_at, disabled_types')
        .eq('account_id', accountId)
        .maybeSingle();
      if (err) throw new Error(err.message);
      setPrefs(
        data
          ? {
              last_viewed_at: (data as { last_viewed_at: string }).last_viewed_at,
              disabled_types: ((data as { disabled_types: string[] }).disabled_types ??
                []) as NotificationEventType[],
            }
          : {
              last_viewed_at: new Date(0).toISOString(),
              disabled_types: [],
            },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setTypeEnabled = useCallback(
    async (type: NotificationEventType, enabled: boolean) => {
      const { data: accountIdRow } = await supabase.rpc('auth_account_id');
      const accountId = accountIdRow as string | null;
      if (!accountId) return;
      // Compute the next disabled_types optimistically so the UI
      // checkbox flips without waiting for the round trip.
      const currentDisabled = prefs?.disabled_types ?? [];
      const nextDisabled = enabled
        ? currentDisabled.filter((t) => t !== type)
        : Array.from(new Set([...currentDisabled, type]));
      setPrefs((p) =>
        p ? { ...p, disabled_types: nextDisabled } : p,
      );
      const { error: upsertErr } = await supabase
        .from('lng_account_notification_prefs')
        .upsert(
          { account_id: accountId, disabled_types: nextDisabled },
          { onConflict: 'account_id' },
        );
      if (upsertErr) {
        // Revert optimistic flip on failure.
        setPrefs((p) =>
          p ? { ...p, disabled_types: currentDisabled } : p,
        );
        setError(upsertErr.message);
      }
    },
    [prefs?.disabled_types],
  );

  return { prefs, loading, error, setTypeEnabled };
}

// ── Search ────────────────────────────────────────────────────────
// Client-side substring matching across the rendered row fields.
// Case-insensitive, naive contains — no regex. Returns the rows
// in the same order they came in (top-down newest-first).
export function filterNotifications(rows: NotificationRow[], query: string): NotificationRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows;
  return rows.filter((r) => {
    const haystack = `${r.patient_name} ${r.booking_type} ${r.scheduled_at_label ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}

// ── Day grouping ──────────────────────────────────────────────────
// Linear-style sections. Returns an array of { label, rows } in
// display order (Today first).
export interface NotificationSection {
  label: 'Today' | 'Yesterday' | 'This week' | 'Earlier';
  rows: NotificationRow[];
}

export function groupNotificationsByDay(rows: NotificationRow[]): NotificationSection[] {
  const order: NotificationSection['label'][] = ['Today', 'Yesterday', 'This week', 'Earlier'];
  const byLabel = new Map<NotificationSection['label'], NotificationRow[]>();
  for (const label of order) byLabel.set(label, []);
  for (const r of rows) {
    const label = notificationSectionLabel(r.created_at);
    byLabel.get(label)!.push(r);
  }
  return order
    .map((label) => ({ label, rows: byLabel.get(label) ?? [] }))
    .filter((s) => s.rows.length > 0);
}

// Memo-stable section list — recomputes only when the row IDs
// change so React doesn't rebuild the tree on every render. Used
// by the drawer.
export function useGroupedNotifications(rows: NotificationRow[]): NotificationSection[] {
  return useMemo(() => groupNotificationsByDay(rows), [rows]);
}

