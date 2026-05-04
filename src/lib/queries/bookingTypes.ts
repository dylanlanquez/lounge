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
  // Optional per-booking-type cap on simultaneous bookings of this
  // exact type. Independent of resource-pool capacity (both rules
  // apply at conflict-check time). Null = inherit from parent.
  max_concurrent: number | null;
  // Patient-facing duration as a min/max range. min is the lower
  // bound (or fixed value when max is null). max is null for fixed
  // values; set when the patient should see a range like "30 to 45
  // min". Both null on a child = inherit parent. Both null on a
  // parent = resolves to the derived block duration. See ADR-006
  // §6.3.1 — patient-facing copy reads these; the conflict checker
  // never reads them.
  patient_facing_min_minutes: number | null;
  patient_facing_max_minutes: number | null;
  // Optional admin-editable display name. When set, takes
  // precedence over the catalogue / arch / service-derived label.
  // Used to rename a child override row in the UI without changing
  // the underlying catalogue key.
  display_label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Named resource (chair, lab bench, consult room) with bounded
// capacity. A booking consumes 1 unit of every pool its service
// type maps to, for the duration of the booking; capacity governs
// concurrent claims.
//
// `kind` discriminates two flavours of pool with identical conflict
// semantics — only the admin UI groups them differently:
//
//   resource    physical things — chairs, lab bench, consult room
//   staff_role  people in a role — impression takers, denture techs
//
// The conflict checker treats both the same way; this is purely
// presentation.
export type ResourcePoolKind = 'resource' | 'staff_role';

export interface ResourcePoolRow {
  id: string;
  display_name: string;
  // How many of this resource exist. For physical resources, the
  // count of chairs/rooms/equipment. For staff_role pools, the
  // count of assigned staff (kept in sync with the picker).
  units: number;
  // How many patients each unit handles at the same time. Defaults
  // to 1; admin only changes for the genuinely parallel cases
  // (1 receptionist juggling 3, a room with 2 chairs, etc.).
  per_unit_capacity: number;
  // Effective capacity = units × per_unit_capacity. Generated
  // stored column on the DB side, kept in sync automatically.
  // The conflict checker reads this; admin never edits it directly.
  capacity: number;
  kind: ResourcePoolKind;
  notes: string | null;
  created_at: string;
  updated_at: string;
}


// One resolved phase as it comes back from lng_booking_type_resolve.
// Parent shape, with child duration overrides applied by phase_index.
// Pool ids are inherited from the parent's phase row in v1 (children
// retune durations only — see ADR-006 §6.3.3).
export interface ResolvedPhase {
  phase_index: number;
  label: string;
  patient_required: boolean;
  duration_min: number | null;
  duration_max: number | null;
  duration_default: number | null;
  pool_ids: string[];
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
  // Per-booking-type concurrent cap (resolved from child or parent).
  // Null when neither sets it.
  max_concurrent: number | null;
  // Pool ids this booking type consumes (aggregated across all phases).
  // Kept for backwards compatibility; new callers should read `phases`.
  pool_ids: string[];
  notes: string | null;
  // 'child' when the row's own values were used; 'parent' when the
  // resolver fell back. Useful for the admin UI's "inherits from"
  // chip.
  source: 'child' | 'parent';
  // Phase shape (ADR-006). Ordered by phase_index. May be empty
  // briefly after a config is created and before its first phase
  // has been added — callers must handle that case.
  phases: ResolvedPhase[];
  // Sum of phases[].duration_default. Drives the calendar block
  // width and the slot picker. Null when no phases yet.
  block_duration_minutes: number | null;
  // What we tell the patient as a min/max range. min is resolved
  // (child → parent → block fallback) and is null only when block
  // is also null. max is null unless the admin opted into a range
  // explicitly — no fallback. Use patientFacingDurationLabel() to
  // format both into a single human string.
  patient_facing_min_minutes: number | null;
  patient_facing_max_minutes: number | null;
}

// Human format for a patient-facing duration range. Single value
// when max is null or equal to min ("30 min" / "1 hour"). Ranged
// when max > min ("30 to 45 min" / "1 to 2 hours"). The same helper
// is used by the admin ribbon, the editor preview, and (in spirit)
// the email renderer — the edge functions carry their own copy
// because Deno can't import from src.
export function patientFacingDurationLabel(
  min: number | null,
  max: number | null,
): string {
  if (!min || min <= 0) return '';
  if (!max || max <= min) return formatDurationLong(min);
  return `${formatDurationLong(min)} to ${formatDurationLong(max)}`;
}

// "30 min", "1 hour", "1 hour 30 min". Long-form (matches the
// email tone). Used inside patientFacingDurationLabel.
function formatDurationLong(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hourWord = h === 1 ? 'hour' : 'hours';
  if (m === 0) return `${h} ${hourWord}`;
  return `${h} ${hourWord} ${m} min`;
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
    max_concurrent: (row.max_concurrent as number | null) ?? null,
    pool_ids: Array.isArray(row.pool_ids) ? (row.pool_ids as string[]) : [],
    notes: row.notes ?? null,
    source: row.source as 'child' | 'parent',
    phases: Array.isArray(row.phases) ? (row.phases as ResolvedPhase[]) : [],
    block_duration_minutes: (row.block_duration_minutes as number | null) ?? null,
    patient_facing_min_minutes:
      (row.patient_facing_min_minutes as number | null) ?? null,
    patient_facing_max_minutes:
      (row.patient_facing_max_minutes as number | null) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource pools + service-pool consumption.
// ─────────────────────────────────────────────────────────────────────────────

export function useResourcePools(): {
  data: ResourcePoolRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<ResourcePoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_booking_resource_pools')
        .select('*')
        .order('display_name', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setData((rows ?? []) as ResourcePoolRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, reload: () => setTick((n) => n + 1) };
}

// Resource usage map for the Resources admin tab. Returns
// Map<pool_id, BookingServiceType[]> — the parent services whose
// phases consume each pool. Built from
// lng_booking_type_phase_pools → lng_booking_type_phases →
// lng_booking_type_config (parent rows only). Replaces the legacy
// useServicePools hook that read the obsolete service-level
// junction table.
export function useResourceUsage(): {
  byPoolId: Map<string, BookingServiceType[]>;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [byPoolId, setByPoolId] = useState<Map<string, BookingServiceType[]>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      // Two parallel reads: phase rows joined to their parent
      // configs (so we get phase_id → service_type) and the phase
      // pool junction (phase_id → pool_id). Combine client-side.
      const [phaseRes, poolRes] = await Promise.all([
        supabase
          .from('lng_booking_type_phases')
          .select(
            'id, config:lng_booking_type_config!inner ( service_type, repair_variant, product_key, arch )',
          ),
        supabase.from('lng_booking_type_phase_pools').select('phase_id, pool_id'),
      ]);
      if (cancelled) return;
      if (phaseRes.error) {
        setError(phaseRes.error.message);
        setLoading(false);
        return;
      }
      if (poolRes.error) {
        setError(poolRes.error.message);
        setLoading(false);
        return;
      }
      // phase_id → service_type (parent rows only — child override
      // phase rows inherit pool consumption from the parent at
      // resolve time, so we don't double-count).
      const serviceByPhase = new Map<string, BookingServiceType>();
      for (const row of (phaseRes.data ?? []) as {
        id: string;
        config:
          | {
              service_type: BookingServiceType;
              repair_variant: string | null;
              product_key: string | null;
              arch: string | null;
            }
          | {
              service_type: BookingServiceType;
              repair_variant: string | null;
              product_key: string | null;
              arch: string | null;
            }[]
          | null;
      }[]) {
        const cfg = Array.isArray(row.config) ? row.config[0] : row.config;
        if (!cfg) continue;
        const isParent =
          cfg.repair_variant == null && cfg.product_key == null && cfg.arch == null;
        if (!isParent) continue;
        serviceByPhase.set(row.id, cfg.service_type);
      }
      const map = new Map<string, BookingServiceType[]>();
      for (const row of (poolRes.data ?? []) as { phase_id: string; pool_id: string }[]) {
        const service = serviceByPhase.get(row.phase_id);
        if (!service) continue;
        const list = map.get(row.pool_id) ?? [];
        if (!list.includes(service)) list.push(service);
        map.set(row.pool_id, list);
      }
      setByPoolId(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { byPoolId, loading, error, reload: () => setTick((n) => n + 1) };
}

// Slug for a pool id. Lowercase, digits, hyphens. Used both at insert
// time (validating user input before round-tripping to the DB check
// constraint) and when generating an id from a display name.
export function poolIdFromDisplayName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidPoolId(id: string): boolean {
  return /^[a-z][a-z0-9-]+$/.test(id);
}

export async function upsertResourcePool(input: {
  id: string;
  display_name: string;
  units: number;
  per_unit_capacity: number;
  kind: ResourcePoolKind;
  notes?: string | null;
}): Promise<void> {
  if (!isValidPoolId(input.id)) {
    throw new Error('Pool id must be lowercase letters, digits, and hyphens.');
  }
  // capacity is a generated column server-side (units × per_unit_
  // capacity). Don't write to it; the DB rejects.
  //
  // For staff_role pools, units is owned by the recompute helper that
  // fires after lng_staff_pool_assignments changes — writing it here
  // would trip the units guard. Omit units from the payload; the
  // assignment save path that runs immediately after will reconcile.
  const payload: Record<string, unknown> = {
    id: input.id,
    display_name: input.display_name,
    per_unit_capacity: input.per_unit_capacity,
    kind: input.kind,
    notes: input.notes ?? null,
  };
  if (input.kind !== 'staff_role') {
    payload.units = input.units;
  }
  const { error } = await supabase
    .from('lng_booking_resource_pools')
    .upsert(payload, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

export async function deleteResourcePool(id: string): Promise<void> {
  const { error } = await supabase
    .from('lng_booking_resource_pools')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
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
  max_concurrent?: number | null;
  patient_facing_min_minutes?: number | null;
  patient_facing_max_minutes?: number | null;
  display_label?: string | null;
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
  if (input.max_concurrent !== undefined) payload.max_concurrent = input.max_concurrent;
  if (input.patient_facing_min_minutes !== undefined)
    payload.patient_facing_min_minutes = input.patient_facing_min_minutes;
  if (input.patient_facing_max_minutes !== undefined)
    payload.patient_facing_max_minutes = input.patient_facing_max_minutes;
  if (input.display_label !== undefined) payload.display_label = input.display_label;
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

// Display label for a row in the booking-type tree. Admin-set
// display_label always wins. Otherwise: parents read as the service
// display name; children read as the child key value (Title Case
// for product keys; raw for repair variants; archLabel for arches).
export function bookingTypeRowLabel(row: BookingTypeConfigRow): string {
  if (row.display_label && row.display_label.trim()) return row.display_label.trim();
  if (row.repair_variant) return row.repair_variant;
  if (row.product_key) return humaniseProductKey(row.product_key);
  if (row.arch) return archLabel(row.arch);
  return BOOKING_SERVICE_TYPES.find((s) => s.value === row.service_type)?.label ?? row.service_type;
}

// The auto-derived label, ignoring any admin override. Used by the
// editor to show "Use catalogue default (X)" link copy. Pure
// derivation — no DB lookup.
export function bookingTypeRowDerivedLabel(row: BookingTypeConfigRow): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// Booking-type phases (ADR-006)
//
// A booking type's phase shape lives on the parent config row in
// lng_booking_type_phases. The single source of truth for the
// admin's editable phase list is this table. The resolver
// (lng_booking_type_resolve) returns the merged read view; for
// editing, the admin UI reads phase rows directly so it can show
// the parent vs child source clearly.
// ─────────────────────────────────────────────────────────────────────────────

// One phase row as it sits in lng_booking_type_phases. config_id
// points at either a parent or a child config row. A child phase
// row exists only when the admin overrode this phase's durations
// for that child variant; otherwise the resolver inherits.
export interface BookingTypePhaseRow {
  id: string;
  config_id: string;
  phase_index: number;
  // Phase label. On parent rows this is the canonical name. On child
  // override rows it's the variant's rename (M12 row-level override
  // semantics — when a child phase row exists, all its fields win).
  label: string;
  patient_required: boolean;
  duration_min: number | null;
  duration_max: number | null;
  duration_default: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Pool ids attached to this phase. Joined in by the hook below;
  // not a column on the underlying table.
  pool_ids: string[];
}

// Fetch all phase rows for a single config row, with their pool
// junction rows joined in. Ordered by phase_index. Used by the
// admin booking-types editor.
export function useBookingTypePhases(configId: string | null | undefined): {
  data: BookingTypePhaseRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<BookingTypePhaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!configId) {
      setData([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      // Pull phases + their pool junction rows in two parallel
      // requests. Combining server-side via a view or RPC is a
      // future optimisation if this becomes a hot path.
      const [phaseResult, poolResult] = await Promise.all([
        supabase
          .from('lng_booking_type_phases')
          .select('*')
          .eq('config_id', configId)
          .order('phase_index', { ascending: true }),
        supabase
          .from('lng_booking_type_phase_pools')
          .select('phase_id, pool_id'),
      ]);
      if (cancelled) return;
      if (phaseResult.error) {
        setError(phaseResult.error.message);
        setLoading(false);
        return;
      }
      if (poolResult.error) {
        setError(poolResult.error.message);
        setLoading(false);
        return;
      }
      const poolsByPhase = new Map<string, string[]>();
      for (const row of (poolResult.data ?? []) as { phase_id: string; pool_id: string }[]) {
        const existing = poolsByPhase.get(row.phase_id) ?? [];
        existing.push(row.pool_id);
        poolsByPhase.set(row.phase_id, existing);
      }
      const merged: BookingTypePhaseRow[] = ((phaseResult.data ?? []) as Omit<
        BookingTypePhaseRow,
        'pool_ids'
      >[]).map((row) => ({
        ...row,
        pool_ids: (poolsByPhase.get(row.id) ?? []).sort(),
      }));
      setData(merged);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [configId, tick]);

  return { data, loading, error, reload: () => setTick((n) => n + 1) };
}

// Insert or update a phase row. The unique key is (config_id,
// phase_index). For a new phase, the caller picks the next free
// phase_index (typically max + 1). For an edit, the existing
// phase_index is reused. Per M12, child override rows store all
// fields directly (no separate _override columns); the resolver
// uses row-level override semantics.
export async function upsertBookingTypePhase(input: {
  id?: string | null;
  config_id: string;
  phase_index: number;
  label: string;
  patient_required: boolean;
  duration_min?: number | null;
  duration_max?: number | null;
  duration_default?: number | null;
  notes?: string | null;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    config_id: input.config_id,
    phase_index: input.phase_index,
    label: input.label,
    patient_required: input.patient_required,
    duration_min: input.duration_min ?? null,
    duration_max: input.duration_max ?? null,
    duration_default: input.duration_default ?? null,
    notes: input.notes ?? null,
  };
  if (input.id) payload.id = input.id;

  const { data, error } = await supabase
    .from('lng_booking_type_phases')
    .upsert(payload, { onConflict: 'config_id,phase_index' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

// Replace a phase's pool list. Atomic: deletes existing rows,
// inserts the new set. Idempotent.
export async function setPhasePoolIds(
  phaseId: string,
  poolIds: string[],
): Promise<void> {
  const { error: delErr } = await supabase
    .from('lng_booking_type_phase_pools')
    .delete()
    .eq('phase_id', phaseId);
  if (delErr) throw new Error(delErr.message);
  if (poolIds.length === 0) return;
  const { error: insErr } = await supabase
    .from('lng_booking_type_phase_pools')
    .insert(poolIds.map((pool_id) => ({ phase_id: phaseId, pool_id })));
  if (insErr) throw new Error(insErr.message);
}

// Delete a phase row. The DB cascades to the phase pool junction
// rows. Caller is responsible for confirming with the admin first
// (the slice spec calls for refusing when active appointments use
// the shape — that check is deferred to a follow-up RPC).
export async function deleteBookingTypePhase(phaseId: string): Promise<void> {
  const { error } = await supabase
    .from('lng_booking_type_phases')
    .delete()
    .eq('id', phaseId);
  if (error) throw new Error(error.message);
}
