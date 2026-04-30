import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import {
  eventTypeCategory,
  filterCareIntake,
  formatBookingSummary,
  type AppointmentRow,
} from './appointments.ts';
import {
  requiredSectionsForServiceTypes,
  sectionSignatureState,
  type WaiverSection,
  type WaiverSignatureSummary,
} from './waiver.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Clinic board — the data spine for /in-clinic.
//
// One hook (useActiveVisitsBoard) returns one enriched row per active
// visit. That row carries everything the board needs to render: patient
// identity for the avatar, booking metadata for the descriptor + section
// bucket, computed paid status and amount, computed waiver status, plus
// a pre-built searchable index string so client-side filtering stays
// O(1) per keystroke.
//
// Three queries fan out in parallel after the initial visits batch so
// no per-card N+1 work happens in the React tree:
//
//   A. lng_visits joined to patients, lng_appointments, lng_walk_ins
//      via PostgREST FK relationships.
//   B. lng_visit_paid_status filtered to the visit ids from A.
//   C. lng_waiver_sections (active) + lng_waiver_signatures filtered
//      to the patient ids from A.
//
// Pure helpers (bucketForVisit / searchableTextForVisit /
// sortByWaitingDesc / waiverStatusForVisit) sit alongside so they're
// unit-testable and the hook stays a thin orchestration layer.
// ─────────────────────────────────────────────────────────────────────────────

export type ClinicSectionKey =
  | 'appliance'
  | 'sameDay'
  | 'repair'
  | 'impression'
  | 'consult';

export const CLINIC_SECTION_ORDER: ClinicSectionKey[] = [
  'appliance',
  'sameDay',
  'repair',
  'impression',
  'consult',
];

export const CLINIC_SECTION_LABELS: Record<ClinicSectionKey, string> = {
  appliance: 'Same-day appliances',
  sameDay: 'Same-day click-in veneers',
  repair: 'Denture repairs',
  impression: 'Impression appointments',
  consult: 'Other',
};

export type WaiverDisplayStatus = 'done' | 'pending' | 'not_required';

export interface EnrichedActiveVisit {
  id: string;
  patient_id: string;
  status: 'opened' | 'in_progress';
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  // Patient identity
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_phone: string | null;
  patient_email: string | null;
  patient_internal_ref: string | null;
  patient_avatar_data: string | null;
  // Booking metadata (booked from lng_appointments; walk-in from lng_walk_ins)
  event_type_label: string | null;
  intake: Array<{ question: string; answer: string }> | null;
  appointment_ref: string | null;
  jb_ref: string | null;
  service_type: string | null;
  appliance_type: string | null;
  // Computed display fields
  bucket: ClinicSectionKey;
  descriptor: string;
  searchable: string;
  // Pricing
  amount_due_pence: number | null;
  amount_paid_pence: number;
  paid_status: 'no_charge' | 'paid' | 'partially_paid' | 'unpaid';
  payment_done: boolean;
  // Waiver
  waiver_status: WaiverDisplayStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

// Walk-in service_type → ClinicSectionKey. Booked appointments are
// classified via eventTypeCategory(event_type_label). Returns 'consult'
// for anything we don't recognise so nothing is silently dropped.
const WALK_IN_BUCKETS: Record<string, ClinicSectionKey> = {
  denture_repair: 'repair',
  same_day_appliance: 'appliance',
  click_in_veneers: 'sameDay',
  impression_appointment: 'impression',
};

export function bucketForVisit(input: {
  event_type_label: string | null;
  service_type: string | null;
}): ClinicSectionKey {
  if (input.service_type && WALK_IN_BUCKETS[input.service_type]) {
    return WALK_IN_BUCKETS[input.service_type]!;
  }
  // eventTypeCategory carries an extra 'virtualImpression' bucket so
  // schedule cards can be coloured teal vs olive-lime; the in-clinic
  // board only cares about the underlying service kind, so collapse
  // it back to 'impression' here.
  const cat = eventTypeCategory(input.event_type_label);
  return cat === 'virtualImpression' ? 'impression' : cat;
}

export function searchableTextForVisit(v: EnrichedActiveVisit): string {
  return [
    v.patient_first_name,
    v.patient_last_name,
    v.patient_phone,
    v.patient_email,
    v.patient_internal_ref,
    v.appointment_ref,
    v.jb_ref ? `JB${v.jb_ref}` : null,
    v.event_type_label,
    v.service_type,
    v.appliance_type,
    v.descriptor,
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')
    .toLowerCase();
}

// Longest-waiting first → oldest opened_at first.
export function sortByWaitingDesc<T extends { opened_at: string }>(visits: T[]): T[] {
  return [...visits].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

// Resolve the waiver state for one visit using already-fetched
// sections + the patient's signatures map. 'not_required' when no
// section applies; 'done' when every required section is signed at
// the current version; 'pending' otherwise.
export function waiverStatusForVisit(
  visit: { event_type_label: string | null; service_type: string | null },
  sections: WaiverSection[],
  patientSignatures: Map<string, WaiverSignatureSummary>
): WaiverDisplayStatus {
  if (sections.length === 0) return 'not_required';
  const inferredService = inferServiceTypeFromBooking(visit);
  const required = requiredSectionsForServiceTypes(
    inferredService ? [inferredService] : [],
    sections
  );
  if (required.length === 0) return 'not_required';
  const allCurrent = required.every(
    (s) => sectionSignatureState(s, patientSignatures) === 'current'
  );
  return allCurrent ? 'done' : 'pending';
}

// Map booking metadata to one of the waiver service_type keys
// (denture_repair / same_day_appliance / click_in_veneers). Mirrors
// inferServiceTypeFromEventLabel but also reads walk-in service_type
// directly so walk-ins don't need a synthetic event label.
function inferServiceTypeFromBooking(input: {
  event_type_label: string | null;
  service_type: string | null;
}): string | null {
  if (input.service_type === 'denture_repair') return 'denture_repair';
  if (input.service_type === 'same_day_appliance') return 'same_day_appliance';
  if (input.service_type === 'click_in_veneers') return 'click_in_veneers';
  if (input.service_type === 'impression_appointment') return 'impression_appointment';
  if (input.service_type === 'other') return null;
  const label = input.event_type_label;
  if (!label) return null;
  const l = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(l)) return 'denture_repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(l)) return 'click_in_veneers';
  if (/same[\s-]?day\s+appliance|appliance|impression|aligner|retainer|guard|whitening/i.test(l)) {
    return 'same_day_appliance';
  }
  return null;
}

// "47m" / "2h 12m". Tabular numerals are the consumer's responsibility.
export function formatWaitingTime(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h ${rem}m`;
}

// Used by the card to highlight long waits in alert tone. 2h is the
// brief's clinical urgency threshold (a patient sat over two hours is
// always worth a glance).
export const LONG_WAIT_MINUTES = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

interface ClinicBoardResult {
  visits: EnrichedActiveVisit[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

interface PatientJoin {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  internal_ref: string | null;
  avatar_data: string | null;
}

interface AppointmentJoin {
  event_type_label: string | null;
  intake: Array<{ question: string; answer: string }> | null;
  appointment_ref: string | null;
  jb_ref: string | null;
}

interface WalkInJoin {
  service_type: string | null;
  appliance_type: string | null;
  appointment_ref: string | null;
  jb_ref: string | null;
}

// PostgREST returns single-row FK joins as either the row itself or
// a one-element array depending on cardinality and config; tolerate
// both shapes with pickOne below.
interface VisitsRowFromDb {
  id: string;
  patient_id: string;
  status: 'opened' | 'in_progress';
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  patient: PatientJoin | PatientJoin[] | null;
  appointment: AppointmentJoin | AppointmentJoin[] | null;
  walk_in: WalkInJoin | WalkInJoin[] | null;
}

interface PaidStatusRow {
  visit_id: string;
  amount_due_pence: number | null;
  amount_paid_pence: number;
  paid_status: 'no_charge' | 'paid' | 'partially_paid' | 'unpaid';
}

interface SignatureRow {
  patient_id: string;
  section_key: string;
  section_version: string;
  signed_at: string;
}

export function useActiveVisitsBoard(): ClinicBoardResult {
  const [visits, setVisits] = useState<EnrichedActiveVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      // Step A — visits with all related rows.
      const { data: rawVisits, error: vErr } = await supabase
        .from('lng_visits')
        .select(
          `id, patient_id, status, arrival_type, opened_at,
           patient:patients (
             first_name, last_name, phone, email,
             internal_ref, avatar_data
           ),
           appointment:lng_appointments (
             event_type_label, intake, appointment_ref, jb_ref
           ),
           walk_in:lng_walk_ins (
             service_type, appliance_type, appointment_ref, jb_ref
           )`
        )
        .in('status', ['opened', 'in_progress'])
        .order('opened_at', { ascending: true });

      if (cancelled) return;
      if (vErr) {
        setError(vErr.message);
        setVisits([]);
        setLoading(false);
        return;
      }

      const rows = (rawVisits ?? []) as VisitsRowFromDb[];
      if (rows.length === 0) {
        setVisits([]);
        setLoading(false);
        return;
      }

      const visitIds = rows.map((r) => r.id);
      const patientIds = Array.from(new Set(rows.map((r) => r.patient_id)));

      // Step B + Step C — paid status and waiver context in parallel.
      const [paidRes, sectionsRes, signaturesRes] = await Promise.all([
        supabase
          .from('lng_visit_paid_status')
          .select('visit_id, amount_due_pence, amount_paid_pence, paid_status')
          .in('visit_id', visitIds),
        supabase
          .from('lng_waiver_sections')
          .select('key, title, terms, version, applies_to_service_type, sort_order, active')
          .eq('active', true)
          .order('sort_order', { ascending: true }),
        supabase
          .from('lng_waiver_signatures')
          .select('patient_id, section_key, section_version, signed_at')
          .in('patient_id', patientIds)
          .order('signed_at', { ascending: false }),
      ]);

      if (cancelled) return;

      // Index paid status by visit_id.
      const paidByVisit = new Map<string, PaidStatusRow>();
      if (!paidRes.error && paidRes.data) {
        for (const r of paidRes.data as PaidStatusRow[]) {
          paidByVisit.set(r.visit_id, r);
        }
      }

      // Waiver sections — tolerate missing table by treating as no
      // requirements rather than failing the whole board. Loud-fail
      // on any other error so we don't paper over real issues.
      let sections: WaiverSection[] = [];
      if (sectionsRes.error) {
        if (sectionsRes.error.code !== 'PGRST200' && sectionsRes.error.code !== '42P01') {
          setError(`Could not load waiver sections: ${sectionsRes.error.message}`);
          setLoading(false);
          return;
        }
      } else {
        sections = (sectionsRes.data ?? []) as WaiverSection[];
      }

      // Per-patient latest-signature map (by section_key). Rows come
      // ordered desc by signed_at, so the first one we see per
      // section_key is the latest.
      const sigsByPatient = new Map<string, Map<string, WaiverSignatureSummary>>();
      if (signaturesRes.error) {
        if (
          signaturesRes.error.code !== 'PGRST200' &&
          signaturesRes.error.code !== '42P01'
        ) {
          setError(`Could not load waiver signatures: ${signaturesRes.error.message}`);
          setLoading(false);
          return;
        }
      } else {
        for (const row of (signaturesRes.data ?? []) as SignatureRow[]) {
          let map = sigsByPatient.get(row.patient_id);
          if (!map) {
            map = new Map();
            sigsByPatient.set(row.patient_id, map);
          }
          if (!map.has(row.section_key)) {
            map.set(row.section_key, {
              section_key: row.section_key,
              section_version: row.section_version,
              signed_at: row.signed_at,
            });
          }
        }
      }

      // Compose enriched rows.
      const enriched: EnrichedActiveVisit[] = rows.map((r) => {
        const p = pickOne(r.patient);
        const a = pickOne(r.appointment);
        const w = pickOne(r.walk_in);

        const eventTypeLabel = a?.event_type_label ?? null;
        const intake = a?.intake ?? null;
        const serviceType = w?.service_type ?? null;
        const applianceType = w?.appliance_type ?? null;
        const appointmentRef = a?.appointment_ref ?? w?.appointment_ref ?? null;
        const jbRef = a?.jb_ref ?? w?.jb_ref ?? null;

        const bucket = bucketForVisit({
          event_type_label: eventTypeLabel,
          service_type: serviceType,
        });

        const descriptor = computeDescriptor({
          event_type_label: eventTypeLabel,
          intake,
          service_type: serviceType,
          appliance_type: applianceType,
        });

        const paid = paidByVisit.get(r.id);
        const sigs = sigsByPatient.get(r.patient_id) ?? new Map<string, WaiverSignatureSummary>();
        const waiverStatus = waiverStatusForVisit(
          { event_type_label: eventTypeLabel, service_type: serviceType },
          sections,
          sigs
        );

        const enrichedVisit: EnrichedActiveVisit = {
          id: r.id,
          patient_id: r.patient_id,
          status: r.status,
          arrival_type: r.arrival_type,
          opened_at: r.opened_at,
          patient_first_name: p?.first_name ?? null,
          patient_last_name: p?.last_name ?? null,
          patient_phone: p?.phone ?? null,
          patient_email: p?.email ?? null,
          patient_internal_ref: p?.internal_ref ?? null,
          patient_avatar_data: p?.avatar_data ?? null,
          event_type_label: eventTypeLabel,
          intake,
          appointment_ref: appointmentRef,
          jb_ref: jbRef,
          service_type: serviceType,
          appliance_type: applianceType,
          bucket,
          descriptor,
          // Searchable is computed last so it sees the final descriptor.
          searchable: '',
          amount_due_pence: paid?.amount_due_pence ?? null,
          amount_paid_pence: paid?.amount_paid_pence ?? 0,
          paid_status: paid?.paid_status ?? 'no_charge',
          payment_done:
            (paid?.paid_status ?? 'no_charge') === 'paid' ||
            (paid?.paid_status ?? 'no_charge') === 'no_charge',
          waiver_status: waiverStatus,
        };
        enrichedVisit.searchable = searchableTextForVisit(enrichedVisit);
        return enrichedVisit;
      });

      setVisits(enriched);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { visits, loading, error, refresh };
}

// Lightweight count hook for the bottom-nav badge. Polls on an interval
// (default 30 s) and refetches when the tab becomes visible again, so
// the receptionist sees the badge update without staring at the In
// clinic page. Returns null while loading or after an error so the
// caller can hide the badge until we have a confirmed number — never
// shows a stale or guessed value.
export function useActiveVisitCount(
  enabled: boolean = true,
  intervalMs: number = 30_000
): number | null {
  const [count, setCount] = useState<number | null>(null);
  const fetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      setCount(null);
      return;
    }
    let cancelled = false;

    async function fetchCount() {
      const { count: c, error } = await supabase
        .from('lng_visits')
        .select('id', { count: 'exact', head: true })
        .in('status', ['opened', 'in_progress']);
      if (cancelled) return;
      if (error) {
        console.warn('[useActiveVisitCount]', error.message);
        setCount(null);
        return;
      }
      setCount(c ?? 0);
    }

    fetchRef.current = () => void fetchCount();
    void fetchCount();
    // Polling stays as a backstop in case the Realtime channel drops
    // (network blip, sleeping tablet) — but realtime makes the badge
    // feel instant in the common case. The 30s tick reconciles
    // whatever might have been missed while the socket was down.
    const timer = setInterval(() => {
      void fetchCount();
    }, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchCount();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      fetchRef.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);

  // Push-based refresh on top of the polling. Status flips and new
  // arrivals all change either lng_visits or lng_appointments, so any
  // change to either nudges a refetch.
  useRealtimeRefresh(
    enabled ? [{ table: 'lng_visits' }, { table: 'lng_appointments' }] : [],
    () => fetchRef.current(),
  );

  return count;
}

// PostgREST sometimes returns single-row FK joins as an array of one,
// sometimes as the row itself. Normalise to a single value (or null).
function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

// Build the calendar-style descriptor. For booked visits we delegate
// to formatBookingSummary (the same helper used on the schedule).
// For walk-ins we synthesise an AppointmentRow-like shape from the
// service_type + appliance_type so the same helper produces the same
// wording everywhere ("Upper Whitening Trays" / "Snapped Denture").
function computeDescriptor(input: {
  event_type_label: string | null;
  intake: Array<{ question: string; answer: string }> | null;
  service_type: string | null;
  appliance_type: string | null;
}): string {
  if (input.event_type_label || input.intake) {
    const synthetic = {
      event_type_label: input.event_type_label,
      intake: input.intake,
    } as unknown as AppointmentRow;
    const summary = formatBookingSummary(synthetic);
    if (summary) return summary;
  }
  // Walk-in fallback: prefer appliance_type, then service_type, then
  // a generic "Walk-in" label so nothing reads blank.
  if (input.appliance_type) return input.appliance_type;
  if (input.service_type) {
    return WALK_IN_DISPLAY[input.service_type] ?? input.service_type;
  }
  return 'Walk-in';
}

const WALK_IN_DISPLAY: Record<string, string> = {
  denture_repair: 'Denture repair',
  same_day_appliance: 'Same-day appliance',
  click_in_veneers: 'Click-in veneers',
  impression_appointment: 'Impression appointment',
  other: 'Consultation',
};

// Re-export filterCareIntake so the test file can build realistic
// AppointmentRow-shaped inputs without a circular dep.
export { filterCareIntake };
