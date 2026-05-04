// Booking-widget data layer.
//
// Booking types come live from the public `lng_widget_booking_types`
// view; products + per-arch prices come from `lng_widget_catalogue`.
// Locations are still hard-coded for the single-clinic footprint
// and slots are stub-generated (phase 2c will land a server-side
// resolver that respects existing appointments + opening hours).
//
// Dentist selection isn't a customer-facing concept — the practice
// assigns staff internally based on availability. No dentist step
// in the widget; previous prototype removed.

export interface WidgetLocation {
  id: string;
  name: string;
  addressLine: string; // joined "138 Main Street, Glasgow, G1 2QA"
}

export interface WidgetBookingType {
  id: string;
  /** The closed-enum service identifier ('click_in_veneers',
   *  'denture_repair', 'same_day_appliance', etc). Drives the axis
   *  registry — see SERVICE_AXES in lib/queries/bookingTypeAxes.ts. */
  serviceType: string;
  /** Display label, sourced from `lng_booking_type_config.display_label`.
   *  No widget-specific override — the staff app and widget show the
   *  same name for the same service. */
  label: string;
  description: string;
  /** Deposit captured at booking time, in pence. 0 means no payment
   *  step. Widget-specific; sourced from
   *  lng_booking_type_config.widget_deposit_pence. */
  depositPence: number;
  /** Default appointment length. Phase 2c will resolve this to the
   *  most-specific lng_booking_type_config row once axes are pinned. */
  durationMinutes: number;
}

// Phase 2c had a single hardcoded location entry that the edge
// functions resolved server-side via a UUID-or-default fallback.
// Phase 6 (multi-location) reads them live from
// public.lng_widget_locations — see useWidgetLocations() below.
// The constant stays as an empty fallback so any code path that
// touches it without going through the hook degrades to "no
// locations" rather than crashing.
export const WIDGET_LOCATIONS: WidgetLocation[] = [];

export interface WidgetUpgrade {
  id: string;
  name: string;
  description: string;
  unitPricePence: number;
  bothArchesPricePence: number | null;
}

export interface ResolvedCatalogueRow {
  id: string;
  name: string;
  unitPricePence: number;
  bothArchesPricePence: number | null;
  archMatch: 'any' | 'single' | 'both';
}

// ─────────────────────────────────────────────────────────────────────────────
// Live location read
// ─────────────────────────────────────────────────────────────────────────────

interface LocationReadResult {
  data: WidgetLocation[] | null;
  loading: boolean;
  error: string | null;
}

/** Reads the public lng_widget_locations view. Anon-readable, so
 *  the patient never has to be signed in. Single-fire on mount,
 *  no real-time. */
export function useWidgetLocations(): LocationReadResult {
  const [data, setData] = useState<WidgetLocation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_widget_locations')
        .select('id, name, address_line')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const shaped: WidgetLocation[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        name: (r.name as string) ?? '',
        addressLine: (r.address_line as string) ?? '',
      }));
      setData(shaped);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live booking-type read
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.ts';

interface BookingTypeReadResult {
  data: WidgetBookingType[] | null;
  loading: boolean;
  error: string | null;
}

/** Reads the public `lng_widget_booking_types` view. The view
 *  exposes only widget-visible parent rows, anon-readable, so this
 *  works without the patient signing in. Single-fire on mount,
 *  no real-time. */
export function useWidgetBookingTypes(): BookingTypeReadResult {
  const [data, setData] = useState<WidgetBookingType[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_widget_booking_types')
        .select('id, service_type, label, description, deposit_pence, duration_minutes')
        .order('label', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const shaped: WidgetBookingType[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        serviceType: (r.service_type as string) ?? '',
        label: (r.label as string) ?? '',
        description: (r.description as string) ?? '',
        depositPence: (r.deposit_pence as number) ?? 0,
        durationMinutes: (r.duration_minutes as number) ?? 30,
      }));
      setData(shaped);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot generator — v1 stub
// ─────────────────────────────────────────────────────────────────────────────
//
// Given a date, returns the slots a patient could pick. Phase 2
// replaces this with a server resolver that queries existing
// `lng_appointments` for conflicts and respects `clinic.opening_hours`
// from `lng_settings`. For now the stub is good enough to drive the
// UI: 9am–6pm weekdays, 10am–4pm Saturday, closed Sunday, in
// 15-minute increments. Lunch hour (1–2pm) is removed. Slots are
// further filtered by the booking type's duration so a 90-minute
// service doesn't show a 5:30pm option.

export interface WidgetSlot {
  /** ISO 8601 start time, local clinic timezone. */
  iso: string;
  /** Display string, e.g. "9:45 am". */
  label: string;
  /** Bucket the slot lands in for grouped display. */
  bucket: 'morning' | 'afternoon' | 'evening';
}

export function generateSlots(date: Date, durationMinutes: number): WidgetSlot[] {
  const dow = date.getDay(); // 0 Sun, 1 Mon, ..., 6 Sat
  if (dow === 0) return [];
  const isSaturday = dow === 6;
  const openHour = isSaturday ? 10 : 9;
  const closeHour = isSaturday ? 16 : 18;
  const stepMinutes = 15;
  const slots: WidgetSlot[] = [];
  for (let hour = openHour; hour < closeHour; hour++) {
    for (let minute = 0; minute < 60; minute += stepMinutes) {
      // Skip the 1pm-2pm lunch hour for non-Saturday.
      if (!isSaturday && hour === 13) continue;
      // Slot must finish before close.
      const minutesAfterOpen = (hour - openHour) * 60 + minute;
      const endMinutes = minutesAfterOpen + durationMinutes;
      const totalOpenMinutes = (closeHour - openHour) * 60 - (isSaturday ? 0 : 60);
      if (endMinutes > totalOpenMinutes) continue;

      const slotDate = new Date(date);
      slotDate.setHours(hour, minute, 0, 0);
      const iso = slotDate.toISOString();

      const period = hour < 12 ? 'am' : 'pm';
      const displayHour = hour <= 12 ? hour : hour - 12;
      const label = `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;

      const bucket: WidgetSlot['bucket'] =
        hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

      slots.push({ iso, label, bucket });
    }
  }
  return slots;
}

/** First future date that has at least one slot for the given
 *  booking-type duration. Used to power the "Our first availability"
 *  banner. The banner is best-effort — if the picked slot turns out
 *  to be booked already, the live slot picker on the date page will
 *  show that, and the submit-time conflict check is the final
 *  guarantee. Phase 6 will add a server-side first-available RPC. */
export function firstAvailable(
  durationMinutes: number,
  from: Date = new Date(),
): { date: Date; slot: WidgetSlot } | null {
  for (let i = 0; i < 60; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const slots = generateSlots(d, durationMinutes);
    if (slots.length > 0) return { date: d, slot: slots[0]! };
  }
  return null;
}

/** Closed-day check used by the calendar grid to dim un-bookable
 *  dates without firing one availability RPC per cell. The clinic
 *  is closed on Sundays — the rest of the dimming (no free slots
 *  for this duration on a given day) reads from the live RPC once
 *  the patient picks a date. */
export function isClosedDay(date: Date): boolean {
  return date.getDay() === 0;
}

/** Build a WidgetSlot from a raw ISO 8601 timestamptz returned by
 *  lng_widget_available_slots. Reads in the patient's local
 *  timezone — fine for UK patients (the Glasgow clinic's only
 *  market today). Multi-region rollout will revisit. */
export function slotFromIso(iso: string): WidgetSlot {
  const d = new Date(iso);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const period = hour < 12 ? 'am' : 'pm';
  const displayHour = hour <= 12 ? hour : hour - 12;
  return {
    iso,
    label: `${displayHour}:${String(minute).padStart(2, '0')} ${period}`,
    bucket: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live availability resolver
// ─────────────────────────────────────────────────────────────────────────────
//
// Calls public.lng_widget_available_slots — a SECURITY DEFINER RPC
// that generates the same candidate grid the stub did, then filters
// each candidate through lng_booking_check_conflict. The patient
// only ever sees real availability.
//
// Loading-state contract: while a fetch is in flight `data` keeps
// the previous date's slots visible, so the day-shift doesn't blink.
// The consumer can show a faint "Checking…" footer if they want to
// surface the in-flight state.

interface AvailableSlotsInput {
  locationId: string | null;
  serviceType: string | null;
  date: Date | null;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
}

interface AvailableSlotsResult {
  data: WidgetSlot[] | null;
  loading: boolean;
  error: string | null;
}

export function useWidgetAvailableSlots(input: AvailableSlotsInput): AvailableSlotsResult {
  const [data, setData] = useState<WidgetSlot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Memoise the date as YYYY-MM-DD so we don't refetch on identical
  // dates expressed as different Date instances.
  const dateKey = input.date ? toIsoDate(input.date) : null;

  useEffect(() => {
    if (!input.locationId || !input.serviceType || !dateKey) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      // Stub locations (id="loc-1") fall through to the RPC's
      // default-location resolver. Phase 6 (multi-location) will
      // make the WIDGET_LOCATIONS list a live read so the client
      // always has a real UUID.
      const realLocationId = UUID_RE.test(input.locationId ?? '') ? input.locationId : null;
      const { data: rows, error: err } = await supabase.rpc('lng_widget_available_slots', {
        p_location_id: realLocationId,
        p_service_type: input.serviceType,
        p_date: dateKey,
        p_repair_variant: input.repairVariant,
        p_product_key: input.productKey,
        p_arch: input.arch,
      });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const shaped: WidgetSlot[] = Array.isArray(rows)
        ? rows
            .map((r) => (typeof r === 'object' && r && 'start_at' in r ? (r as { start_at: string }).start_at : null))
            .filter((iso): iso is string => typeof iso === 'string')
            .map(slotFromIso)
        : [];
      setData(shaped);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    input.locationId,
    input.serviceType,
    dateKey,
    input.repairVariant,
    input.productKey,
    input.arch,
  ]);

  return { data, loading, error };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIsoDate(d: Date): string {
  // Local-date YYYY-MM-DD — matches what the RPC's `date` parameter
  // expects when treated as Europe/London civil time.
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live catalogue resolver
// ─────────────────────────────────────────────────────────────────────────────
//
// Once the patient has pinned the axes their service requires, we
// can identify the single catalogue row that price applies to.
// `lwo_catalogue` already has an open SELECT policy so this works
// anonymously — we filter by service_type plus whichever axis
// dimension the registry declared (product_key for same-day
// appliances, repair_variant for denture repair, neither for
// click-in veneers / impressions). At most one row matches.

interface ResolverInput {
  serviceType: string | null;
  productKey: string | null;
  repairVariant: string | null;
}

interface ResolverResult {
  data: ResolvedCatalogueRow | null;
  loading: boolean;
  error: string | null;
}

/** Resolves the catalogue row that applies to the patient's
 *  service + axis selection. Returns null while the service hasn't
 *  been picked or while the query is pending. */
export function useResolvedCatalogueRow(input: ResolverInput): ResolverResult {
  const [data, setData] = useState<ResolvedCatalogueRow | null>(null);
  const [loading, setLoading] = useState(false);
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
    (async () => {
      let q = supabase
        .from('lwo_catalogue')
        .select('id, name, unit_price, both_arches_price, arch_match')
        .eq('service_type', input.serviceType)
        .eq('active', true);
      if (input.productKey) q = q.eq('product_key', input.productKey);
      else q = q.is('product_key', null);
      if (input.repairVariant) q = q.eq('repair_variant', input.repairVariant);
      else q = q.is('repair_variant', null);
      const { data: row, error: err } = await q.maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setData(null);
        setLoading(false);
        return;
      }
      if (!row) {
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      setData({
        id: row.id as string,
        name: (row.name as string) ?? '',
        unitPricePence: Math.round(Number(row.unit_price) * 100),
        bothArchesPricePence:
          row.both_arches_price === null
            ? null
            : Math.round(Number(row.both_arches_price) * 100),
        archMatch: (row.arch_match as 'any' | 'single' | 'both') ?? 'any',
      });
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [input.serviceType, input.productKey, input.repairVariant]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live upgrade read
// ─────────────────────────────────────────────────────────────────────────────

interface UpgradeReadResult {
  data: WidgetUpgrade[] | null;
  loading: boolean;
  error: string | null;
}

/** Reads `lng_widget_upgrades` filtered to the catalogue row the
 *  patient has resolved to via their axis pins. Returns null while
 *  the inputs are incomplete (no service / no required axes pinned
 *  yet) so the consumer can decide whether to render an upgrades
 *  step at all. */
export function useWidgetUpgrades(input: {
  serviceType: string | null;
  productKey: string | null;
  repairVariant: string | null;
}): UpgradeReadResult {
  const [data, setData] = useState<WidgetUpgrade[] | null>(null);
  const [loading, setLoading] = useState(false);
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
    (async () => {
      let q = supabase
        .from('lng_widget_upgrades')
        .select('id, name, description, unit_price, both_arches_price, sort_order')
        .eq('service_type', input.serviceType);
      // Narrow by whichever axis dimension applies. is-null comparison
      // for the other axis: the same upgrade row is keyed on EITHER
      // product_key OR repair_variant, never both.
      if (input.productKey) {
        q = q.eq('product_key', input.productKey);
      } else {
        q = q.is('product_key', null);
      }
      if (input.repairVariant) {
        q = q.eq('repair_variant', input.repairVariant);
      } else {
        q = q.is('repair_variant', null);
      }
      const { data: rows, error: err } = await q.order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setData(null);
        setLoading(false);
        return;
      }
      const shaped: WidgetUpgrade[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        name: (r.name as string) ?? '',
        description: (r.description as string) ?? '',
        unitPricePence: Math.round(Number(r.unit_price) * 100),
        bothArchesPricePence:
          r.both_arches_price === null ? null : Math.round(Number(r.both_arches_price) * 100),
      }));
      setData(shaped);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [input.serviceType, input.productKey, input.repairVariant]);

  return { data, loading, error };
}
