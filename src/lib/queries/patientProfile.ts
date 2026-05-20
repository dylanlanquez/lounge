import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { formatAppointmentSummary, type IntakeAnswer } from './appointments.ts';

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
  allergies: string | null;
  communication_preferences: string | null;
  notes: string | null;
  avatar_data: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  // Structured address mirrored from Meridian's portal_ship_* columns
  // (populated by Shopify sync + the One Click portal). The legacy
  // single-line `address` field is no longer surfaced — receptionists
  // and the arrival intake gate read/write the structured fields.
  portal_ship_line1: string | null;
  portal_ship_line2: string | null;
  portal_ship_city: string | null;
  portal_ship_postcode: string | null;
  portal_ship_country_code: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const PATIENT_PROFILE_COLUMNS =
  'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, sex, address, registered_at, shopify_customer_id, allergies, communication_preferences, notes, avatar_data, emergency_contact_name, emergency_contact_phone, portal_ship_line1, portal_ship_line2, portal_ship_city, portal_ship_postcode, portal_ship_country_code, created_at, updated_at';

interface ProfileResult {
  data: PatientProfileRow | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePatientProfile(id: string | null | undefined): ProfileResult {
  const [data, setData] = useState<PatientProfileRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(id);

  useEffect(() => {
    if (!id) {
      settle();
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
            .select('id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id')
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
              allergies: null,
              communication_preferences: null,
              notes: null,
              avatar_data: null,
              emergency_contact_name: null,
              emergency_contact_phone: null,
              portal_ship_line1: null,
              portal_ship_line2: null,
              portal_ship_city: null,
              portal_ship_postcode: null,
              portal_ship_country_code: null,
              created_at: null,
              updated_at: null,
            } as PatientProfileRow);
          }
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setData(row as PatientProfileRow);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [id, tick, settle]);

  return { data, loading, error, refresh };
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
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      settle();
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
      // Match Meridian's PatientProfileFiles query — only `status='active'`
      // rows that are NOT deliveries surface here. Meridian splits them
      // off because delivery files (is_delivery=true) belong to the
      // FinalDeliveries surface — including them here used to render
      // the same case_delivery STL in both places, confusing reception.
      const { data: rows, error: err } = await supabase
        .from('patient_files')
        .select(
          'id, patient_id, custom_label, file_url, file_name, file_size_bytes, mime_type, status, uploaded_at, version, thumbnail_path, file_labels:label_id(key, label), uploader:uploaded_by(first_name, last_name)'
        )
        .eq('patient_id', patientId)
        .eq('status', 'active')
        .eq('is_delivery', false)
        .order('uploaded_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const mapped: PatientFileEntry[] = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
        const lbl = (r.file_labels as { key?: string; label?: string } | null) ?? null;
        const up = (r.uploader as { first_name?: string; last_name?: string } | null) ?? null;
        const uploaderName = up
          ? `${up.first_name ?? ''} ${up.last_name ?? ''}`.trim() || null
          : null;
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
          uploaded_by_name: uploaderName,
          version: (r.version as number | null) ?? null,
          thumbnail_path: (r.thumbnail_path as string | null) ?? null,
        };
      });
      setData(mapped);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // patient_files is in Meridian's realtime publication already, so
  // any new upload (via Meridian admin or a future Lounge upload UI)
  // shows up on the receptionist's PatientProfile without a reload.
  useRealtimeRefresh(
    patientId ? [{ table: 'patient_files', filter: `patient_id=eq.${patientId}` }] : [],
    refresh,
  );

  return { data, loading, error, refresh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery files — Meridian's "Final delivery" surface, view-only.
// Reads patient_files where is_delivery=true, joins to
// case_file_attachments → cases → case_types so each accepted /
// rejected delivery shows under its appliance type. Mirrors the
// loadAll fetch in Meridian's PatientDetail.jsx exactly so receptionists
// see the same set of files on both surfaces.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryFileEntry {
  id: string; // attachment id (one delivery row per attachment)
  caseRef: string | null;
  reviewStatus: 'accepted' | 'rejected' | 'pending_review' | string | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  rejectionNote: string | null;
  // The underlying patient_files row, ready to feed the existing
  // PreviewModal (which expects PatientFileEntry shape).
  file: PatientFileEntry;
}

export interface DeliveryGroup {
  applianceLabel: string;
  accepted: DeliveryFileEntry[];
  rejected: DeliveryFileEntry[];
}

interface DeliveryResult {
  groups: DeliveryGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePatientDeliveryFiles(patientId: string | null | undefined): DeliveryResult {
  const [groups, setGroups] = useState<DeliveryGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('patient_files')
        .select(
          `id, patient_id, custom_label, file_url, file_name, file_size_bytes, mime_type, status, uploaded_at, version, thumbnail_path,
           file_labels:label_id(key, label),
           uploader:uploaded_by(first_name, last_name),
           attachments:case_file_attachments(
             id, attachment_status, review_status, reviewed_at, rejection_note, review_note,
             reviewer:reviewed_by(first_name, last_name),
             case:case_id(case_reference, case_type:case_type_id(label))
           )`
        )
        .eq('patient_id', patientId)
        .eq('is_delivery', true)
        .order('uploaded_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        // 42703 (column missing) and PGRST200 (no relation) both mean
        // the deploy doesn't have the delivery tables wired yet —
        // treat as 'no deliveries' rather than crash the profile.
        if (err.code === 'PGRST200' || err.code === '42P01' || err.code === '42703') {
          setGroups([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }

      // Group attachments by appliance label, splitting accepted vs
      // rejected. attachment_status='current' or review_status='accepted'
      // = accepted; rejected likewise. Pending reviews are dropped from
      // the lounge surface — receptionists don't act on them.
      const map = new Map<string, DeliveryGroup>();
      for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
        const lbl = (r.file_labels as { key?: string; label?: string } | null) ?? null;
        const up = (r.uploader as { first_name?: string; last_name?: string } | null) ?? null;
        const uploaderName = up
          ? `${up.first_name ?? ''} ${up.last_name ?? ''}`.trim() || null
          : null;
        const file: PatientFileEntry = {
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
          uploaded_by_name: uploaderName,
          version: (r.version as number | null) ?? null,
          thumbnail_path: (r.thumbnail_path as string | null) ?? null,
        };
        const attachments = (r.attachments as Array<Record<string, unknown>>) ?? [];
        for (const att of attachments) {
          const c = (att.case as { case_reference?: string; case_type?: { label?: string } } | null) ?? null;
          if (!c) continue;
          const applianceLabel = c.case_type?.label || 'Unknown appliance';
          const reviewStatus = (att.review_status as string | null) ?? null;
          const attStatus = (att.attachment_status as string | null) ?? null;
          const reviewer =
            (att.reviewer as { first_name?: string; last_name?: string } | null) ?? null;
          const reviewerName = reviewer
            ? `${reviewer.first_name ?? ''} ${reviewer.last_name ?? ''}`.trim() || null
            : null;
          const entry: DeliveryFileEntry = {
            id: att.id as string,
            caseRef: c.case_reference ?? null,
            reviewStatus,
            reviewedAt: (att.reviewed_at as string | null) ?? null,
            reviewerName,
            rejectionNote:
              (att.rejection_note as string | null) ?? (att.review_note as string | null) ?? null,
            file,
          };
          let g = map.get(applianceLabel);
          if (!g) {
            g = { applianceLabel, accepted: [], rejected: [] };
            map.set(applianceLabel, g);
          }
          if (reviewStatus === 'accepted' || attStatus === 'current') {
            g.accepted.push(entry);
          } else if (reviewStatus === 'rejected' || attStatus === 'rejected') {
            g.rejected.push(entry);
          }
        }
      }
      const sortByReviewedDesc = (a: DeliveryFileEntry, b: DeliveryFileEntry) =>
        (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '');
      for (const g of map.values()) {
        g.accepted.sort(sortByReviewedDesc);
        g.rejected.sort(sortByReviewedDesc);
      }
      const sorted = [...map.values()].sort((a, b) =>
        a.applianceLabel.localeCompare(b.applianceLabel)
      );
      setGroups(sorted);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  return { groups, loading, error, refresh };
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
  status: 'arrived' | 'complete' | 'unsuitable' | 'ended_early';
  // Linkage back to lng_appointments when the visit was a scheduled
  // arrival. Lets the profile timeline dedupe — appointments whose id is
  // present in this set must not be re-listed as 'unbooked' alongside the
  // visit they produced.
  appointment_id: string | null;
  // Linkage back to lng_walk_ins when the visit was a walk-in. The
  // marker row in lng_appointments now carries the same FK (see
  // migration 20260430000005), so the profile timeline can dedup
  // walk-in markers against their visit with a single equality check.
  walk_in_id: string | null;
  // Booking-level reference (e.g. LAP-00001). Sourced from the
  // appointment for scheduled visits, or from the walk-in row for
  // walk-ins.
  lap_ref: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      // Two-step: visits, then carts in bulk. The cart join is done
      // client-side because the Supabase REST nested-select syntax can
      // not express "latest cart per visit" easily.
      const { data: visits, error: vErr } = await supabase
        .from('lng_visits')
        .select('id, opened_at, arrival_type, status, walk_in_id, appointment_id')
        .eq('patient_id', patientId)
        .order('opened_at', { ascending: false });
      if (cancelled) return;
      if (vErr) {
        setError(vErr.message);
        settle();
        return;
      }
      const visitIds = ((visits ?? []) as Array<{ id: string }>).map((v) => v.id);
      const walkInIds = ((visits ?? []) as Array<{ walk_in_id: string | null }>)
        .map((v) => v.walk_in_id)
        .filter((x): x is string => !!x);
      const apptIds = ((visits ?? []) as Array<{ appointment_id: string | null }>)
        .map((v) => v.appointment_id)
        .filter((x): x is string => !!x);

      const [cartsRes, walkInsRes, apptsRes] = await Promise.all([
        visitIds.length > 0
          ? supabase
              .from('lng_carts')
              .select('id, visit_id, status, total_pence')
              .in('visit_id', visitIds)
          : Promise.resolve({ data: [] as Array<{ id: string; visit_id: string; status: string; total_pence: number }>, error: null }),
        walkInIds.length > 0
          ? supabase
              .from('lng_walk_ins')
              .select('id, appointment_ref, service_type')
              .in('id', walkInIds)
          : Promise.resolve({ data: [] as Array<{ id: string; appointment_ref: string | null; service_type: string | null }>, error: null }),
        apptIds.length > 0
          ? supabase
              .from('lng_appointments')
              .select('id, appointment_ref, event_type_label, service_type, product_key, arch, intake')
              .in('id', apptIds)
          : Promise.resolve({
              data: [] as Array<{
                id: string;
                appointment_ref: string | null;
                event_type_label: string | null;
                service_type: string | null;
                product_key: string | null;
                arch: string | null;
                intake: unknown;
              }>,
              error: null,
            }),
      ]);
      if (cancelled) return;

      const cartByVisit = new Map<string, { id: string; status: string; total_pence: number }>();
      const cartIdToVisitId = new Map<string, string>();
      for (const c of (cartsRes.data ?? []) as Array<{ id: string; visit_id: string; status: string; total_pence: number }>) {
        cartByVisit.set(c.visit_id, { id: c.id, status: c.status, total_pence: c.total_pence });
        cartIdToVisitId.set(c.id, c.visit_id);
      }

      // Cart line names per visit. Used to derive the "Service" column
      // from what was actually transacted: 1 distinct line → that
      // line's name; 2+ distinct → "Multiple"; 0 → fall back to the
      // walk-in / appointment label below. Distinct by `name` because
      // ad-hoc rows have a null catalogue_id but always carry a name.
      const cartIds = [...cartIdToVisitId.keys()];
      const cartItemsRes = cartIds.length > 0
        ? await supabase
            .from('lng_cart_items')
            .select('cart_id, name')
            .in('cart_id', cartIds)
        : { data: [] as Array<{ cart_id: string; name: string }>, error: null };
      if (cancelled) return;

      const namesByVisit = new Map<string, Set<string>>();
      for (const it of (cartItemsRes.data ?? []) as Array<{ cart_id: string; name: string }>) {
        const visitId = cartIdToVisitId.get(it.cart_id);
        if (!visitId || !it.name) continue;
        let names = namesByVisit.get(visitId);
        if (!names) {
          names = new Set<string>();
          namesByVisit.set(visitId, names);
        }
        names.add(it.name);
      }

      const walkInById = new Map<string, { appointment_ref: string | null; service_type: string | null }>();
      for (const w of (walkInsRes.data ?? []) as Array<{ id: string; appointment_ref: string | null; service_type: string | null }>) {
        walkInById.set(w.id, { appointment_ref: w.appointment_ref, service_type: w.service_type });
      }
      interface ApptForVisit {
        appointment_ref: string | null;
        event_type_label: string | null;
        service_type: string | null;
        product_key: string | null;
        arch: string | null;
        intake: ReadonlyArray<IntakeAnswer> | null;
      }
      const apptById = new Map<string, ApptForVisit>();
      for (const a of (apptsRes.data ?? []) as Array<{
        id: string;
        appointment_ref: string | null;
        event_type_label: string | null;
        service_type: string | null;
        product_key: string | null;
        arch: string | null;
        intake: unknown;
      }>) {
        apptById.set(a.id, {
          appointment_ref: a.appointment_ref,
          event_type_label: a.event_type_label,
          service_type: a.service_type,
          product_key: a.product_key,
          arch: a.arch,
          intake: Array.isArray(a.intake) ? (a.intake as IntakeAnswer[]) : null,
        });
      }

      const mapped: PatientVisitRow[] = ((visits ?? []) as Array<{
        id: string;
        opened_at: string;
        arrival_type: 'walk_in' | 'scheduled';
        status: PatientVisitRow['status'];
        walk_in_id: string | null;
        appointment_id: string | null;
      }>).map((v) => {
        const cart = cartByVisit.get(v.id);
        const wi = v.walk_in_id ? walkInById.get(v.walk_in_id) ?? null : null;
        const appt = v.appointment_id ? apptById.get(v.appointment_id) ?? null : null;
        // Scheduled visit: prefer the appointment's LAP ref. Walk-in:
        // the walk-in row carries its own LAP ref (generated at intake).
        const lapRef = appt?.appointment_ref ?? wi?.appointment_ref ?? null;
        // Service label, in priority order:
        //   1. Cart contents — what the patient actually transacted.
        //      Multiple distinct lines collapse to "Multiple" so the
        //      column doesn't misrepresent a four-item visit as
        //      "Click-in veneers" (the first line) alone.
        //   2. Booking metadata (Calendly event label / walk-in
        //      service type) — the gate-flow category, used when no
        //      cart exists yet (e.g. an arrived visit not yet billed).
        const cartNames = namesByVisit.get(v.id);
        const cartLabel =
          cartNames && cartNames.size > 0
            ? cartNames.size === 1
              ? [...cartNames][0]!
              : 'Multiple'
            : null;
        // Fallback to the canonical appointment summary (same
        // helper the schedule / hero / emails use) so a visit
        // without a cart yet reads "Same-day upper retainer"
        // rather than the raw "Same-day appliance" service-type
        // label that humaniseEventTypeLabel would echo.
        const canonicalApptLabel = appt
          ? formatAppointmentSummary({
              service_type: appt.service_type,
              event_type_label: appt.event_type_label,
              arch: appt.arch,
              product_key: appt.product_key,
              intake: appt.intake,
            })
          : null;
        const serviceLabel =
          cartLabel ??
          (canonicalApptLabel || humaniseEventTypeLabel(appt?.event_type_label ?? null)) ??
          humaniseServiceType(wi?.service_type ?? null);
        return {
          id: v.id,
          opened_at: v.opened_at,
          arrival_type: v.arrival_type,
          status: v.status,
          appointment_id: v.appointment_id ?? null,
          walk_in_id: v.walk_in_id ?? null,
          lap_ref: lapRef,
          service_label: serviceLabel,
          cart_status: (cart?.status as PatientVisitRow['cart_status']) ?? null,
          cart_total_pence: cart?.total_pence ?? null,
        };
      });
      setData(mapped);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // Visit list refreshes when any of its source tables changes for
  // this patient. lng_visits filtered by patient_id; cart totals come
  // from lng_carts/lng_cart_items so visits with shifting totals
  // reflect immediately. lng_walk_ins changes are rare but cheap to
  // listen to.
  useRealtimeRefresh(
    patientId
      ? [
          { table: 'lng_visits', filter: `patient_id=eq.${patientId}` },
          { table: 'lng_carts' },
          { table: 'lng_cart_items' },
          { table: 'lng_walk_ins', filter: `patient_id=eq.${patientId}` },
        ]
      : [],
    refresh,
  );

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
    case 'impression_appointment':
      return 'Impression appointment';
    default:
      return s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled appointments — every lng_appointments row for this patient.
// Surfaces upcoming bookings (the visit hasn't been opened yet) AND legacy
// past appointments that were never booked in (no_show, cancelled, or
// historical ones from before Lounge existed). Past appointments that DID
// get booked in already appear in usePatientVisits, so the Appointments
// section in the profile filters those out client-side via visit.appointment_id
// to avoid double-counting.
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduledApptStatus =
  | 'booked'
  | 'arrived'
  | 'joined'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';

export interface PatientScheduledAppointmentRow {
  id: string;
  start_at: string;
  end_at: string;
  status: ScheduledApptStatus;
  source: 'calendly' | 'manual' | 'native' | null;
  event_type_label: string | null;
  // Axis pins — present on every axis-driven booking (native widget
  // + staff-created manual). Fed straight into formatAppointmentSummary
  // so the profile row reads as the canonical "Same-day upper retainer"
  // etc., not the raw service-type label.
  service_type: string | null;
  product_key: string | null;
  arch: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  // Set on rows that are calendar markers for a walk-in arrival —
  // points to the lng_walk_ins row. The patient profile timeline uses
  // it to dedup the marker against the visit it shadows. NULL for
  // booked appointments (Calendly / native).
  walk_in_id: string | null;
}

interface ScheduledAppointmentsResult {
  data: PatientScheduledAppointmentRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientScheduledAppointments(
  patientId: string | null | undefined
): ScheduledAppointmentsResult {
  const [data, setData] = useState<PatientScheduledAppointmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      // appointment_ref, jb_ref, walk_in_id are post-migration columns;
      // fall back to a slimmer select if the deploy doesn't have them
      // yet (42703). walk_in_id was added in 20260430000005 — without
      // it the timeline can't dedup walk-in markers against their
      // visit, so the duplicate is a known degraded state on
      // pre-migration deploys.
      const fullSel =
        'id, start_at, end_at, status, source, event_type_label, service_type, product_key, arch, appointment_ref, jb_ref, walk_in_id';
      const slimSel = 'id, start_at, end_at, status, source, event_type_label';
      const first = await supabase
        .from('lng_appointments')
        .select(fullSel)
        .eq('patient_id', patientId)
        .order('start_at', { ascending: false });
      let rows: Array<Record<string, unknown>> | null =
        (first.data as Array<Record<string, unknown>> | null) ?? null;
      let err = first.error;
      if (err && err.code === '42703') {
        const fb = await supabase
          .from('lng_appointments')
          .select(slimSel)
          .eq('patient_id', patientId)
          .order('start_at', { ascending: false });
        rows = (fb.data as Array<Record<string, unknown>> | null) ?? null;
        err = fb.error;
      }
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const mapped: PatientScheduledAppointmentRow[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        start_at: r.start_at as string,
        end_at: r.end_at as string,
        status: r.status as ScheduledApptStatus,
        source: (r.source as PatientScheduledAppointmentRow['source']) ?? null,
        event_type_label: (r.event_type_label as string | null) ?? null,
        service_type: (r.service_type as string | null) ?? null,
        product_key: (r.product_key as string | null) ?? null,
        arch: (r.arch as string | null) ?? null,
        appointment_ref: (r.appointment_ref as string | null) ?? null,
        jb_ref: (r.jb_ref as string | null) ?? null,
        walk_in_id: (r.walk_in_id as string | null) ?? null,
      }));
      setData(mapped);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // New Calendly bookings, cancellations, and reschedules all flow
  // through lng_appointments. Filter by patient_id so a busy clinic
  // doesn't fire one refresh per appointment everywhere.
  useRealtimeRefresh(
    patientId ? [{ table: 'lng_appointments', filter: `patient_id=eq.${patientId}` }] : [],
    refresh,
  );

  return { data, loading, error };
}

// Same humaniser as the visits row, exported so the profile Appointments
// section can label scheduled appointments without re-implementing the
// service-type mapping locally.
export function humaniseEventTypeLabel(label: string | null): string | null {
  if (!label) return null;
  // Calendly event type labels are already human-friendly; only fall back
  // to the underscore-stripped service_type when the label itself looks
  // like a slug (no spaces, all lowercase + underscores).
  if (/^[a-z0-9_]+$/.test(label)) return humaniseServiceType(label);
  return label;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify orders for a patient — wraps the lng_patient_shopify_orders RPC
// (security definer, gates on patients RLS). Returns every order linked to
// the patient in reverse-chrono order, regardless of fulfilment state.
// Items come pre-aggregated so the profile renders the summary line in
// one round trip.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientShopifyOrderItem {
  title: string | null;
  sku: string | null;
  quantity: number | null;
  price: number | null;
}

export interface PatientShopifyOrderRow {
  id: string;
  name: string | null;
  created_at: string;
  total_price: number | null;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  refund_amount: number | null;
  items: PatientShopifyOrderItem[];
}

interface PatientShopifyOrdersResult {
  data: PatientShopifyOrderRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientShopifyOrders(
  patientId: string | null | undefined,
): PatientShopifyOrdersResult {
  const [data, setData] = useState<PatientShopifyOrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      setData([]);
      setError(null);
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase.rpc(
        'lng_patient_shopify_orders',
        { p_patient_id: patientId },
      );
      if (cancelled) return;
      if (err) {
        // PGRST202 = function not found (older deploys / shadow without
        // shopify_orders). Degrade silently — the card simply won't
        // render when data is empty + loading is false.
        if (err.code === 'PGRST202' || err.code === '42883' || err.code === '42P01') {
          setData([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const mapped: PatientShopifyOrderRow[] = ((rows ?? []) as Array<Record<string, unknown>>).map(
        (r) => ({
          id: String(r.id ?? ''),
          name: (r.name as string | null) ?? null,
          created_at: r.created_at as string,
          total_price: toNumberOrNull(r.total_price),
          currency: (r.currency as string | null) ?? null,
          financial_status: (r.financial_status as string | null) ?? null,
          fulfillment_status: (r.fulfillment_status as string | null) ?? null,
          cancelled_at: (r.cancelled_at as string | null) ?? null,
          refund_amount: toNumberOrNull(r.refund_amount),
          items: parseItems(r.items),
        }),
      );
      setData(mapped);
      setError(null);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // Webhook-driven refresh — orders/paid and orders/updated webhooks
  // upsert into shopify_orders, so when a fulfilment lands on the
  // patient currently being viewed, the card refreshes without a
  // manual reload. Filter omitted because shopify_orders has no
  // patient_id column; we accept the slightly wider firing in exchange
  // for not adding a filter dependent on shopify_customer_id, which
  // would require a useState dance to read.
  useRealtimeRefresh(patientId ? [{ table: 'shopify_orders' }] : [], refresh);

  return { data, loading, error };
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseItems(v: unknown): PatientShopifyOrderItem[] {
  if (!Array.isArray(v)) return [];
  return v.map((it) => {
    const obj = (it ?? {}) as Record<string, unknown>;
    return {
      title: (obj.title as string | null) ?? null,
      sku: (obj.sku as string | null) ?? null,
      quantity: typeof obj.quantity === 'number' ? obj.quantity : null,
      price: toNumberOrNull(obj.price),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Case history — Meridian's `cases` table joined to case_types and
// case_stages. Buckets are derived from is_terminal / paused_at / open.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientCaseRow {
  // Discriminates between Meridian's submitter-side `cases` and the
  // production-side `production_cases` table. The Case history card
  // renders both kinds in one list so staff see the full picture.
  kind: 'case' | 'production_case';
  id: string;
  case_reference: string;
  type_label: string | null;
  stage_key: string | null;
  stage_label: string | null;
  is_terminal: boolean;
  paused_at: string | null;
  created_at: string;
  completed_at: string | null;
  // production_cases-only columns surfaced for the renderer. Null on
  // regular cases.
  cancelled_at?: string | null;
  archived_at?: string | null;
  shopify_order_name?: string | null;
  job_box_number?: string | null;
}

interface CasesResult {
  data: PatientCaseRow[];
  loading: boolean;
  error: string | null;
}

export function usePatientCases(patientId: string | null | undefined): CasesResult {
  const [data, setData] = useState<PatientCaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, settle } = useStaleQueryLoading(patientId);

  useEffect(() => {
    if (!patientId) {
      settle();
      return;
    }
    let cancelled = false;
    (async () => {
      // Fetch both submitter cases and production cases in parallel so
      // the dropdown reads one merged history. Either query can fail
      // independently (e.g. mid-migration deploys missing the table or
      // an RLS path the Lounge role isn't in); a failed branch resolves
      // to an empty list rather than blocking the other.
      const [casesRes, prodRes] = await Promise.all([
        supabase
          .from('cases')
          .select(
            'id, case_reference, paused_at, created_at, completed_at, case_type:case_type_id(label), stage:stage_key(key, label, is_terminal)',
          )
          .eq('patient_id', patientId)
          .order('created_at', { ascending: false }),
        supabase
          .from('production_cases')
          .select(
            'id, reference, stage_key, created_at, completed_at, cancelled_at, archived_at, shopify_order_name, job_box_number, deleted_at',
          )
          .eq('patient_id', patientId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false }),
      ]);
      if (cancelled) return;

      const submitterRows: PatientCaseRow[] = [];
      if (casesRes.error) {
        if (casesRes.error.code !== 'PGRST200' && casesRes.error.code !== '42P01') {
          setError(casesRes.error.message);
        }
      } else {
        for (const r of (casesRes.data ?? []) as Array<Record<string, unknown>>) {
          const type = (r.case_type as { label?: string } | null) ?? null;
          const stage = (r.stage as { key?: string; label?: string; is_terminal?: boolean } | null) ?? null;
          submitterRows.push({
            kind: 'case',
            id: r.id as string,
            case_reference: r.case_reference as string,
            type_label: type?.label ?? null,
            stage_key: stage?.key ?? null,
            stage_label: stage?.label ?? null,
            is_terminal: !!stage?.is_terminal,
            paused_at: (r.paused_at as string | null) ?? null,
            created_at: r.created_at as string,
            completed_at: (r.completed_at as string | null) ?? null,
          });
        }
      }

      const productionRows: PatientCaseRow[] = [];
      if (prodRes.error) {
        // Same defensive list of "table/relation missing" codes — never
        // hard-fail the card on a Meridian schema gap. Other errors
        // bubble to the UI's red banner.
        if (
          prodRes.error.code !== 'PGRST200' &&
          prodRes.error.code !== '42P01' &&
          prodRes.error.code !== '42501'
        ) {
          setError(prodRes.error.message);
        }
      } else {
        for (const r of (prodRes.data ?? []) as Array<Record<string, unknown>>) {
          const stageKey = (r.stage_key as string | null) ?? null;
          const cancelledAt = (r.cancelled_at as string | null) ?? null;
          const archivedAt = (r.archived_at as string | null) ?? null;
          const completedAt = (r.completed_at as string | null) ?? null;
          // production_cases' stage vocabulary is a free-text column,
          // so map known keys to human labels here. New stages added
          // upstream will pass through as the humanised slug.
          const stageLabel = humaniseProductionStage(stageKey);
          productionRows.push({
            kind: 'production_case',
            id: r.id as string,
            case_reference: (r.reference as string | null) ?? '—',
            // Production cases are the lab's downstream view of a case;
            // a fixed type label keeps the row's intent visible at a
            // glance without inventing a synthetic case_type table.
            type_label: 'Production',
            stage_key: stageKey,
            stage_label: stageLabel,
            is_terminal: !!(cancelledAt || archivedAt || stageKey === 'complete'),
            paused_at: null,
            created_at: r.created_at as string,
            completed_at: completedAt,
            cancelled_at: cancelledAt,
            archived_at: archivedAt,
            shopify_order_name: (r.shopify_order_name as string | null) ?? null,
            job_box_number: (r.job_box_number as string | null) ?? null,
          });
        }
      }

      const merged = [...submitterRows, ...productionRows].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      setData(merged);
      // Surface a non-fatal error only when neither branch returned;
      // otherwise prefer showing what we have over a red banner.
      if (
        submitterRows.length === 0 &&
        productionRows.length === 0 &&
        casesRes.error &&
        prodRes.error
      ) {
        setError(casesRes.error.message);
      } else {
        setError(null);
      }
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, settle]);

  return { data, loading, error };
}

// production_cases.stage_key vocabulary — kept close to the type for
// easy maintenance. Unknown keys fall through as their humanised slug
// so a new upstream stage doesn't render as a blank label.
function humaniseProductionStage(key: string | null): string | null {
  if (!key) return null;
  switch (key) {
    case 'pending_claim':
      return 'Pending claim';
    case 'in_production':
      return 'In production';
    case 'pending_review':
      return 'Pending review';
    case 'pending_dispatch':
      return 'Pending dispatch';
    case 'complete':
      return 'Complete';
    case 'archived':
      return 'Archived';
    default:
      return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export type CaseBucket = 'paused' | 'active' | 'completed';

export function bucketCase(c: PatientCaseRow): CaseBucket {
  // Production cases use their own terminal signals — cancelled,
  // archived, or stage='complete'. Map onto the same three-bucket
  // language the submitter cases use so the dropdown's Active /
  // Paused / Completed badges stay accurate.
  if (c.kind === 'production_case') {
    if (c.cancelled_at || c.archived_at) return 'completed';
    if (c.stage_key === 'complete') return 'completed';
    return 'active';
  }
  if (c.is_terminal) return 'completed';
  if (c.paused_at) return 'paused';
  return 'active';
}
