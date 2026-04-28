import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Patient profile queries — the read-side surface for /patient/:id.
//
// Lounge runs on Meridian's Supabase, so most of these tables are owned by
// Meridian (patients, file_labels, patient_files, cases). We read columns
// defensively — pre-migration / cross-deploy schema gaps surface as
// PGRST200 / 42P01 / 42703 and we degrade gracefully rather than crash.
// ─────────────────────────────────────────────────────────────────────────────

// Full identity row used by the Hero card. A superset of the lighter
// PatientRow used by search — we want every Meridian-side profile column
// the design asks for, including the address fields and metadata.
export interface PatientProfileRow {
  id: string;
  location_id: string | null;
  internal_ref: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  sex: string | null;
  address: string | null;
  registered_at: string | null;
  shopify_customer_id: string | null;
  lwo_contact_id: string | null;
  lwo_ref: string | null;
  referred_by: string | null;
  insurance: string | null;
  allergies: string | null;
  communication_preferences: string | null;
  notes: string | null;
  avatar_data: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const PATIENT_PROFILE_COLUMNS =
  'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, sex, address, registered_at, shopify_customer_id, lwo_contact_id, lwo_ref, referred_by, insurance, allergies, communication_preferences, notes, avatar_data, created_at, updated_at';

interface ProfileResult {
  data: PatientProfileRow | null;
  loading: boolean;
  error: string | null;
}

export function usePatientProfile(id: string | null | undefined): ProfileResult {
  const [data, setData] = useState<PatientProfileRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: row, error: err } = await supabase
        .from('patients')
        .select(PATIENT_PROFILE_COLUMNS)
        .eq('id', id)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        // 42703 = column does not exist (cross-deploy with Meridian
        // schema in flux). Fall back to the minimum required identity
        // columns so the page still renders.
        if (err.code === '42703') {
          const { data: minRow, error: err2 } = await supabase
            .from('patients')
            .select('id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id')
            .eq('id', id)
            .maybeSingle();
          if (cancelled) return;
          if (err2) {
            setError(err2.message);
          } else if (minRow) {
            setData({
              ...(minRow as Partial<PatientProfileRow>),
              sex: null,
              address: null,
              registered_at: null,
              lwo_contact_id: null,
              referred_by: null,
              insurance: null,
              allergies: null,
              communication_preferences: null,
              notes: null,
              avatar_data: null,
              created_at: null,
              updated_at: null,
            } as PatientProfileRow);
          }
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      setData(row as PatientProfileRow);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient files — joined to file_labels so we can group by the canonical
// label key (upper_arch, smile_photo_left, etc) and show the Meridian
// human label alongside the version.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientFileEntry {
  id: string;
  patient_id: string;
  label_key: string | null;
  label_display: string | null;
  custom_label: string | null;
  file_url: string;
  file_name: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  status: string;
  uploaded_at: string;
  uploaded_by_name: string | null;
  version: number | null;
  thumbnail_path: string | null;
}

interface FilesResult {
  data: PatientFileEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePatientProfileFiles(patientId: string | null | undefined): FilesResult {
  const [data, setData] = useState<PatientFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!patientId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // Inner-join to file_labels so we always have a label_key. Left-join
      // to accounts for the uploader display name (may be null for
      // historical rows / Shopify-side uploads). version + thumbnail_path
      // are Meridian-side append-only columns — version stays stamped
      // on every row, thumbnail_path caches a rendered PNG for STL/OBJ
      // scan files. Both may be null on legacy rows.
      const { data: rows, error: err } = await supabase
        .from('patient_files')
        .select(
          'id, patient_id, custom_label, file_url, file_name, file_size_bytes, mime_type, status, uploaded_at, version, thumbnail_path, file_labels:label_id(key, label), uploader:uploaded_by(full_name)'
        )
        .eq('patient_id', patientId)
        .order('uploaded_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      const mapped: PatientFileEntry[] = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
        const lbl = (r.file_labels as { key?: string; label?: string } | null) ?? null;
        const up = (r.uploader as { full_name?: string } | null) ?? null;
        return {
          id: r.id as string,
          patient_id: r.patient_id as string,
          label_key: lbl?.key ?? null,
          label_display: lbl?.label ?? null,
          custom_label: (r.custom_label as string | null) ?? null,
          file_url: r.file_url as string,
          file_name: r.file_name as string,
          file_size_bytes: (r.file_size_bytes as number | null) ?? null,
          mime_type: (r.mime_type as string | null) ?? null,
          status: r.status as string,
          uploaded_at: r.uploaded_at as string,
          uploaded_by_name: up?.full_name ?? null,
          version: (r.version as number | null) ?? null,
          thumbnail_path: (r.thumbnail_path as string | null) ?? null,
        };
      });
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick]);

  return { data, loading, error, refresh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk-in appointments table — every visit this patient has had at this
// clinic. Joined to lng_appointments for the LWO ref / service / status
// where available.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientVisitRow {
  id: string;
  opened_at: string;
  arrival_type: 'walk_in' | 'scheduled';
  status: 'opened' | 'in_progress' | 'complete' | 'cancelled';
  lwo_ref: string | null;
  service_label: string | null;
  cart_status: 'open' | 'paid' | 'voided' | null;
  cart_total_pence: number | null;
}

interface VisitsResult {
  data: PatientVisitRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientVisits(patientId: string | null | undefined): VisitsResult {
  const [data, setData] = useState<PatientVisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      // Two-step: visits, then carts in bulk. The cart join is done
      // client-side because the Supabase REST nested-select syntax can
      // not express "latest cart per visit" easily.
      const { data: visits, error: vErr } = await supabase
        .from('lng_visits')
        .select('id, opened_at, arrival_type, status, walk_in_id')
        .eq('patient_id', patientId)
        .order('opened_at', { ascending: false });
      if (cancelled) return;
      if (vErr) {
        setError(vErr.message);
        setLoading(false);
        return;
      }
      const visitIds = ((visits ?? []) as Array<{ id: string }>).map((v) => v.id);
      const walkInIds = ((visits ?? []) as Array<{ walk_in_id: string | null }>)
        .map((v) => v.walk_in_id)
        .filter((x): x is string => !!x);

      const [cartsRes, walkInsRes] = await Promise.all([
        visitIds.length > 0
          ? supabase
              .from('lng_carts')
              .select('visit_id, status, total_pence')
              .in('visit_id', visitIds)
          : Promise.resolve({ data: [] as Array<{ visit_id: string; status: string; total_pence: number }>, error: null }),
        walkInIds.length > 0
          ? supabase
              .from('lng_walk_ins')
              .select('id, lwo_ref, service_type')
              .in('id', walkInIds)
          : Promise.resolve({ data: [] as Array<{ id: string; lwo_ref: string | null; service_type: string | null }>, error: null }),
      ]);
      if (cancelled) return;

      const cartByVisit = new Map<string, { status: string; total_pence: number }>();
      for (const c of (cartsRes.data ?? []) as Array<{ visit_id: string; status: string; total_pence: number }>) {
        cartByVisit.set(c.visit_id, { status: c.status, total_pence: c.total_pence });
      }
      const walkInById = new Map<string, { lwo_ref: string | null; service_type: string | null }>();
      for (const w of (walkInsRes.data ?? []) as Array<{ id: string; lwo_ref: string | null; service_type: string | null }>) {
        walkInById.set(w.id, { lwo_ref: w.lwo_ref, service_type: w.service_type });
      }

      const mapped: PatientVisitRow[] = ((visits ?? []) as Array<{
        id: string;
        opened_at: string;
        arrival_type: 'walk_in' | 'scheduled';
        status: PatientVisitRow['status'];
        walk_in_id: string | null;
      }>).map((v) => {
        const cart = cartByVisit.get(v.id);
        const wi = v.walk_in_id ? walkInById.get(v.walk_in_id) ?? null : null;
        return {
          id: v.id,
          opened_at: v.opened_at,
          arrival_type: v.arrival_type,
          status: v.status,
          lwo_ref: wi?.lwo_ref ?? null,
          service_label: humaniseServiceType(wi?.service_type ?? null),
          cart_status: (cart?.status as PatientVisitRow['cart_status']) ?? null,
          cart_total_pence: cart?.total_pence ?? null,
        };
      });
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  return { data, loading, error };
}

function humaniseServiceType(s: string | null): string | null {
  if (!s) return null;
  switch (s) {
    case 'denture_repair':
      return 'Denture repair';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'click_in_veneers':
      return 'Click-in veneers';
    default:
      return s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Case history — Meridian's `cases` table joined to case_types and
// case_stages. Buckets are derived from is_terminal / paused_at / open.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientCaseRow {
  id: string;
  case_reference: string;
  type_label: string | null;
  stage_key: string | null;
  stage_label: string | null;
  is_terminal: boolean;
  paused_at: string | null;
  created_at: string;
  completed_at: string | null;
}

interface CasesResult {
  data: PatientCaseRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientCases(patientId: string | null | undefined): CasesResult {
  const [data, setData] = useState<PatientCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('cases')
        .select(
          'id, case_reference, paused_at, created_at, completed_at, case_type:case_type_id(label), stage:stage_key(key, label, is_terminal)'
        )
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      const mapped: PatientCaseRow[] = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
        const type = (r.case_type as { label?: string } | null) ?? null;
        const stage = (r.stage as { key?: string; label?: string; is_terminal?: boolean } | null) ?? null;
        return {
          id: r.id as string,
          case_reference: r.case_reference as string,
          type_label: type?.label ?? null,
          stage_key: stage?.key ?? null,
          stage_label: stage?.label ?? null,
          is_terminal: !!stage?.is_terminal,
          paused_at: (r.paused_at as string | null) ?? null,
          created_at: r.created_at as string,
          completed_at: (r.completed_at as string | null) ?? null,
        };
      });
      setData(mapped);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  return { data, loading, error };
}

export type CaseBucket = 'paused' | 'active' | 'completed';

export function bucketCase(c: PatientCaseRow): CaseBucket {
  if (c.is_terminal) return 'completed';
  if (c.paused_at) return 'paused';
  return 'active';
}
