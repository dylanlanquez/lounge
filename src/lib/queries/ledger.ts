import { useEffect, useRef, useState } from 'react';
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
// booked / arrived / complete / no_show / cancelled / rescheduled.
// Walk-ins inherit the visit status (arrived / complete / unsuitable /
// ended_early). Some statuses overlap (arrived, complete); some are
// kind-specific. The 'in_chair' (visits) and 'in_progress'
// (appointments) values were retired in 20260505 once we confirmed
// neither transition was used in practice — once a patient is marked
// arrived they're effectively in the chair, and the appointment
// "in_progress" was a dead enum value never written by any code path.
export type LedgerStatus =
  | 'booked'
  | 'arrived'
  | 'joined'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled'
  | 'unsuitable'
  | 'ended_early'
  // UI-only pseudo-status (never emitted by the lng_ledger view). A
  // "Draft" is a retail Quick Sale that's been started but not paid —
  // i.e. service_type='retail' AND status='arrived'. Used by the Status
  // filter and the row label; the query translates it specially.
  | 'draft';

export type LedgerSource = 'calendly' | 'native' | 'manual' | 'walk_in';

// created_via is a finer-grained origin signal than `source`. Two
// bookings can both be source='native' but have different
// created_via values: Checkpoint's ScanView booking flow writes
// created_via='checkpoint' while the public widget leaves it null.
// The walk-in marker rows use 'walk_in'. Used by the Ledger row to
// pick the right pill label + SourceGlyph so a Checkpoint booking
// reads identically to the AppointmentDetail hero.
export type LedgerCreatedVia = 'checkpoint' | 'walk_in' | null;

export type LedgerServiceType =
  | 'denture_repair'
  | 'impression_appointment'
  | 'virtual_impression_appointment'
  | 'voice_call'
  | 'same_day_appliance'
  | 'click_in_veneers'
  // Retail Quick Sale — the walk-in's service_type. Routes the ledger
  // row to /sale/:visit_id and renders as "Retail sale".
  | 'retail'
  | 'other';

// Payment axis derived by the lng_ledger view. Four values:
//   • 'paid'         — the cart for this row's visit is paid in full.
//   • 'deposit_paid' — booking deposit received but cart not (yet)
//                      settled in full. Distinct from 'paid' so the
//                      operator never confuses a £25 booking deposit
//                      with a £200 visit being settled in full.
//   • 'refunded'     — cart was voided post-payment.
//   • 'unpaid'       — no money received yet.
// Migration: 20260505000002_lng_ledger_deposit_paid.sql.
export type LedgerPaymentState = 'paid' | 'deposit_paid' | 'unpaid' | 'refunded';

// Refund axis, derived in 20260519000011_lng_ledger_refund_state.sql.
// Lives alongside payment_state — Ledger rows surface refund_state
// as a pill that DISPLACES the payment_state pill when non-'none'
// (so a partially-refunded paid-in-full visit reads "Partially
// refunded £30", not "Paid in full + Partially refunded"). Filter
// chips expose 'partial' and 'full' as two independent selections
// so staff can find just-partials or just-fulls.
export type LedgerRefundState = 'none' | 'partial' | 'full';

// Fulfilment axis — present once a visit is marked complete. Mirrors
// lng_visits.fulfilment_method; null on every ledger row that hasn't
// reached completion (booked, no_show, cancelled, in-progress). The
// view (lng_ledger) projects it via migration 20260512000010.
export type LedgerFulfilmentMethod = 'in_person' | 'shipping';

export interface LedgerRow {
  id: string;
  kind: LedgerKind;
  patient_id: string;
  event_at: string;
  end_at: string;
  status: LedgerStatus;
  source: LedgerSource;
  created_via: LedgerCreatedVia;
  service_label: string | null;
  service_type: LedgerServiceType | null;
  product_key: string | null;
  repair_variant: string | null;
  arch: string | null;
  brand_id: string | null;
  paid_in_full_at_booking: boolean;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  payment_state: LedgerPaymentState;
  refund_state: LedgerRefundState;
  refunded_pence: number;
  fulfilment_method: LedgerFulfilmentMethod | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_avatar_data: string | null;
  visit_id: string | null;
}

export const LEDGER_PAGE_SIZE = 50;

export interface LedgerFilters {
  statuses: readonly LedgerStatus[];
  serviceTypes: readonly LedgerServiceType[];
  paymentStates: readonly LedgerPaymentState[];
  // Refund axis. Selecting 'partial' or 'full' adds a refund_state
  // constraint to the query; selecting both reads as "any refund".
  refundStates: readonly LedgerRefundState[];
  fulfilmentMethods: readonly LedgerFulfilmentMethod[];
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
  created_via: LedgerCreatedVia;
  service_label: string | null;
  service_type: LedgerServiceType | null;
  product_key: string | null;
  repair_variant: string | null;
  arch: string | null;
  brand_id: string | null;
  paid_in_full_at_booking: boolean | null;
  appointment_ref: string | null;
  cancel_reason: string | null;
  notes: string | null;
  payment_state: LedgerPaymentState;
  refund_state: LedgerRefundState;
  refunded_pence: number | null;
  fulfilment_method: LedgerFulfilmentMethod | null;
}

export function useLedger(
  filters: LedgerFilters,
  page: number = 0,
  limit: number = LEDGER_PAGE_SIZE,
): Result {
  const [data, setData] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const filterKey = filtersToKey(filters);
  // Include the filter key in the loading-state key so a filter click
  // flips loading=true synchronously on this render, before the fetch
  // even fires. Without this the receptionist sees the previous list
  // motionless for the full 250ms-debounce + query latency window
  // and assumes the click did nothing.
  const { loading, settle } = useStaleQueryLoading(`ledger|${page}|${limit}|${filterKey}`);

  // Distinguish search-typing changes (which still want a debounce so
  // a per-keystroke fetch doesn't fire during fast typing) from
  // filter-click changes (which want instant fetch). When the only
  // thing that changed is the search term, debounce 200ms; otherwise
  // fetch on the next tick.
  const lastSearchRef = useRef<string>(filters.search.trim());
  const lastFilterKeyRef = useRef<string>(filterKey);
  const isSearchOnlyChange = (() => {
    if (filterKey === lastFilterKeyRef.current) return false;
    const prevSearch = lastSearchRef.current;
    const nextSearch = filters.search.trim();
    if (prevSearch === nextSearch) return false;
    // Reconstruct the would-be key without the search term and
    // compare. If only search changed, those reconstructed keys
    // match.
    const sentinel = ' search-changed ';
    const prevKeyWithoutSearch = lastFilterKeyRef.current.replace(`|${prevSearch}`, `|${sentinel}`);
    const nextKeyWithoutSearch = filterKey.replace(`|${nextSearch}`, `|${sentinel}`);
    return prevKeyWithoutSearch === nextKeyWithoutSearch;
  })();

  useEffect(() => {
    let cancelled = false;
    const trimmed = filters.search.trim();
    lastSearchRef.current = trimmed;
    lastFilterKeyRef.current = filterKey;
    const debounce = isSearchOnlyChange ? 200 : 0;
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
            'id, kind, patient_id, event_at, end_at, status, source, created_via, service_label, service_type, product_key, repair_variant, arch, brand_id, paid_in_full_at_booking, appointment_ref, cancel_reason, notes, payment_state, refund_state, refunded_pence, fulfilment_method',
          );

        if (filters.statuses.length > 0) {
          // 'draft' is a UI-only pseudo-status: a retail Quick Sale that's
          // started but unpaid (service_type='retail' AND status='arrived').
          // Translate it; real statuses keep the plain IN filter.
          const wantsDraft = filters.statuses.includes('draft');
          const realStatuses = filters.statuses.filter((s) => s !== 'draft');
          if (!wantsDraft) {
            q = q.in('status', [...realStatuses]);
          } else if (realStatuses.length === 0) {
            q = q.eq('service_type', 'retail').eq('status', 'arrived');
          } else {
            q = q.or(
              `status.in.(${realStatuses.join(',')}),and(service_type.eq.retail,status.eq.arrived)`,
            );
          }
        }
        if (filters.serviceTypes.length > 0) {
          q = q.in('service_type', [...filters.serviceTypes]);
        }
        if (filters.paymentStates.length > 0) {
          q = q.in('payment_state', [...filters.paymentStates]);
        }
        if (filters.refundStates.length > 0) {
          q = q.in('refund_state', [...filters.refundStates]);
        }
        if (filters.fulfilmentMethods.length > 0) {
          q = q.in('fulfilment_method', [...filters.fulfilmentMethods]);
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
              serviceTypes: [...filters.serviceTypes],
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
            created_via: r.created_via,
            service_label: r.service_label,
            service_type: r.service_type,
            product_key: r.product_key,
            repair_variant: r.repair_variant,
            arch: r.arch,
            brand_id: r.brand_id,
            paid_in_full_at_booking: r.paid_in_full_at_booking ?? false,
            appointment_ref: r.appointment_ref,
            cancel_reason: r.cancel_reason,
            notes: r.notes,
            payment_state: r.payment_state,
            refund_state: r.refund_state ?? 'none',
            refunded_pence: r.refunded_pence ?? 0,
            fulfilment_method: r.fulfilment_method,
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
            serviceTypes: [...filters.serviceTypes],
            fromDate: filters.fromDate,
            toDate: filters.toDate,
          },
        });
        setError(message);
        settle();
      }
    }, debounce);

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
    f.serviceTypes.join(','),
    f.paymentStates.join(','),
    f.refundStates.join(','),
    f.fulfilmentMethods.join(','),
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
    case 'joined':
      return 'Joined';
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
    case 'draft':
      return 'Draft';
    default:
      return status;
  }
}

export function humaniseLedgerPaymentState(state: LedgerPaymentState): string {
  switch (state) {
    case 'paid':
      return 'Paid in full';
    case 'deposit_paid':
      return 'Deposit paid';
    case 'unpaid':
      return 'Unpaid';
    case 'refunded':
      return 'Refunded';
    default:
      return state;
  }
}

// Refund-axis labels. Used by the Ledger filter chips and the row
// pill renderer. 'partial' carries the amount inline (via the
// formatter overload) so a single pill reads "Partially refunded
// £30" without needing a second value.
export function humaniseLedgerRefundState(state: LedgerRefundState): string {
  switch (state) {
    case 'partial':
      return 'Partially refunded';
    case 'full':
      return 'Refunded in full';
    case 'none':
      return 'No refund';
    default:
      return state;
  }
}

// Source label for a Ledger row. Prefers created_via when set
// because two rows can share source='native' but have different
// origin contexts — a Checkpoint-booked appointment writes
// created_via='checkpoint' while a public widget booking leaves it
// null. Without the override the Ledger collapsed Checkpoint and
// public-widget bookings under a generic "Native" pill that didn't
// match the AppointmentDetail hero ("Checkpoint" with sparkles
// glyph).
export function humaniseLedgerSource(
  source: LedgerSource,
  createdVia?: string | null,
  brandId?: string | null,
): string {
  if (createdVia === 'checkpoint') return 'Checkpoint';
  if (createdVia === 'walk_in') return 'Walk-in';
  switch (source) {
    case 'calendly':
      return 'Calendly';
    case 'native':
      // Match the AppointmentDetail hero — show the storefront the
      // patient booked from rather than the developer-jargon "Native"
      // label. brand_id is set by widget-create-appointment on every
      // public-widget booking; legacy rows without a brand fall back
      // to a generic "Website" so the row never reads as "Native".
      if (brandId === 'denture') return 'denture-services.co.uk';
      if (brandId === 'venneir') return 'venneir.com';
      return 'Website';
    case 'manual':
      return 'Manually added';
    case 'walk_in':
      return 'Walk-in';
    default:
      return source;
  }
}

// Companion to humaniseLedgerSource — resolves the SourceGlyph key
// for the same row. Checkpoint and walk-in created_via values
// override the base source; otherwise we hand the source straight
// through. Keeps the Ledger glyph in lockstep with the
// AppointmentDetail hero (which already routes Checkpoint through
// the sparkles glyph via the same string).
export function ledgerSourceGlyphKey(
  source: LedgerSource,
  createdVia?: string | null,
): string {
  if (createdVia === 'checkpoint') return 'checkpoint';
  if (createdVia === 'walk_in') return 'walk_in';
  return source;
}

export function humaniseLedgerFulfilmentMethod(m: LedgerFulfilmentMethod): string {
  switch (m) {
    case 'in_person':
      return 'Handed to patient';
    case 'shipping':
      return 'Shipped';
    default:
      return m;
  }
}

export function humaniseLedgerServiceType(t: LedgerServiceType): string {
  switch (t) {
    case 'denture_repair':
      return 'Denture repair';
    case 'impression_appointment':
      return 'Impression appointment';
    case 'virtual_impression_appointment':
      return 'Virtual appointment';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'click_in_veneers':
      return 'Click-in veneers';
    case 'other':
      return 'Other';
    default:
      return t;
  }
}
