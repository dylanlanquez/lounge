import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';
import { logFailure } from '../failureLog.ts';
import type { AppointmentSource } from './appointments.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

// Appointment History — single-screen view of every booking the
// clinic has ever taken, regardless of outcome (booked, arrived,
// in-progress, complete, no-show, cancelled, rescheduled). Mirrors
// the Patients list pattern: paged, filterable, search-by-name.
//
// Reads from lng_appointments (Calendly + native + manually-added
// rows). Walk-ins are deliberately excluded for v1 — they live as
// visit rows and don't have the same booked→cancelled lifecycle a
// scheduled appointment does. Walk-ins can be folded in later if
// the receptionist team wants the unified view.

export const APPOINTMENT_HISTORY_PAGE_SIZE = 50;

export interface AppointmentHistoryFilters {
  // Empty array = no status filter (all statuses returned).
  statuses: readonly AppointmentStatus[];
  // Empty array = no source filter.
  sources: readonly AppointmentSource[];
  // YYYY-MM-DD strings; nullable. Both null = no date filter. Inclusive
  // on both ends — toDate is widened to end-of-day server-side.
  fromDate: string | null;
  toDate: string | null;
  // Free-text patient name search; trimmed in the query.
  search: string;
}

export interface AppointmentHistoryRow {
  id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  event_type_label: string | null;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  patient_id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_avatar_data: string | null;
  visit_id: string | null;
}

interface Result {
  data: AppointmentHistoryRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

interface RawPatient {
  first_name: string | null;
  last_name: string | null;
  avatar_data: string | null;
}

interface RawAppointmentRow {
  id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  event_type_label: string | null;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  patient_id: string;
  // PostgREST returns embedded relations as either an object or an
  // array depending on the join shape; normalise at the cast site.
  patient: RawPatient | RawPatient[] | null;
}

export function useAppointmentHistory(
  filters: AppointmentHistoryFilters,
  page: number = 0,
  limit: number = APPOINTMENT_HISTORY_PAGE_SIZE,
): Result {
  const [data, setData] = useState<AppointmentHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Page-as-key keeps prior results visible while the next request
  // runs — mirrors the Patients list. Filter changes share the same
  // key so re-typing search doesn't blank the surface.
  const { loading, settle } = useStaleQueryLoading(`appt-history|${page}|${limit}`);

  const filterKey = filtersToKey(filters);

  useEffect(() => {
    let cancelled = false;
    const trimmed = filters.search.trim();
    const timer = setTimeout(async () => {
      try {
        const startIdx = page * limit;
        const endIdx = startIdx + limit; // limit + 1 rows

        let q = supabase
          .from('lng_appointments')
          .select(
            'id, start_at, end_at, status, source, event_type_label, appointment_ref, cancel_reason, notes, patient_id, patient:patients!inner ( first_name, last_name, avatar_data )',
          );

        if (filters.statuses.length > 0) {
          q = q.in('status', [...filters.statuses]);
        }
        if (filters.sources.length > 0) {
          q = q.in('source', [...filters.sources]);
        }
        if (filters.fromDate) {
          q = q.gte('start_at', `${filters.fromDate}T00:00:00`);
        }
        if (filters.toDate) {
          q = q.lte('start_at', `${filters.toDate}T23:59:59.999`);
        }
        if (trimmed.length >= 2) {
          q = applyAppointmentSearch(q, trimmed);
        }

        const { data: rows, error: err } = await q
          .order('start_at', { ascending: false })
          .range(startIdx, endIdx);

        if (cancelled) return;
        if (err) {
          // Loud + logged. Receptionists see ErrorPanel; ops see the
          // structured row with the filter shape that broke so they
          // can reproduce.
          await logFailure({
            source: 'useAppointmentHistory.list',
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

        const apptRows = (rows ?? []) as unknown as RawAppointmentRow[];

        // Look up linked visits in one round-trip so the row click can
        // route to /visit/:id when the appointment was actually
        // attended. Appointments without a visit (cancelled before
        // arrival, no-show) get visit_id = null.
        const apptIds = apptRows.map((r) => r.id);
        const visitMap = new Map<string, string>();
        if (apptIds.length > 0) {
          const { data: visits, error: visitErr } = await supabase
            .from('lng_visits')
            .select('id, appointment_id')
            .in('appointment_id', apptIds);
          if (cancelled) return;
          if (visitErr) {
            // Visit lookup failure is non-fatal — the page still renders
            // every appointment, the click-through just falls back to
            // the patient profile until ops fixes it. Log the failure
            // so the silent "everything goes to profile" symptom has a
            // structured trace.
            await logFailure({
              source: 'useAppointmentHistory.visits',
              severity: 'warning',
              message: visitErr.message,
              context: { appointmentIdCount: apptIds.length },
            });
          } else {
            for (const v of (visits ?? []) as Array<{ id: string; appointment_id: string }>) {
              visitMap.set(v.appointment_id, v.id);
            }
          }
        }

        const mapped: AppointmentHistoryRow[] = apptRows.slice(0, limit).map((r) => {
          const p = Array.isArray(r.patient) ? r.patient[0] ?? null : r.patient;
          return {
            id: r.id,
            start_at: r.start_at,
            end_at: r.end_at,
            status: r.status,
            source: r.source,
            event_type_label: r.event_type_label,
            appointment_ref: r.appointment_ref,
            cancel_reason: r.cancel_reason,
            notes: r.notes,
            patient_id: r.patient_id,
            patient_first_name: p?.first_name ?? null,
            patient_last_name: p?.last_name ?? null,
            patient_avatar_data: p?.avatar_data ?? null,
            visit_id: visitMap.get(r.id) ?? null,
          };
        });

        setHasMore(apptRows.length > limit);
        setData(mapped);
        setError(null);
        settle();
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load appointments';
        // Catch-all path: a client-side throw (parse failure, network
        // hiccup that bypasses Supabase's structured error). Same
        // logging shape as the err branch above so triage works the
        // same regardless of where the failure surfaced.
        await logFailure({
          source: 'useAppointmentHistory.unhandled',
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

// Stable string key for the filters object so the effect dep list
// stays primitive. Re-rendering with the same filter values does not
// re-run the query — only a real change does.
function filtersToKey(f: AppointmentHistoryFilters): string {
  return [
    f.statuses.join(','),
    f.sources.join(','),
    f.fromDate ?? '',
    f.toDate ?? '',
    f.search.trim(),
  ].join('|');
}

// Search across the surfaces a receptionist actually types into the
// box: patient name (first / last), MP ref (patients.internal_ref),
// email, phone (digit-tolerant, dial-pad characters allowed), and
// the appointment-level LAP ref on lng_appointments. Mirrors the
// shape of applyPatientSearch in patients.ts so the matching rules
// are predictable across the app — the only thing different here is
// that the LAP ref lives on the parent row, not the embedded
// patients relation, so it gets its own column filter.
//
// PostgREST OR groups can't span parent + foreign columns in a single
// query, so we detect what the term LOOKS like and route to the
// right surface:
//
//   • "LAP" / "lap-NNN" → parent appointment_ref
//   • "MP"  / "mp-NNN"  → embedded patients.internal_ref
//   • contains "@"      → embedded patients.email
//   • mostly digits     → embedded patients.phone (digit-stripped)
//   • else              → embedded patients name+email+ref OR group
//
// `q` is the lng_appointments select chain; we return the chain so
// the caller can keep adding filters / order / range.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAppointmentSearch<Q extends { ilike: any; or: any }>(q: Q, term: string): Q {
  const cleaned = term.trim();
  if (!cleaned) return q;

  // LAP — appointment-level ref on the parent row.
  if (/^lap/i.test(cleaned)) {
    return q.ilike('appointment_ref', `%${escapeOr(cleaned)}%`);
  }

  // MP — patient-level ref on the embedded patients row.
  if (/^mp/i.test(cleaned)) {
    return q.or(`internal_ref.ilike.%${escapeOr(cleaned)}%`, { foreignTable: 'patients' });
  }

  // Email — anything with an @ goes straight to patients.email.
  if (cleaned.includes('@')) {
    return q.or(`email.ilike.%${escapeOr(cleaned)}%`, { foreignTable: 'patients' });
  }

  // Phone — entirely dial-pad characters with at least 7 digits.
  // Strip non-digits before matching so "07700 900123" finds the
  // canonical "07700900123" and the partial "0770" still works once
  // it's long enough to filter to a sensible result set.
  const phoneDigits = cleaned.replace(/\D/g, '');
  const isPhone =
    phoneDigits.length >= 7 &&
    phoneDigits.length <= 15 &&
    /^[\d\s+()\-]+$/.test(cleaned);
  if (isPhone) {
    return q.or(`phone.ilike.%${phoneDigits}%`, { foreignTable: 'patients' });
  }

  // Multi-word: tokenise and AND each token across name+email+ref so
  // "James Smi" matches first_name=James AND last_name=Smith. Chained
  // .or()s sit at the top level, which PostgREST treats as AND.
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    let out = q;
    for (const word of words.slice(0, 4)) {
      const w = escapeOr(word);
      out = out.or(
        `first_name.ilike.%${w}%,last_name.ilike.%${w}%,email.ilike.%${w}%,internal_ref.ilike.%${w}%`,
        { foreignTable: 'patients' },
      );
    }
    return out;
  }

  // Single token: OR across name+email+ref. Add a phone-fragment
  // match when there are enough digits (4+) to avoid false positives
  // from a short numeric search ("9" wouldn't filter usefully).
  const w = escapeOr(words[0]!);
  const orParts: string[] = [
    `last_name.ilike.%${w}%`,
    `first_name.ilike.%${w}%`,
    `email.ilike.%${w}%`,
    `internal_ref.ilike.%${w}%`,
  ];
  if (phoneDigits.length >= 4) {
    orParts.push(`phone.ilike.%${phoneDigits}%`);
  }
  return q.or(orParts.join(','), { foreignTable: 'patients' });
}

// PostgREST OR-string escapes — commas and parens are syntactic.
function escapeOr(s: string): string {
  return s.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
