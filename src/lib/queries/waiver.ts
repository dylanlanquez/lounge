import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useRealtimeRefresh } from '../useRealtimeRefresh.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

// One row in lng_waiver_sections. Admin-editable.
export interface WaiverSection {
  key: string;
  title: string;
  terms: string[];
  version: string;
  applies_to_service_type:
    | 'denture_repair'
    | 'same_day_appliance'
    | 'click_in_veneers'
    | 'impression_appointment'
    | null;
  sort_order: number;
  active: boolean;
}

// Latest signature for a single (patient, section) pair. Used to decide
// whether the section is up-to-date relative to its current version.
export interface WaiverSignatureSummary {
  section_key: string;
  section_version: string;
  signed_at: string;
}

interface SectionsResult {
  sections: WaiverSection[];
  loading: boolean;
  error: string | null;
}

export function useWaiverSections(): SectionsResult {
  const [sections, setSections] = useState<WaiverSection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, settle } = useStaleQueryLoading('waiver-sections');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_waiver_sections')
        .select('key, title, terms, version, applies_to_service_type, sort_order, active')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        // Pre-migration: treat as empty rather than crash, so the schedule
        // still renders without a flag.
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setSections([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      setSections((data ?? []) as WaiverSection[]);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [settle]);

  return { sections, loading, error };
}

// Fetches the latest signature per section for a patient. Used to compute
// the up-to-date / stale / never-signed state on arrival.
interface PatientWaiverStateResult {
  latest: Map<string, WaiverSignatureSummary>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePatientWaiverState(patientId: string | null | undefined): PatientWaiverStateResult {
  const [latest, setLatest] = useState<Map<string, WaiverSignatureSummary>>(new Map());
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
      const { data, error: err } = await supabase
        .from('lng_waiver_signatures')
        .select('section_key, section_version, signed_at')
        .eq('patient_id', patientId)
        .order('signed_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setLatest(new Map());
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const map = new Map<string, WaiverSignatureSummary>();
      for (const row of (data ?? []) as WaiverSignatureSummary[]) {
        // Rows come ordered by signed_at desc. First one we see per
        // section_key is the latest; later ones are older snapshots.
        if (!map.has(row.section_key)) map.set(row.section_key, row);
      }
      setLatest(map);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // Auto-refresh on any new signature for this patient — used by the
  // pencil-shortcut signing flow and any future cross-device kiosk
  // session signing the same waiver elsewhere.
  useRealtimeRefresh(
    patientId ? [{ table: 'lng_waiver_signatures', filter: `patient_id=eq.${patientId}` }] : [],
    refresh,
  );

  return { latest, loading, error, refresh };
}

// One row out of lng_waiver_signatures, joined to its section + witness
// account so the patient profile can render the full history without an
// N+1.
export interface SignedWaiverRow {
  id: string;
  section_key: string;
  section_title: string | null;
  section_version: string;
  signed_at: string;
  signature_svg: string;
  terms_snapshot: string[] | null;
  witness_name: string | null;
  visit_id: string | null;
}

interface SignedWaiversResult {
  rows: SignedWaiverRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Full signature history for one patient, ordered newest first. Used by
// the patient profile's "Signed waivers" table — supports download +
// print of each individual signing event.
export function useSignedWaivers(patientId: string | null | undefined): SignedWaiversResult {
  const [rows, setRows] = useState<SignedWaiverRow[]>([]);
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
      // Inner-join to lng_waiver_sections so we always have a title to
      // print, even for sections that admin has since deactivated.
      // witness_name is the column-level witness captured at sign time
      // (migration 20260430000006). The account-side join stays as a
      // fallback for any historical row whose witness_name didn't get
      // backfilled — pre-migration deploys also fall back to it.
      const { data, error: err } = await supabase
        .from('lng_waiver_signatures')
        .select(
          `id, section_key, section_version, signed_at, signature_svg, terms_snapshot, visit_id, witness_name,
           section:section_key(title),
           witness:witnessed_by(first_name, last_name)`
        )
        .eq('patient_id', patientId)
        .order('signed_at', { ascending: false });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        settle();
        return;
      }
      const mapped: SignedWaiverRow[] = ((data ?? []) as Array<Record<string, unknown>>).map(
        (r) => {
          const section = (r.section as { title?: string } | null) ?? null;
          const witness =
            (r.witness as { first_name?: string; last_name?: string } | null) ?? null;
          const accountWitnessName = witness
            ? `${witness.first_name ?? ''} ${witness.last_name ?? ''}`.trim() || null
            : null;
          const explicitWitness = (r.witness_name as string | null) ?? null;
          const witnessName = explicitWitness?.trim() || accountWitnessName;
          const termsSnapshot = r.terms_snapshot;
          return {
            id: r.id as string,
            section_key: r.section_key as string,
            section_title: section?.title ?? null,
            section_version: r.section_version as string,
            signed_at: r.signed_at as string,
            signature_svg: r.signature_svg as string,
            terms_snapshot: Array.isArray(termsSnapshot)
              ? (termsSnapshot as string[])
              : null,
            witness_name: witnessName,
            visit_id: (r.visit_id as string | null) ?? null,
          };
        }
      );
      setRows(mapped);
      settle();
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick, settle]);

  // History list refreshes whenever a new signature lands for this
  // patient — keeps the audit table on PatientProfile current without
  // a manual reload.
  useRealtimeRefresh(
    patientId ? [{ table: 'lng_waiver_signatures', filter: `patient_id=eq.${patientId}` }] : [],
    refresh,
  );

  return { rows, loading, error, refresh };
}

// (No useVisitWaiverSignatures hook here. Waivers are patient-scoped:
// a signature signed at any visit stays valid for every subsequent
// visit until the section's version bumps. Surfaces that need the
// signed paperwork for a given visit (View Waiver dialog) read
// useSignedWaivers(patient.id) and pair the rows up to the visit's
// requiredSections client-side.)

// ---------- Pure section-resolution helpers ----------
//
// Required-sections logic is deliberately extracted from the React hooks
// so it can be unit-tested without DOM. The schedule's BottomSheet wants
// to know "which sections must this patient have signed for this booking?"
// before the visit / cart even exists — the answer comes from the
// appointment's intake + event_type. After arrival, the answer comes from
// the cart's actual line items.

// Given a list of catalogue service_types (one per cart item), returns
// the unique section keys that are required. The 'general' section
// (applies_to_service_type=null) is always included.
export function requiredSectionsForServiceTypes(
  serviceTypes: Array<string | null | undefined>,
  sections: WaiverSection[]
): WaiverSection[] {
  const presentTypes = new Set(serviceTypes.filter((s): s is string => !!s));
  const required: WaiverSection[] = [];
  for (const sec of sections) {
    if (!sec.active) continue;
    if (sec.applies_to_service_type === null) {
      required.push(sec);
    } else if (presentTypes.has(sec.applies_to_service_type)) {
      required.push(sec);
    }
  }
  return required.sort((a, b) => a.sort_order - b.sort_order);
}

// Maps a Calendly event-type label to a likely service_type. Mirrors the
// inference in CataloguePicker so a pre-arrival flag works. Falls back to
// null when the label is ambiguous; in that case only 'general' applies.
//
// Order of checks matters: "impression" is tested first so a label
// like "In-person Impression Appointment for Whitening Trays" maps
// to the impression_appointment waiver (which covers the act of
// capturing the impression), not the same_day_appliance waiver
// (which covers the finished appliance). Patients sign the appliance
// waiver later at collection.
export function inferServiceTypeFromEventLabel(label: string | null): string | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/impression/i.test(l)) return 'impression_appointment';
  if (/denture\s+repair|repair/i.test(l)) return 'denture_repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(l)) return 'click_in_veneers';
  if (/same[\s-]?day\s+appliance|appliance|aligner|retainer|guard|whitening/i.test(l))
    return 'same_day_appliance';
  return null;
}

// Decides whether a given section is signed up-to-date for this patient.
//   'current' — patient has a signature at the current section.version
//   'stale'   — patient has signed but the version has moved on
//   'missing' — patient has never signed this section
export type SectionSignatureState = 'current' | 'stale' | 'missing';

export function sectionSignatureState(
  section: WaiverSection,
  latest: Map<string, WaiverSignatureSummary>
): SectionSignatureState {
  const sig = latest.get(section.key);
  if (!sig) return 'missing';
  if (sig.section_version !== section.version) return 'stale';
  return 'current';
}

// Compose a summary across the required sections so the BottomSheet
// banner shows the right copy:
//   'ready'   — every required section is current
//   'partial' — at least one missing or stale, at least one current
//   'none'    — nothing signed (or no required sections found)
//   'stale'   — signed before but at least one section needs re-signing
export interface WaiverFlag {
  status: 'ready' | 'partial' | 'stale' | 'none';
  missingSections: WaiverSection[];
  staleSections: WaiverSection[];
}

export function summariseWaiverFlag(
  required: WaiverSection[],
  latest: Map<string, WaiverSignatureSummary>
): WaiverFlag {
  const missing: WaiverSection[] = [];
  const stale: WaiverSection[] = [];
  for (const sec of required) {
    const state = sectionSignatureState(sec, latest);
    if (state === 'missing') missing.push(sec);
    else if (state === 'stale') stale.push(sec);
  }
  const currentCount = required.length - missing.length - stale.length;

  if (missing.length === 0 && stale.length === 0) {
    return { status: 'ready', missingSections: [], staleSections: [] };
  }
  // Everything is missing — nothing has been signed yet.
  if (currentCount === 0 && stale.length === 0) {
    return { status: 'none', missingSections: missing, staleSections: stale };
  }
  // Everything is signed at least once, but every signature is at an
  // older version. Receptionist sees "needs re-signing".
  if (currentCount === 0 && missing.length === 0) {
    return { status: 'stale', missingSections: missing, staleSections: stale };
  }
  // Anything else is a mix — some current, some not. Treat as partial.
  return { status: 'partial', missingSections: missing, staleSections: stale };
}

// ---------- Admin: list / upsert all sections (active + inactive) ----------

interface AdminSectionsResult {
  sections: WaiverSection[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Admin variant of useWaiverSections — returns inactive sections too so
// legal can re-enable them, and is refreshable after edits land.
export function useAdminWaiverSections(): AdminSectionsResult {
  const [sections, setSections] = useState<WaiverSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_waiver_sections')
        .select('key, title, terms, version, applies_to_service_type, sort_order, active')
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setSections([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      setSections((data ?? []) as WaiverSection[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { sections, loading, error, refresh };
}

export interface WaiverSectionDraft {
  key: string;
  title: string;
  terms: string[];
  version: string;
  applies_to_service_type: WaiverSection['applies_to_service_type'];
  sort_order: number;
  active: boolean;
}

// Upsert a section. key is the primary key — pass the same key to update,
// a new key to insert. Existing signatures are unaffected (terms_snapshot
// captured the text at sign time).
export async function upsertWaiverSection(draft: WaiverSectionDraft): Promise<void> {
  const cleaned = draft.terms.map((t) => t.trim()).filter((t) => t.length > 0);
  const { error } = await supabase
    .from('lng_waiver_sections')
    .upsert(
      {
        key: draft.key.trim(),
        title: draft.title.trim(),
        terms: cleaned,
        version: draft.version.trim(),
        applies_to_service_type: draft.applies_to_service_type,
        sort_order: draft.sort_order,
        active: draft.active,
      },
      { onConflict: 'key' }
    );
  if (error) throw new Error(error.message);
}

// Suggest the next version string given the current one. Format:
// 'YYYY-MM-DD-vN'. If today's date already appears, increment the suffix;
// otherwise reset to v1 under today's date. Falls back to today + v1 when
// the current version doesn't match the convention.
export function suggestNextVersion(current: string, today: Date = new Date()): string {
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const m = current.match(/^(\d{4}-\d{2}-\d{2})-v(\d+)$/);
  if (m && m[1] === todayStr) {
    const n = parseInt(m[2]!, 10) || 1;
    return `${todayStr}-v${n + 1}`;
  }
  return `${todayStr}-v1`;
}

// ---------- Sign a waiver (used by phase A2) ----------

export interface SignWaiverInput {
  patient_id: string;
  visit_id: string | null;
  section: WaiverSection;
  signature_svg: string;
  // Free-text name of the staff member witnessing this signature.
  // Persisted on lng_waiver_signatures.witness_name so the audit row
  // owns the witness name verbatim, independent of the auth account
  // (witnessed_by). null is accepted (kiosk self-sign or pre-witness
  // deploys) and reads as 'not recorded' downstream.
  witness_name: string | null;
}

export async function signWaiver(input: SignWaiverInput): Promise<void> {
  // Resolve the signed-in receptionist's accounts.id via the standard
  // RPC (the auth user id is *not* the same as accounts.id; witnessed_by
  // references the latter). null is acceptable when no staff is signed
  // in — e.g. patient self-sign on a kiosk in future.
  const { data: accountId } = await supabase.rpc('auth_account_id');
  const trimmedWitness = input.witness_name?.trim() ?? '';
  const { error } = await supabase.from('lng_waiver_signatures').insert({
    patient_id: input.patient_id,
    visit_id: input.visit_id,
    section_key: input.section.key,
    section_version: input.section.version,
    signature_svg: input.signature_svg,
    witnessed_by: (accountId as string | null) ?? null,
    witness_name: trimmedWitness.length > 0 ? trimmedWitness : null,
    // Snapshot the terms at sign time so future audit can reproduce the
    // exact agreement even if the section row is later edited.
    terms_snapshot: input.section.terms,
  });
  if (error) throw new Error(error.message);
}
