import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Booking-type config — the per-service / per-variant scheduling
// rules that drive the reschedule slot picker, the conflict checker,
// and (eventually) the new-booking flow.
//
// Schema-side notes are in the migration header
// (20260501000003_lng_booking_type_config.sql). Two tiers in one
// table: parent rows (service_type only) hold the fallback config;
// child rows (service_type + exactly one of repair_variant /
// product_key / arch) override individual fields, with each null
// field falling back to the parent at resolve time.
//
// The DB function `lng_booking_type_resolve` does the merge — call
// it whenever you want the *effective* config for a given booking
// type rather than reading rows raw.

export type BookingServiceType =
  | 'denture_repair'
  | 'click_in_veneers'
  | 'same_day_appliance'
  | 'impression_appointment'
  | 'other';

export const BOOKING_SERVICE_TYPES: { value: BookingServiceType; label: string }[] = [
  { value: 'denture_repair', label: 'Denture repair' },
  { value: 'click_in_veneers', label: 'Click-in veneers' },
  { value: 'same_day_appliance', label: 'Same-day appliance' },
  { value: 'impression_appointment', label: 'Impression appointment' },
  { value: 'other', label: 'Other' },
];

// Days run Mon-Sun in the JSONB. Tuple form so iteration order is
// fixed and we don't depend on Object.keys() preserving insertion.
export const DAYS_OF_WEEK: readonly DayOfWeek[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

// One day's hours. null = closed.
export interface DayHours {
  open: string;  // 'HH:MM' 24-hour
  close: string; // 'HH:MM' 24-hour
}

// Working hours for the whole week. Each day is either DayHours
// (open) or null (closed). The whole object can also be null on a
// child row, meaning "inherit the parent's hours wholesale".
export type WorkingHours = Partial<Record<DayOfWeek, DayHours | null>>;

// A row as it sits in the DB. Most fields nullable because of the
// inheritance model.
export interface BookingTypeConfigRow {
  id: string;
  service_type: BookingServiceType;
  // Exactly one of these is non-null on a child row; all three are
  // null on a parent row.
  repair_variant: string | null;
  product_key: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  working_hours: WorkingHours | null;
  duration_min: number | null;
  duration_max: number | null;
  duration_default: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Effective config for a specific booking type, with parent-fallback
// merged in. Returned by `lng_booking_type_resolve`. All scheduling
// fields are guaranteed non-null when a parent row exists for the
// service — which the seed migration ensures for every recognised
// service_type.
export interface ResolvedBookingTypeConfig {
  service_type: BookingServiceType;
  repair_variant: string | null;
  product_key: string | null;
  arch: 'upper' | 'lower' | 'both' | null;
  working_hours: WorkingHours;
  duration_min: number;
  duration_max: number;
  duration_default: number;
  notes: string | null;
  // 'child' when the row's own values were used; 'parent' when the
  // resolver fell back. Useful for the admin UI's "inherits from"
  // chip.
  source: 'child' | 'parent';
}

// Fetch every config row in one shot. Used by the admin Booking
// Types page to render the tree (parent + children grouped by
// service).
export function useBookingTypeConfigs(): {
  data: BookingTypeConfigRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<BookingTypeConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_booking_type_config')
        .select('*')
        .order('service_type', { ascending: true })
        .order('repair_variant', { ascending: true, nullsFirst: true })
        .order('product_key', { ascending: true, nullsFirst: true })
        .order('arch', { ascending: true, nullsFirst: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as BookingTypeConfigRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, reload: () => setTick((n) => n + 1) };
}

// Resolve the effective config for a specific booking type via the
// SQL function. Call from the reschedule slot picker.
export async function resolveBookingTypeConfig(args: {
  service_type: BookingServiceType;
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
}): Promise<ResolvedBookingTypeConfig | null> {
  const { data, error } = await supabase.rpc('lng_booking_type_resolve', {
    p_service_type: args.service_type,
    p_repair_variant: args.repair_variant ?? null,
    p_product_key: args.product_key ?? null,
    p_arch: args.arch ?? null,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  return {
    service_type: row.service_type as BookingServiceType,
    repair_variant: row.repair_variant ?? null,
    product_key: row.product_key ?? null,
    arch: (row.arch as 'upper' | 'lower' | 'both' | null) ?? null,
    working_hours: (row.working_hours ?? {}) as WorkingHours,
    duration_min: row.duration_min as number,
    duration_max: row.duration_max as number,
    duration_default: row.duration_default as number,
    notes: row.notes ?? null,
    source: row.source as 'child' | 'parent',
  };
}

// Admin write — upsert a full config row. The unique key for an
// upsert is (service_type, repair_variant, product_key, arch).
//
// Pass null for any duration / working_hours field to clear the
// override (the row will then inherit from the parent at resolve
// time). Pass an object for working_hours to set it; pass null to
// inherit.
export async function upsertBookingTypeConfig(input: {
  service_type: BookingServiceType;
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
  working_hours?: WorkingHours | null;
  duration_min?: number | null;
  duration_max?: number | null;
  duration_default?: number | null;
  notes?: string | null;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    service_type: input.service_type,
    repair_variant: input.repair_variant ?? null,
    product_key: input.product_key ?? null,
    arch: input.arch ?? null,
  };
  // Only include scheduling fields if explicitly provided so the
  // upsert doesn't overwrite an existing override with null.
  if (input.working_hours !== undefined) payload.working_hours = input.working_hours;
  if (input.duration_min !== undefined) payload.duration_min = input.duration_min;
  if (input.duration_max !== undefined) payload.duration_max = input.duration_max;
  if (input.duration_default !== undefined) payload.duration_default = input.duration_default;
  if (input.notes !== undefined) payload.notes = input.notes;

  const { error } = await supabase
    .from('lng_booking_type_config')
    .upsert(payload, { onConflict: 'service_type,repair_variant,product_key,arch' });
  if (error) throw new Error(error.message);
}

// Delete a child override row. Parent rows shouldn't be deleted —
// the system depends on a parent existing for each recognised
// service. The query is filtered to child rows only as a safety
// belt: if all three child keys are null we refuse.
export async function deleteBookingTypeChildOverride(args: {
  service_type: BookingServiceType;
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: 'upper' | 'lower' | 'both' | null;
}): Promise<void> {
  const hasChildKey =
    !!args.repair_variant || !!args.product_key || !!args.arch;
  if (!hasChildKey) {
    throw new Error('Refusing to delete a parent booking type config row.');
  }
  let q = supabase
    .from('lng_booking_type_config')
    .delete()
    .eq('service_type', args.service_type);
  q = args.repair_variant
    ? q.eq('repair_variant', args.repair_variant)
    : q.is('repair_variant', null);
  q = args.product_key
    ? q.eq('product_key', args.product_key)
    : q.is('product_key', null);
  q = args.arch ? q.eq('arch', args.arch) : q.is('arch', null);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

// Display label for a row in the booking-type tree. Parents read as
// the service display name; children read as the child key value
// (Title Case for product keys; raw for repair variants which
// already come through human-friendly).
export function bookingTypeRowLabel(row: BookingTypeConfigRow): string {
  if (row.repair_variant) return row.repair_variant;
  if (row.product_key) return humaniseProductKey(row.product_key);
  if (row.arch) return archLabel(row.arch);
  return BOOKING_SERVICE_TYPES.find((s) => s.value === row.service_type)?.label ?? row.service_type;
}

function humaniseProductKey(key: string): string {
  return key
    .split('_')
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ');
}

function archLabel(arch: 'upper' | 'lower' | 'both'): string {
  switch (arch) {
    case 'upper':
      return 'Upper arch';
    case 'lower':
      return 'Lower arch';
    case 'both':
      return 'Both arches';
  }
}
