import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { logFailure } from '../failureLog.ts';

// The Ledger feed — every patient interaction at the lab in one
// list. Backed by the SQL view public.lng_ledger which unions
// lng_appointments and lng_walk_ins into a uniform shape so paging
// and sort happen server-side.
//
// The view exposes status, source, kind, event_at, ref + service
// label. Patient name + visit linkage are fetched separately by id
// after the page query lands — the view doesn't carry FK metadata
// PostgREST can use to embed.
//
// Search routing: the term is detected on the client, then sent to
// either the view (LAP ref → appointment_ref column) or the patients
// table (name / MP / email / phone → patient_id IN list). The
// patient-search pre-query mirrors applyPatientSearch in patients.ts
// so the matching rules are identical to the rest of the app.

export type LedgerKind = 'appointment' | 'walk_in';

// Union of every status either origin produces. Appointments use
// booked/arrived/in_progress/complete/no_show/cancelled/rescheduled;
// walk-ins inherit the visit status (arrived/in_chair/complete/
// unsuitable/ended_early). Some statuses overlap (arrived, complete);
// some are kind-specific.
export type LedgerStatus =
  | 'booked'
  | 'arrived'
  | 'in_progress'
  | 'in_chair'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled'
  | 'unsuitable'
  | 'ended_early';

export type LedgerSource = 'calendly' | 'native' | 'manual' | 'walk_in';

export interface LedgerRow {
  id: string;
  kind: LedgerKind;
  patient_id: string;
  event_at: string;
  end_at: string;
  status: LedgerStatus;
  source: LedgerSource;
  service_label: string | null;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_avatar_data: string | null;
  visit_id: string | null;
}

export const LEDGER_PAGE_SIZE = 50;

export interface LedgerFilters {
  statuses: readonly LedgerStatus[];
  sources: readonly LedgerSource[];
  fromDate: string | null;
  toDate: string | null;
  search: string;
}

interface Result {
  data: LedgerRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

interface RawLedgerRow {
  id: string;
  kind: LedgerKind;
  patient_id: string;
  event_at: string;
  end_at: string;
  status: LedgerStatus;
  source: LedgerSource;
  service_label: string | null;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
}

export function useLedger(
  filters: LedgerFilters,
  page: number = 0,
  limit: number = LEDGER_PAGE_SIZE,
): Result {
  const [data, setData] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const { loading, settle } = useStaleQueryLoading(`ledger|${page}|${limit}`);

  const filterKey = filtersToKey(filters);

  useEffect(() => {
    let cancelled = false;
    const trimmed = filters.search.trim();
    const timer = setTimeout(async () => {
      try {
        const startIdx = page * limit;
        const endIdx = startIdx + limit; // limit + 1 rows

        // Resolve any patient-axis search to a list of patient_ids
        // first, since the view can't embed patients via PostgREST.
        // Returns:
        //   • null  — no search applied (or LAP search; that one
        //             goes against the view directly)
        //   • [] / [...] — the patient IDs the term matched
        const patientIdGate = await resolvePatientGate(trimmed);
        if (cancelled) return;
        if (patientIdGate?.error) {
          await logFailure({
            source: 'useLedger.patient_gate',
            severity: 'error',
            message: patientIdGate.error,
            context: { search: trimmed },
          });
          setError(patientIdGate.error);
          settle();
          return;
        }
        // Empty match list = no rows possible. Short-circuit so we
        // don't ship an empty IN() clause that PostgREST rejects.
        if (patientIdGate?.ids && patientIdGate.ids.length === 0) {
          setData([]);
          setHasMore(false);
          setError(null);
          settle();
          return;
        }

        let q = supabase
          .from('lng_ledger')
          .select(
            'id, kind, patient_id, event_at, end_at, status, source, service_label, appointment_ref, cancel_reason, notes',
          );

        if (filters.statuses.length > 0) {
          q = q.in('status', [...filters.statuses]);
        }
        if (filters.sources.length > 0) {
          q = q.in('source', [...filters.sources]);
        }
        if (filters.fromDate) {
          q = q.gte('event_at', `${filters.fromDate}T00:00:00`);
        }
        if (filters.toDate) {
          q = q.lte('event_at', `${filters.toDate}T23:59:59.999`);
        }
        if (patientIdGate?.ids) {
          q = q.in('patient_id', patientIdGate.ids);
        }
        if (patientIdGate?.lapPattern) {
          q = q.ilike('appointment_ref', `%${patientIdGate.lapPattern}%`);
        }

        const { data: rows, error: err } = await q
          .order('event_at', { ascending: false })
          .range(startIdx, endIdx);

        if (cancelled) return;
        if (err) {
          await logFailure({
            source: 'useLedger.list',
            severity: 'error',
            message: err.message,
            context: {
              page,
              limit,
              statuses: [...filters.statuses],
              sources: [...filters.sources],
              fromDate: filters.fromDate,
              toDate: filters.toDate,
              search: trimmed,
            },
          });
          setError(err.message);
          settle();
          return;
        }

        const ledgerRows = (rows ?? []) as RawLedgerRow[];
        const visibleRows = ledgerRows.slice(0, limit);
        const patientIds = uniq(visibleRows.map((r) => r.patient_id));
        const apptIds = visibleRows.filter((r) => r.kind === 'appointment').map((r) => r.id);
        const walkInIds = visibleRows.filter((r) => r.kind === 'walk_in').map((r) => r.id);

        // Fetch patient identity in one round-trip. Embedding via
        // PostgREST isn't available here because the view lacks the
        // FK metadata, so this is a deliberate +1 round trip.
        const [patientsRes, visitsRes] = await Promise.all([
          patientIds.length > 0
            ? supabase
                .from('patients')
                .select('id, first_name, last_name, avatar_data')
                .in('id', patientIds)
            : Promise.resolve({ data: [], error: null }),
          apptIds.length > 0 || walkInIds.length > 0
            ? supabase
                .from('lng_visits')
                .select('id, appointment_id, walk_in_id')
                .or(buildVisitOr(apptIds, walkInIds))
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (cancelled) return;

        if (patientsRes.error) {
          await logFailure({
            source: 'useLedger.patients_lookup',
            severity: 'warning',
            message: patientsRes.error.message,
            context: { patientIdCount: patientIds.length },
          });
        }
        if (visitsRes.error) {
          await logFailure({
            source: 'useLedger.visits_lookup',
            severity: 'warning',
            message: visitsRes.error.message,
            context: { apptIdCount: apptIds.length, walkInIdCount: walkInIds.length },
          });
        }

        const patientById = new Map<
          string,
          { first_name: string | null; last_name: string | null; avatar_data: string | null }
        >();
        for (const p of (patientsRes.data ?? []) as Array<{
          id: string;
          first_name: string | null;
          last_name: string | null;
          avatar_data: string | null;
        }>) {
          patientById.set(p.id, {
            first_name: p.first_name,
            last_name: p.last_name,
            avatar_data: p.avatar_data,
          });
        }

        const visitByApptId = new Map<string, string>();
        const visitByWalkInId = new Map<string, string>();
        for (const v of (visitsRes.data ?? []) as Array<{
          id: string;
          appointment_id: string | null;
          walk_in_id: string | null;
        }>) {
          if (v.appointment_id) visitByApptId.set(v.appointment_id, v.id);
          if (v.walk_in_id) visitByWalkInId.set(v.walk_in_id, v.id);
        }

        const mapped: LedgerRow[] = visibleRows.map((r) => {
          const patient = patientById.get(r.patient_id) ?? null;
          const visitId =
            r.kind === 'appointment'
              ? visitByApptId.get(r.id) ?? null
              : visitByWalkInId.get(r.id) ?? null;
          return {
            id: r.id,
            kind: r.kind,
            patient_id: r.patient_id,
            event_at: r.event_at,
            end_at: r.end_at,
            status: r.status,
            source: r.source,
            service_label: r.service_label,
            appointment_ref: r.appointment_ref,
            cancel_reason: r.cancel_reason,
            notes: r.notes,
            patient_first_name: patient?.first_name ?? null,
            patient_last_name: patient?.last_name ?? null,
            patient_avatar_data: patient?.avatar_data ?? null,
            visit_id: visitId,
          };
        });

        setHasMore(ledgerRows.length > limit);
        setData(mapped);
        setError(null);
        settle();
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load the ledger';
        await logFailure({
          source: 'useLedger.unhandled',
          severity: 'error',
          message,
          context: {
            page,
            limit,
            statuses: [...filters.statuses],
            sources: [...filters.sources],
            fromDate: filters.fromDate,
            toDate: filters.toDate,
          },
        });
        setError(message);
        settle();
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, filterKey]);

  return { data, loading, error, hasMore };
}

function filtersToKey(f: LedgerFilters): string {
  return [
    f.statuses.join(','),
    f.sources.join(','),
    f.fromDate ?? '',
    f.toDate ?? '',
    f.search.trim(),
  ].join('|');
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function buildVisitOr(apptIds: string[], walkInIds: string[]): string {
  // PostgREST OR for the visits lookup: appointment_id IN (...) OR
  // walk_in_id IN (...). When one side is empty we drop its clause
  // so PostgREST doesn't reject an empty IN().
  const parts: string[] = [];
  if (apptIds.length > 0) parts.push(`appointment_id.in.(${apptIds.join(',')})`);
  if (walkInIds.length > 0) parts.push(`walk_in_id.in.(${walkInIds.join(',')})`);
  return parts.join(',');
}

// ─────────────────────────────────────────────────────────────────────────────
// Search detection — turns a free-text term into either:
//   • a list of patient IDs (so the ledger query filters by IN list)
//   • a LAP ref pattern (so the ledger query ilike's appointment_ref)
//   • null (no search applied)
//
// LAP refs live on the parent (view's appointment_ref column); every
// other axis (name / MP / email / phone) lives on patients which the
// view doesn't embed, hence the pre-query.
// ─────────────────────────────────────────────────────────────────────────────

interface PatientGate {
  ids?: string[];
  lapPattern?: string;
  error?: string;
}

async function resolvePatientGate(term: string): Promise<PatientGate | null> {
  const cleaned = term.trim();
  if (!cleaned) return null;
  if (cleaned.length < 2) return null;

  // LAP — search the view directly via appointment_ref.
  if (/^lap/i.test(cleaned)) {
    return { lapPattern: escapeIlike(cleaned) };
  }

  // Patient-axis searches: pre-query patients, return ID list. The
  // route ANDs that with the view filters via .in('patient_id', …).
  let q = supabase.from('patients').select('id');

  if (/^mp/i.test(cleaned)) {
    q = q.ilike('internal_ref', `%${escapeIlike(cleaned)}%`);
  } else if (cleaned.includes('@')) {
    q = q.ilike('email', `%${escapeIlike(cleaned)}%`);
  } else {
    const phoneDigits = cleaned.replace(/\D/g, '');
    const isPhone =
      phoneDigits.length >= 7 &&
      phoneDigits.length <= 15 &&
      /^[\d\s+()\-]+$/.test(cleaned);
    if (isPhone) {
      q = q.ilike('phone', `%${phoneDigits}%`);
    } else {
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        for (const word of words.slice(0, 4)) {
          const w = escapeOr(word);
          q = q.or(
            `first_name.ilike.%${w}%,last_name.ilike.%${w}%,email.ilike.%${w}%,internal_ref.ilike.%${w}%`,
          );
        }
      } else {
        const w = escapeOr(words[0]!);
        const orParts = [
          `last_name.ilike.%${w}%`,
          `first_name.ilike.%${w}%`,
          `email.ilike.%${w}%`,
          `internal_ref.ilike.%${w}%`,
        ];
        if (phoneDigits.length >= 4) {
          orParts.push(`phone.ilike.%${phoneDigits}%`);
        }
        q = q.or(orParts.join(','));
      }
    }
  }

  // Cap the gate list size so a sloppy search ("a") doesn't pull
  // every patient in the system. 500 IDs comfortably covers any
  // realistic match while keeping the IN() clause manageable.
  const { data, error } = await q.limit(500);
  if (error) return { error: error.message };
  return { ids: ((data ?? []) as Array<{ id: string }>).map((r) => r.id) };
}

function escapeIlike(s: string): string {
  // ILIKE itself is unescaped; we just guard against PostgREST's URL
  // separator (commas, parens) leaking into the value.
  return s.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function escapeOr(s: string): string {
  return s.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers used by the route
// ─────────────────────────────────────────────────────────────────────────────

export function humaniseLedgerStatus(status: LedgerStatus): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
    case 'in_chair':
      return 'In chair';
    case 'complete':
      return 'Complete';
    case 'no_show':
      return 'No-show';
    case 'cancelled':
      return 'Cancelled';
    case 'rescheduled':
      return 'Rescheduled';
    case 'unsuitable':
      return 'Unsuitable';
    case 'ended_early':
      return 'Ended early';
    default:
      return status;
  }
}

export function humaniseLedgerSource(source: LedgerSource): string {
  switch (source) {
    case 'calendly':
      return 'Calendly';
    case 'native':
      return 'Native';
    case 'manual':
      return 'Manually added';
    case 'walk_in':
      return 'Walk-in';
    default:
      return source;
  }
}
