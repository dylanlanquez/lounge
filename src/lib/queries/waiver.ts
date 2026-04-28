import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// One row in lng_waiver_sections. Admin-editable.
export interface WaiverSection {
  key: string;
  title: string;
  terms: string[];
  version: string;
  applies_to_service_type: 'denture_repair' | 'same_day_appliance' | 'click_in_veneers' | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        setLoading(false);
        return;
      }
      setSections((data ?? []) as WaiverSection[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        setLoading(false);
        return;
      }
      const map = new Map<string, WaiverSignatureSummary>();
      for (const row of (data ?? []) as WaiverSignatureSummary[]) {
        // Rows come ordered by signed_at desc. First one we see per
        // section_key is the latest; later ones are older snapshots.
        if (!map.has(row.section_key)) map.set(row.section_key, row);
      }
      setLatest(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, tick]);

  return { latest, loading, error, refresh };
}

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
export function inferServiceTypeFromEventLabel(label: string | null): string | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(l)) return 'denture_repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(l)) return 'click_in_veneers';
  if (/same[\s-]?day\s+appliance|appliance|impression|aligner|retainer|guard|whitening/i.test(l))
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

// ---------- Sign a waiver (used by phase A2) ----------

export interface SignWaiverInput {
  patient_id: string;
  visit_id: string | null;
  section: WaiverSection;
  signature_svg: string;
}

export async function signWaiver(input: SignWaiverInput): Promise<void> {
  // Resolve the signed-in receptionist's accounts.id via the standard
  // RPC (the auth user id is *not* the same as accounts.id; witnessed_by
  // references the latter). null is acceptable when no staff is signed
  // in — e.g. patient self-sign on a kiosk in future.
  const { data: accountId } = await supabase.rpc('auth_account_id');
  const { error } = await supabase.from('lng_waiver_signatures').insert({
    patient_id: input.patient_id,
    visit_id: input.visit_id,
    section_key: input.section.key,
    section_version: input.section.version,
    signature_svg: input.signature_svg,
    witnessed_by: (accountId as string | null) ?? null,
    // Snapshot the terms at sign time so future audit can reproduce the
    // exact agreement even if the section row is later edited.
    terms_snapshot: input.section.terms,
  });
  if (error) throw new Error(error.message);
}
