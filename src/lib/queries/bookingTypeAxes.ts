// Per-service axis registry for booking-type overrides. This is the
// code-side source of truth declared in ADR-007 §7.3.1 — it defines
// which dimensions each booking type has, what populates them, and in
// what priority. Everything that used to switch on service_type for
// override semantics (UI add-override flow, list rendering, validation,
// resolver call sites) reads from here instead.
//
// Adding a new dimension to a service is a single-array edit. Adding a
// new service is a single key in SERVICE_AXES. The DB resolver
// (lng_booking_type_resolve, M15) doesn't care about the registry — it
// reads pinned axes off the row directly and walks the chain by
// specificity. The registry's job is to constrain WRITES (which axes
// admins can pin per service, what values are valid) and drive UI.

import { supabase } from '../supabase.ts';
import type { BookingServiceType } from './bookingTypes.ts';

export type AxisKey = 'repair_variant' | 'product_key' | 'arch';
export type ArchValue = 'upper' | 'lower' | 'both';

// Where the valid values for an axis come from. arch_enum is fixed;
// denture_variants and catalogue_for query lwo_catalogue. The
// catalogue_for variant takes an explicit product_keys allow-list so
// each service can scope its product axis differently — virtual
// impression covers a different set of products than in-person
// impression than same-day appliance.
export type AxisSource =
  | { kind: 'arch_enum' }
  | { kind: 'denture_variants' }
  | { kind: 'catalogue_for'; productKeys: readonly string[] };

export interface AxisDef {
  key: AxisKey;
  label: string;        // UI label, e.g. "Product", "Arch"
  source: AxisSource;
}

// SERVICE_AXES — order matters. Earlier axes have HIGHER priority for
// resolver tiebreaks at equal specificity. The DB resolver hard-codes
// the same global priority (variant > product > arch) so client and
// server stay in sync.
//
// Empty array = service supports no overrides. The UI hides the
// add-override button entirely.
export const SERVICE_AXES: Record<BookingServiceType, readonly AxisDef[]> = {
  denture_repair: [
    { key: 'repair_variant', label: 'Repair type', source: { kind: 'denture_variants' } },
  ],
  click_in_veneers: [
    { key: 'arch', label: 'Arch', source: { kind: 'arch_enum' } },
  ],
  // In-person impression appointment will gain a product axis when
  // Dylan provides the canonical product list (different from virtual
  // impression's list — see ADR-007 §7.3.4). For now: arch only.
  impression_appointment: [
    { key: 'arch', label: 'Arch', source: { kind: 'arch_enum' } },
  ],
  same_day_appliance: [
    {
      key: 'product_key',
      label: 'Product',
      source: {
        kind: 'catalogue_for',
        // Every product in lwo_catalogue with service_type =
        // same_day_appliance today. Listed explicitly so a future
        // catalogue addition doesn't silently expose a half-configured
        // product to the override picker.
        productKeys: [
          'retainer',
          'aligner',
          'whitening_tray',
          'whitening_kit',
          'night_guard',
          'day_guard',
          'missing_tooth',
        ],
      },
    },
    { key: 'arch', label: 'Arch', source: { kind: 'arch_enum' } },
  ],
  virtual_impression_appointment: [
    {
      key: 'product_key',
      label: 'Product',
      source: {
        kind: 'catalogue_for',
        // Per Dylan's brief: virtual impression covers retainers,
        // whitening trays, night guards, day guards, click-in veneers,
        // and missing-tooth retainers. Aligners and whitening kits are
        // intentionally excluded — they're handled in person.
        productKeys: [
          'retainer',
          'whitening_tray',
          'night_guard',
          'day_guard',
          'click_in_veneers',
          'missing_tooth',
        ],
      },
    },
    { key: 'arch', label: 'Arch', source: { kind: 'arch_enum' } },
  ],
  other: [],
};

// ── Helpers ──────────────────────────────────────────────────────

export function axesForService(s: BookingServiceType): readonly AxisDef[] {
  return SERVICE_AXES[s] ?? [];
}

export interface AxisPin {
  key: AxisKey;
  value: string;
}

// Reads which axes a given config row pins (non-null axis values).
// Used by list rendering to build the "Whitening Tray · Upper" label
// chain on each override card, and by validation to confirm the row's
// pinned axes match what the service registry declares.
export function axesPinned(row: {
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: string | null;
}): AxisPin[] {
  const out: AxisPin[] = [];
  if (row.repair_variant) out.push({ key: 'repair_variant', value: row.repair_variant });
  if (row.product_key) out.push({ key: 'product_key', value: row.product_key });
  if (row.arch) out.push({ key: 'arch', value: row.arch });
  return out;
}

// True when the row pins zero axes (= the parent / defaults row).
export function isParentRow(row: {
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: string | null;
}): boolean {
  return axesPinned(row).length === 0;
}

// Specificity = how many axes a row pins. Used for sorting an admin's
// override list (most-specific first) and for the "this specific
// override beats less-specific ones" cue.
export function rowSpecificity(row: {
  repair_variant?: string | null;
  product_key?: string | null;
  arch?: string | null;
}): number {
  return axesPinned(row).length;
}

// Display label for a single axis value. Arch values are fixed strings;
// catalogue values resolve to the catalogue row's name when a label
// lookup is provided (otherwise falls back to humanising the slug).
export function axisValueLabel(
  axis: AxisDef,
  value: string,
  catalogueLabels?: Map<string, string>,
): string {
  if (axis.source.kind === 'arch_enum') {
    if (value === 'upper') return 'Upper';
    if (value === 'lower') return 'Lower';
    if (value === 'both') return 'Both';
    return value;
  }
  return catalogueLabels?.get(value) ?? humanise(value);
}

// Renders a chain of pinned axes into a single comma-separated label
// for the override card, e.g. "Whitening Tray · Upper" or "Upper".
// Order follows the service's axis declaration so chains stay
// readable. Falls back to "Default" when nothing is pinned (parent
// rows shouldn't be passed here, but render-safe anyway).
export function pinnedAxesLabel(
  service: BookingServiceType,
  row: {
    repair_variant?: string | null;
    product_key?: string | null;
    arch?: string | null;
  },
  catalogueLabels?: Map<string, string>,
): string {
  const axes = axesForService(service);
  const pins = axesPinned(row);
  if (pins.length === 0) return 'Default';
  const ordered = axes
    .map((a) => {
      const pin = pins.find((p) => p.key === a.key);
      return pin ? axisValueLabel(a, pin.value, catalogueLabels) : null;
    })
    .filter((s): s is string => s !== null);
  return ordered.join(' · ');
}

// ── Loading axis values from the catalogue ───────────────────────

// Catalogue arch_match values: 'single' = the receptionist must pick
// upper/lower/both; 'both' = the row is preset to both; 'any' = the
// product has no arch concept (whitening kits, etc.). Surfaced on
// product-axis options so the new-booking flow can skip the arch
// question for products that don't expose one.
export type CatalogueArchMatch = 'single' | 'both' | 'any';

export interface AxisValueOption {
  key: string;       // the value stored on the row (e.g. 'whitening_tray', 'upper')
  label: string;     // the human label shown in the picker
  // Only set for product-axis options (catalogue_for). NewBookingSheet
  // reads this to decide whether to ask the arch question after the
  // product is picked. undefined for arch / variant axes.
  archMatch?: CatalogueArchMatch;
}

export async function loadAxisValues(axis: AxisDef): Promise<AxisValueOption[]> {
  if (axis.source.kind === 'arch_enum') {
    return [
      { key: 'upper', label: 'Upper arch' },
      { key: 'lower', label: 'Lower arch' },
      { key: 'both', label: 'Both arches' },
    ];
  }
  if (axis.source.kind === 'denture_variants') {
    const { data, error } = await supabase
      .from('lwo_catalogue')
      .select('repair_variant, name')
      .eq('service_type', 'denture_repair')
      .eq('active', true)
      .not('repair_variant', 'is', null);
    if (error) return [];
    const seen = new Map<string, string>();
    for (const r of (data ?? []) as Array<{ repair_variant: string; name: string }>) {
      if (!seen.has(r.repair_variant)) {
        seen.set(r.repair_variant, r.name ?? humanise(r.repair_variant));
      }
    }
    return Array.from(seen.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  if (axis.source.kind === 'catalogue_for') {
    if (axis.source.productKeys.length === 0) return [];
    const { data, error } = await supabase
      .from('lwo_catalogue')
      .select('product_key, name, arch_match')
      .in('product_key', [...axis.source.productKeys])
      .eq('active', true);
    if (error) return [];
    const seen = new Map<string, { label: string; archMatch: CatalogueArchMatch }>();
    for (const r of (data ?? []) as Array<{ product_key: string; name: string; arch_match: CatalogueArchMatch }>) {
      if (!seen.has(r.product_key)) {
        seen.set(r.product_key, {
          label: r.name ?? humanise(r.product_key),
          archMatch: r.arch_match,
        });
      }
    }
    // Order matches the registry's declared productKeys order so admins
    // see them in a predictable, intentional sequence (not alphabetical
    // shuffle when the catalogue gets reseeded).
    return axis.source.productKeys.flatMap((pk) => {
      const meta = seen.get(pk);
      return meta ? [{ key: pk, label: meta.label, archMatch: meta.archMatch }] : [];
    });
  }
  return [];
}

// ── Validation ───────────────────────────────────────────────────

// Returns null if the (service, axis pins) combination is valid;
// returns a human-readable error otherwise. Used at write time so an
// admin can't save a row pinning an axis the service doesn't declare.
export function validateAxisPins(
  service: BookingServiceType,
  row: {
    repair_variant?: string | null;
    product_key?: string | null;
    arch?: string | null;
  },
): string | null {
  const allowed = new Set(axesForService(service).map((a) => a.key));
  const pins = axesPinned(row);
  for (const pin of pins) {
    if (!allowed.has(pin.key)) {
      return `This booking type doesn't have a "${pin.key}" dimension.`;
    }
  }
  return null;
}

function humanise(s: string): string {
  return s
    .split('_')
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ');
}
