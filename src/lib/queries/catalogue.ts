import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// Mirror of the lwo_catalogue table that Checkpoint already manages. Lounge
// reads + writes the same rows so prices and SKUs never drift between the
// two surfaces. When Checkpoint's appointments retire, this catalogue
// becomes Lounge-owned without a migration.
//
// Prices are stored as numeric(10,2) pounds in Postgres, NOT pence. We keep
// pounds in the JS layer for everything that touches the catalogue
// directly, and only convert to pence (× 100, rounded) when copying a row
// into lng_cart_items at picker time.

export type ArchMatch = 'any' | 'single' | 'both';

export interface CatalogueRow {
  id: string;
  code: string;
  category: string;
  name: string;
  description: string | null;
  unit_price: number; // pounds — single-arch / non-arch price
  extra_unit_price: number | null; // pounds; null → no volume discount
  // Pounds. Set only when the product exposes arch options (arch_match
  // !== 'any'); the picker uses this when arch=both is selected, and
  // unit_price when arch=upper or lower.
  both_arches_price: number | null;
  unit_label: string | null;
  // Frozen URL — either a Supabase Storage public URL (admin upload)
  // or a third-party CDN URL pulled by SKU from Shopify. Once written
  // it is not re-resolved at render time.
  image_url: string | null;
  service_type: string | null;
  product_key: string | null;
  repair_variant: string | null;
  arch_match: ArchMatch;
  // Lounge picker classifier: true → Services bucket (top), false →
  // Products bucket. Defaults to false for legacy rows; admins flip
  // it per row.
  is_service: boolean;
  // When false the picker hides the Quantity stepper for this row.
  // Schema-driven (not inferred from unit_label) so a unit_label set
  // purely for display copy doesn't accidentally enable the stepper.
  // Default true at the column level; admin flips it off per row.
  quantity_enabled: boolean;
  // SLA window from "marked arrived" to "appointment complete". When
  // sla_enabled is true the breach evaluator (a follow-up slice) reads
  // sla_target_minutes; when false the column is dormant config.
  sla_enabled: boolean;
  sla_target_minutes: number | null;
  // Gates whether this line appears on the printable Lab Work Order.
  // Defaults true at the column level; impression-appointment rows
  // were backfilled to false in 20260430000007.
  include_on_lwo: boolean;
  // Gates whether arrival demands a JB ref for this item. Defaults
  // true; impression-appointment rows backfilled to false.
  allocate_job_box: boolean;
  // When true, appointment detail replaces the in-person arrival wizard
  // with Join/Rejoin/No-show actions. Applies to any remote service,
  // not just virtual impressions.
  is_virtual: boolean;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface CatalogueResult {
  rows: CatalogueRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Read every row (active + inactive). For the Admin Catalogue tab.
export function useCatalogueAll(): CatalogueResult {
  return useCatalogueQuery({ activeOnly: false });
}

// Read only active rows. For the picker on the visit / arrival flow.
export function useCatalogueActive(): CatalogueResult {
  return useCatalogueQuery({ activeOnly: true });
}

function useCatalogueQuery({ activeOnly }: { activeOnly: boolean }): CatalogueResult {
  const [rows, setRows] = useState<CatalogueRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(activeOnly ? 'cat-active' : 'cat-all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('lwo_catalogue')
        .select(
          'id, code, category, name, description, unit_price, extra_unit_price, both_arches_price, unit_label, image_url, service_type, product_key, repair_variant, arch_match, is_service, quantity_enabled, sla_enabled, sla_target_minutes, include_on_lwo, allocate_job_box, is_virtual, sort_order, active, created_at, updated_at'
        )
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true });
      if (activeOnly) q = q.eq('active', true);
      const { data, error: err } = await q;
      if (cancelled) return;
      if (err) {
        // 42P01 (relation not found) shouldn't happen in production —
        // lwo_catalogue is a Checkpoint table that pre-dates Lounge — but
        // treat it as empty rather than crash so a misconfigured shadow
        // env doesn't blank the admin page.
        if (err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setRows((data ?? []) as CatalogueRow[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeOnly, tick, settle]);

  return { rows, loading, error, refresh };
}

// Persist a draft catalogue row. Insert when id is missing, otherwise
// update. Returns the saved row.
export async function upsertCatalogueRow(
  draft: Omit<CatalogueRow, 'id' | 'created_at' | 'updated_at'> & { id?: string }
): Promise<CatalogueRow> {
  const payload = {
    code: draft.code,
    category: draft.category,
    name: draft.name,
    description: draft.description,
    unit_price: draft.unit_price,
    extra_unit_price: draft.extra_unit_price,
    both_arches_price: draft.both_arches_price,
    unit_label: draft.unit_label,
    image_url: draft.image_url,
    service_type: draft.service_type,
    product_key: draft.product_key,
    repair_variant: draft.repair_variant,
    arch_match: draft.arch_match,
    is_service: draft.is_service,
    quantity_enabled: draft.quantity_enabled,
    sla_enabled: draft.sla_enabled,
    sla_target_minutes: draft.sla_target_minutes,
    include_on_lwo: draft.include_on_lwo,
    allocate_job_box: draft.allocate_job_box,
    is_virtual: draft.is_virtual,
    sort_order: draft.sort_order,
    active: draft.active,
  };
  if (draft.id) {
    const { data, error } = await supabase
      .from('lwo_catalogue')
      .update(payload)
      .eq('id', draft.id)
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Update failed');
    return data as CatalogueRow;
  }
  const { data, error } = await supabase
    .from('lwo_catalogue')
    .insert(payload)
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Insert failed');
  return data as CatalogueRow;
}

// Soft delete via the active flag — never hard-delete because line items
// reference catalogue rows by id, and Checkpoint's locked walk-ins would
// lose their SKU history. Matches Checkpoint's deactivation pattern.
export async function setCatalogueActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('lwo_catalogue').update({ active }).eq('id', id);
  if (error) throw new Error(error.message);
}

// Uploads a product photo to the catalogue-images bucket and returns the
// public URL. The object name is keyed on the catalogue code so one row
// has at most one image — re-uploading replaces the previous file.
//
// Caller is responsible for writing the returned URL to
// lwo_catalogue.image_url (do that via upsertCatalogueRow). Doing it in
// two steps keeps storage semantics explicit and matches Checkpoint's
// "draft then save" admin pattern.
export async function uploadCatalogueImage(file: File, code: string): Promise<string> {
  if (!code.trim()) throw new Error('Catalogue code is required before uploading');
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  const objectName = `${slugifyCode(code)}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('catalogue-images')
    .upload(objectName, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || undefined,
    });
  if (uploadErr) throw new Error(uploadErr.message);
  const { data: pub } = supabase.storage.from('catalogue-images').getPublicUrl(objectName);
  if (!pub?.publicUrl) throw new Error('Could not resolve public URL for uploaded image');
  // Append a cache-busting suffix so the admin sees the new image
  // immediately without a hard reload (the storage CDN otherwise hands
  // out the previous image until the cache TTL elapses).
  return `${pub.publicUrl}?v=${Date.now()}`;
}

// Removes the image from storage and clears image_url on the catalogue
// row. Caller commits image_url=null via upsertCatalogueRow.
export async function deleteCatalogueImage(code: string): Promise<void> {
  if (!code.trim()) return;
  // We don't know the extension so list + delete by prefix. Cheap on a
  // small bucket; revisit if the catalogue ever grows past a few hundred.
  const { data: files } = await supabase.storage
    .from('catalogue-images')
    .list('', { search: slugifyCode(code) });
  const matching = (files ?? []).filter((f) => f.name.startsWith(slugifyCode(code) + '.'));
  if (matching.length === 0) return;
  const { error } = await supabase.storage
    .from('catalogue-images')
    .remove(matching.map((f) => f.name));
  if (error) throw new Error(error.message);
}

// Persists updated sort_order values for a batch of catalogue rows.
// Called after drag-and-drop reorder in the Admin Services tab.
// Each id gets sort_order = its new index × 10 (spacing so later
// insertions don't require a full rewrite).
export async function batchUpdateSortOrders(updates: Array<{ id: string; sort_order: number }>): Promise<void> {
  await Promise.all(
    updates.map(({ id, sort_order }) =>
      supabase
        .from('lwo_catalogue')
        .update({ sort_order })
        .eq('id', id)
        .then(({ error }) => {
          if (error) throw new Error(error.message);
        })
    )
  );
}

// Storage object names allow letters, digits, dashes, underscores and
// dots. Catalogue codes are already in that shape (e.g. 'den_snapped')
// but we belt-and-braces normalise just in case admin enters something
// weirder.
function slugifyCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
