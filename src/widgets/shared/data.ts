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
  /** Deposit captured at booking time, in pence. > 0 surfaces a "Pay
   *  deposit £X" CTA on the details summary footer; 0 hides it. The
   *  same value also drives the FooterPrice TODAY/ON THE DAY split.
   *  Sourced from lng_booking_type_config.widget_deposit_pence. */
  depositPence: number;
  /** When TRUE the details footer surfaces a "Pay in full" CTA. Set
   *  per booking type in the Lounge admin Widget tab. Defaults to
   *  TRUE — historically every service offered the option. Turning
   *  it off lets a clinic restrict a service to deposit-only or
   *  on-the-day-only flows. */
  allowPayInFull: boolean;
  /** When TRUE the details footer surfaces a "Pay on the day" CTA in
   *  addition to (or instead of) the deposit / pay-in-full pair. Set
   *  per booking type in the Lounge admin Widget tab. Mirrored from
   *  lng_booking_type_config.widget_allow_pay_on_the_day. Defaults to
   *  FALSE — services like click-in veneers and same-day appliance
   *  require a deposit and don't expose this option. Denture-repair
   *  has it on. */
  allowPayOnTheDay: boolean;
  /** When TRUE the booking widget hides the running-total pill from
   *  the sticky footer on every step before Review. Mirrored from
   *  lng_booking_type_config.widget_hide_running_total. Defaults to
   *  TRUE — Dylan prefers the price stay out of sight until the
   *  customer reaches the Review summary screen so they don't anchor
   *  on a partial total while still picking arches / repairs /
   *  upgrades. Admin can flip it off per booking type if a service
   *  benefits from the running total. */
  hideRunningTotal: boolean;
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

/** One row from lwo_catalogue filtered to service_type='denture_repair'
 *  and ready for the cart-style repair builder. Carries every field
 *  the builder needs to render a tile + resolve a line price without
 *  another round-trip. */
export interface RepairCatalogueRow {
  id: string;
  /** Stable internal code, e.g. 'den_snapped'. Used for client-side
   *  identity (React keys, log lines). Not what downstream queries
   *  filter on — see repairVariant below. */
  code: string;
  /** lwo_catalogue.repair_variant — the value the slot RPC, the
   *  catalogue resolver and the upgrades query all filter on
   *  (e.g. "Snapped denture", "Broken tooth", "Relining"). Mirror
   *  this into axes.repair_variant when a cart line is added so
   *  the existing single-row plumbing keeps resolving. */
  repairVariant: string;
  name: string;
  description: string | null;
  unitPricePence: number;
  /** Tiered "first one £X, each extra £Y" price. Null for flat-rate
   *  rows. None of the current repair rows use this, but the column
   *  exists so the builder honours it from day one. */
  extraUnitPricePence: number | null;
  /** Override price when arch='both' on per-arch repairs (Reline:
   *  £160 per arch, £320 both). Null when not applicable. */
  bothArchesPricePence: number | null;
  /** 'per tooth' | 'per arch' | null. Drives the cart copy and the
   *  quantity-stepper visibility on the slide-up sheet. */
  unitLabel: string | null;
  /** True when the catalogue allows the patient to choose how many.
   *  Per-tooth rows always have this set; per-arch rows currently
   *  do too, though we don't surface a stepper for them (1 = one
   *  repair on the chosen arch). */
  quantityEnabled: boolean;
  sortOrder: number | null;
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
import { supabase } from '../../lib/supabase.ts';

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
        .select('id, service_type, label, description, deposit_pence, allow_pay_in_full, allow_pay_on_the_day, hide_running_total, duration_minutes')
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
        // Defaults: pay-in-full TRUE (historical default), OTD FALSE
        // (legacy deposit-only behaviour). Both can be toggled in
        // Lounge admin → Widget per booking type.
        allowPayInFull: (r.allow_pay_in_full as boolean) ?? true,
        allowPayOnTheDay: (r.allow_pay_on_the_day as boolean) ?? false,
        hideRunningTotal: (r.hide_running_total as boolean) ?? true,
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
 *  booking-type duration. Kept on a stub generator for the
 *  optimistic banner placement before live data arrives — the live
 *  hook below replaces this once the patient's axes resolve.
 *
 *  Filters out slots in the past before counting a day's openings,
 *  so a load at 7pm on a 9am–6pm clinic skips today entirely and
 *  returns tomorrow's first slot. Without this filter, the
 *  generator returned today's 9am even though that slot was hours
 *  past, and the calendar landed on today with the slot list
 *  empty — confusing UX for the customer. */
export function firstAvailable(
  durationMinutes: number,
  from: Date = new Date(),
): { date: Date; slot: WidgetSlot } | null {
  const nowMs = Date.now();
  for (let i = 0; i < 60; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const slots = generateSlots(d, durationMinutes).filter(
      (s) => new Date(s.iso).getTime() > nowMs,
    );
    if (slots.length > 0) return { date: d, slot: slots[0]! };
  }
  return null;
}

interface FirstAvailableInput {
  locationId: string | null;
  serviceType: string | null;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
}

interface FirstAvailableResult {
  data: { date: Date; slot: WidgetSlot } | null;
  loading: boolean;
  error: string | null;
}

/** Live first-available read. Calls public.lng_widget_first_available
 *  which scans up to 60 days forward server-side, calling the
 *  conflict check per candidate. Returns null while the inputs are
 *  incomplete; the consumer falls back to the stub from
 *  firstAvailable() so the banner has *something* to show
 *  optimistically before the live data arrives. */
export function useWidgetFirstAvailable(input: FirstAvailableInput): FirstAvailableResult {
  const [data, setData] = useState<{ date: Date; slot: WidgetSlot } | null>(null);
  // Initial loading=true matters: consumers like SlotPicker's
  // init-pin effect distinguish "hook hasn't fetched yet" from
  // "hook resolved with no result" by checking `loading`. If we
  // initialised with loading=false the very first render would
  // expose (loading=false, data=null) to the consumer BEFORE the
  // hook's own useEffect could kick off the fetch — the consumer
  // would treat that as "no live availability" and fall back to a
  // stub date, then ignore the real May-18 result when it arrived
  // because by then selectedDate was already set. Starting at true
  // and only flipping to false after the fetch completes guarantees
  // consumers see a clean loading→resolved transition.
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
    (async () => {
      const realLocationId = UUID_RE.test(input.locationId ?? '') ? input.locationId : null;
      const { data: rows, error: err } = await supabase.rpc('lng_widget_first_available', {
        p_location_id: realLocationId,
        p_service_type: input.serviceType,
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
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      if (!row || typeof (row as { start_at?: string }).start_at !== 'string') {
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      const startAtIso = (row as { start_at: string }).start_at;
      setData({
        date: new Date(startAtIso),
        slot: slotFromIso(startAtIso),
      });
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [input.locationId, input.serviceType, input.repairVariant, input.productKey, input.arch]);

  return { data, loading, error };
}

/** Closed-day check used by the calendar grid to dim un-bookable
 *  dates without firing one availability RPC per cell. The clinic
 *  is closed on Sundays — the rest of the dimming (no free slots
 *  for this duration on a given day) reads from the live RPC once
 *  the patient picks a date. */
// Removed — was hardcoded to "Sundays closed" and ignored the
// admin-configured clinic.opening_hours. SlotPicker now reads the
// live opening_hours via useClinicSettings and uses an inline
// isClinicClosedOn() helper. Single source of truth.

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
  /** Every repair_variant in the cart. Only populated for
   *  denture_repair bookings — the server uses it to resolve the
   *  most restrictive variant in the cart (e.g. Relining when the
   *  cart mixes Cracked + Relining) so slot availability reflects
   *  every variant's pool claims, not just the first cart line's.
   *  Empty / undefined for single-variant flows. */
  repairVariants?: string[] | null;
  // When set the RPC excludes this appointment from its conflict
  // count. The widget's reschedule flow passes the patient's
  // current appointment id so their existing slot still shows as
  // available (it doesn't conflict with itself). Omit for the new-
  // booking flow.
  excludeAppointmentId?: string | null;
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
        p_exclude_appointment_id: input.excludeAppointmentId ?? null,
        // Cart-aware variant pick — the server uses this to find the
        // most restrictive variant in a denture_repair cart so a
        // booking that includes Relining alongside Cracked / Add-a-
        // tooth still respects Relining's impression-clinician +
        // consult-room pool claims. Empty / null for non-denture
        // bookings; the RPC silently ignores it.
        p_repair_variants: input.repairVariants ?? null,
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
    input.excludeAppointmentId,
    // Stable key for the cart — without this dependency, ticking /
    // unticking repair lines mid-flow doesn't refetch availability,
    // so the patient can see slots that became invalid the moment
    // they added Relining to the cart. Sort-then-join makes the
    // key order-independent and array-reference-stable so we don't
    // refetch on every render when the underlying array literal is
    // fresh but the contents haven't changed.
    (input.repairVariants ?? []).slice().sort().join('|'),
  ]);

  return { data, loading, error };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toIsoDate(d: Date): string {
  // Local-date YYYY-MM-DD — matches what the RPC's `date` parameter
  // expects when treated as Europe/London civil time.
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live "which dates have any availability" scan
// ─────────────────────────────────────────────────────────────────────────────
//
// Powers the calendar grid's per-day enabled state. Calls
// public.lng_widget_available_dates which loops the same slot
// scanner used by the slot list (so the same past-time filter,
// conflict check, lunch-break skip, and post-block extent rules
// apply). The result is a set of YYYY-MM-DD strings — the
// calendar treats anything NOT in the set as "no slots, can't
// click".

interface AvailableDatesInput {
  locationId: string | null;
  serviceType: string | null;
  repairVariant: string | null;
  productKey: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  /** Inclusive window start (local YYYY-MM-DD). The RPC caps the
   *  range at 60 days; pass the visible calendar's first cell. */
  fromDate: Date | null;
  /** Inclusive window end. Pass the visible calendar's last cell. */
  toDate: Date | null;
}

interface AvailableDatesResult {
  /** Set of YYYY-MM-DD strings the calendar can enable as
   *  clickable. Empty Set while loading or when nothing in the
   *  window is bookable. */
  dates: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
}

export function useWidgetAvailableDates(
  input: AvailableDatesInput,
): AvailableDatesResult {
  const [dates, setDates] = useState<ReadonlySet<string>>(EMPTY_DATE_SET);
  // Same initial-loading-true rationale as useWidgetFirstAvailable
  // (see comment there). Consumers distinguish "we haven't asked
  // yet" from "we asked and got nothing back" by the loading flag.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fromKey = input.fromDate ? toIsoDate(input.fromDate) : null;
  const toKey = input.toDate ? toIsoDate(input.toDate) : null;

  useEffect(() => {
    if (!input.serviceType || !fromKey || !toKey) {
      setDates(EMPTY_DATE_SET);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
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
          p_from: fromKey,
          p_to: toKey,
        },
      );
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const set = new Set<string>();
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const d = (r as { date?: string }).date;
          if (typeof d === 'string') set.add(d);
        }
      }
      setDates(set);
      setError(null);
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
    fromKey,
    toKey,
  ]);

  return { dates, loading, error };
}

const EMPTY_DATE_SET: ReadonlySet<string> = new Set();

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
      // Resolve the catalogue row that drives the customer-facing
      // price. We filter on whichever axes the customer has pinned;
      // we do NOT impose `IS NULL` on the unpinned axes. The earlier
      // implementation tightened on `IS NULL` and missed services
      // like Click-in veneers whose single catalogue row has a
      // non-null product_key matching the service name. Result: no
      // service-line price → no "On the day" pill.
      //
      // limit(1) keeps the result single-row even when the filter
      // would otherwise return several (eg. same_day_appliance with
      // no product pinned). Once axes are pinned at booking time
      // this is always a single row in practice.
      let q = supabase
        .from('lwo_catalogue')
        .select('id, name, unit_price, both_arches_price, arch_match')
        .eq('service_type', input.serviceType)
        .eq('active', true);
      if (input.productKey) q = q.eq('product_key', input.productKey);
      if (input.repairVariant) q = q.eq('repair_variant', input.repairVariant);
      const { data: rows, error: err } = await q.limit(1);
      const row = rows && rows.length > 0 ? rows[0] : null;
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
// Denture-repair catalogue (all rows for the cart builder)
// ─────────────────────────────────────────────────────────────────────────────
//
// The repair step lets the patient build a multi-line cart, so it
// needs every repair row up-front rather than the single-row
// resolver above. Filters mirror lng_widget_booking_types' anon
// SELECT contract: active + widget_visible.

interface RepairCatalogueResult {
  data: RepairCatalogueRow[] | null;
  loading: boolean;
  error: string | null;
}

/** Reads every active, widget-visible denture-repair row from
 *  lwo_catalogue. Single-fire on mount — the catalogue doesn't change
 *  inside one booking session, and a refresh on next open picks up
 *  any catalogue edit. */
export function useRepairCatalogueRows(): RepairCatalogueResult {
  const [data, setData] = useState<RepairCatalogueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lwo_catalogue')
        .select(
          'id, code, repair_variant, name, description, unit_price, extra_unit_price, both_arches_price, unit_label, quantity_enabled, sort_order',
        )
        .eq('service_type', 'denture_repair')
        .eq('active', true)
        .eq('widget_visible', true)
        .not('repair_variant', 'is', null)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setData(null);
        setLoading(false);
        return;
      }
      const shaped: RepairCatalogueRow[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        code: (r.code as string) ?? '',
        repairVariant: (r.repair_variant as string) ?? '',
        name: (r.name as string) ?? '',
        description: (r.description as string | null) ?? null,
        unitPricePence: Math.round(Number(r.unit_price) * 100),
        extraUnitPricePence:
          r.extra_unit_price === null
            ? null
            : Math.round(Number(r.extra_unit_price) * 100),
        bothArchesPricePence:
          r.both_arches_price === null
            ? null
            : Math.round(Number(r.both_arches_price) * 100),
        unitLabel: (r.unit_label as string | null) ?? null,
        quantityEnabled: Boolean(r.quantity_enabled),
        sortOrder: (r.sort_order as number | null) ?? null,
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
