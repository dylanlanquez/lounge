import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Booking availability hooks shared between the customer widget and
// the staff-app booking sheets. Both surfaces need to know which
// dates have at least one bookable slot (to disable closed / empty
// days in their calendar) and where the very first bookable slot
// lives (to pre-pin the picker so the operator / customer never
// lands on a dead day).
//
// The RPCs they call are server-side and authoritative — past-time
// filter, lunch-break skip, post-block extent check, conflict
// check are all enforced inside the SQL functions
// (lng_widget_available_dates / lng_widget_first_available). That
// means a future change to the booking-engine rules flows through
// to every client without per-client patching.
//
// Hooks here are deliberately not coupled to the widget's local
// shape (slotFromIso, WidgetSlot etc) so the staff side can adopt
// them without dragging the widget's internals into its imports.
// The widget keeps its own thin wrapper that returns the
// widget-shaped result; this file returns the canonical staff-side
// shape (ISO date + ISO time strings).

const EMPTY_DATE_SET: ReadonlySet<string> = new Set();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────
// useFirstAvailableSlot — the very first bookable date+time
// ─────────────────────────────────────────────────────────────────────

export interface FirstAvailableSlotInput {
  locationId: string | null;
  serviceType: string | null;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
}

export interface FirstAvailableSlotResult {
  /** First bookable slot found by the server-side scanner, or null
   *  when the scan returned nothing in the 60-day window. */
  data: { dateIso: string; timeHm: string } | null;
  loading: boolean;
  error: string | null;
}

/** Calls public.lng_widget_first_available which scans up to 60
 *  days forward server-side, applying the same conflict + past-time
 *  + extent rules the slot list uses. Returns the first hit's date
 *  + HH:MM. Initial loading=true so consumers can distinguish
 *  "haven't asked yet" from "asked and got nothing". */
export function useFirstAvailableSlot(
  input: FirstAvailableSlotInput,
): FirstAvailableSlotResult {
  const [data, setData] = useState<FirstAvailableSlotResult['data']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!input.serviceType) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const realLocationId = UUID_RE.test(input.locationId ?? '')
        ? input.locationId
        : null;
      const { data: rows, error: err } = await supabase.rpc(
        'lng_widget_first_available',
        {
          p_location_id: realLocationId,
          p_service_type: input.serviceType,
          p_repair_variant: input.repairVariant,
          p_product_key: input.productKey,
          p_arch: input.arch,
        },
      );
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      const startAt = (row as { start_at?: string } | null)?.start_at;
      if (!startAt || typeof startAt !== 'string') {
        setData(null);
        setLoading(false);
        return;
      }
      // Server returns a timestamptz. Pull the local-clock YYYY-MM-DD
      // and HH:MM so the picker fields can store the same shape they
      // use for the user-driven flow.
      const d = new Date(startAt);
      const dateIso = formatLocalDateIso(d);
      const timeHm = formatLocalTimeHm(d);
      setData({ dateIso, timeHm });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    input.locationId,
    input.serviceType,
    input.repairVariant,
    input.productKey,
    input.arch,
  ]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────
// useAvailableDates — set of bookable dates inside a window
// ─────────────────────────────────────────────────────────────────────

export interface AvailableDatesInput {
  locationId: string | null;
  serviceType: string | null;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  /** Inclusive window start. Pass the calendar's first visible cell
   *  so closed days outside the current month aren't fetched needlessly. */
  fromIso: string | null;
  /** Inclusive window end. RPC caps the requested range at 60 days
   *  even if a careless caller asks for more. */
  toIso: string | null;
}

export interface AvailableDatesResult {
  /** Set of YYYY-MM-DD strings the calendar can enable. Empty Set
   *  while loading so the picker has to wait for live data before
   *  it lights any day up — prevents the operator from tapping a
   *  day that's about to flip to disabled. */
  dates: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
}

export function useAvailableDates(input: AvailableDatesInput): AvailableDatesResult {
  const [dates, setDates] = useState<ReadonlySet<string>>(EMPTY_DATE_SET);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!input.serviceType || !input.fromIso || !input.toIso) {
      setDates(EMPTY_DATE_SET);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const realLocationId = UUID_RE.test(input.locationId ?? '')
        ? input.locationId
        : null;
      const { data: rows, error: err } = await supabase.rpc(
        'lng_widget_available_dates',
        {
          p_location_id: realLocationId,
          p_service_type: input.serviceType,
          p_repair_variant: input.repairVariant,
          p_product_key: input.productKey,
          p_arch: input.arch,
          p_from: input.fromIso,
          p_to: input.toIso,
        },
      );
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const next = new Set<string>();
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const d = (r as { date?: string }).date;
          if (typeof d === 'string') next.add(d);
        }
      }
      setDates(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    input.locationId,
    input.serviceType,
    input.repairVariant,
    input.productKey,
    input.arch,
    input.fromIso,
    input.toIso,
  ]);

  return { dates, loading, error };
}

// ─────────────────────────────────────────────────────────────────────
// Local date / time formatters — kept here so consumers don't have
// to repeat the timezone-correct formatting logic.
// ─────────────────────────────────────────────────────────────────────

function formatLocalDateIso(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalTimeHm(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
