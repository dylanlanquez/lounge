import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { addDaysIso } from '../calendarMonth.ts';
import { logFailure } from '../failureLog.ts';
import { properCase } from './appointments.ts';

// Reports — read-side hooks for the Reports section.
//
// Each hook in this module is keyed on a DateRange. The hook fans
// out one to four parallel queries and aggregates the results into a
// shape that the page can render directly. No PostgreSQL views; we
// keep the data layer plain SQL fetches so the joins stay obvious
// and a future analyst can read what's happening here without
// chasing through a chain of derived views.
//
// Failures are loud: anything unexpected throws into the
// per-hook error state AND lands a row in lng_system_failures via
// logFailure. Per the brief, never silently fall back.

// Raw shapes used by useReportsOverview. Exported so the pure
// aggregateOverview function can be unit-tested without spinning up
// a fake Supabase response — tests build the input arrays directly.

export interface ReportsOverviewVisit {
  id: string;
  patient_id: string;
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  closed_at: string | null;
  status: string;
  cart:
    | {
        id: string;
        total_pence: number | null;
        subtotal_pence: number | null;
        discount_pence: number | null;
        status: string;
      }
    | {
        id: string;
        total_pence: number | null;
        subtotal_pence: number | null;
        discount_pence: number | null;
        status: string;
      }[]
    | null;
}

export interface ReportsOverviewPayment {
  id: string;
  amount_pence: number;
  method: string;
  payment_journey: string | null;
  succeeded_at: string | null;
}

export interface ReportsOverviewItem {
  id: string;
  name: string;
  catalogue_id: string | null;
  line_total_pence: number;
  quantity: number;
  cart:
    | {
        id: string;
        visit:
          | { id: string; opened_at: string }
          | { id: string; opened_at: string }[]
          | null;
      }
    | {
        id: string;
        visit:
          | { id: string; opened_at: string }
          | { id: string; opened_at: string }[]
          | null;
      }[]
    | null;
}

export interface TopService {
  catalogue_id: string | null;
  name: string;
  count: number;
  revenue_pence: number;
}

export interface ReportsOverview {
  // Visit-side
  total_visits: number;
  walk_ins: number;
  scheduled: number;
  unique_patients: number;
  // Status mix on visits in the period
  status_mix: Record<string, number>;
  // Payment-side
  revenue_pence: number;
  payments_count: number;
  payment_method_mix: Record<string, number>; // amount_pence by method
  // Average ticket = revenue / paid-cart count, in pence. Null when
  // no paid carts so the consumer can render '—' rather than NaN.
  average_ticket_pence: number | null;
  // Top 5 services by revenue across all carts in the period.
  top_services: TopService[];
  // Best day in period (most visits). Null when no visits.
  best_day: { date: string; visits: number } | null;
}

interface OverviewResult {
  data: ReportsOverview | null;
  loading: boolean;
  error: string | null;
}

// pickOne is duplicated here rather than imported because the
// import would pull in supabase too eagerly during testing — the
// helper is two lines anyway.
function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value as T;
}

// Pure aggregation. Exported so the test suite can build raw inputs
// and verify the derived stats deterministically without hitting the
// network. The hook below calls this after IO.
export function aggregateOverview(
  visits: ReportsOverviewVisit[],
  payments: ReportsOverviewPayment[],
  items: ReportsOverviewItem[],
): ReportsOverview {
  // ── Visit-side aggregations ────────────────────────────────
  const total_visits = visits.length;
  let walk_ins = 0;
  let scheduled = 0;
  const patientIds = new Set<string>();
  const statusMix: Record<string, number> = {};
  const visitsByDate: Record<string, number> = {};
  for (const v of visits) {
    if (v.arrival_type === 'walk_in') walk_ins += 1;
    else scheduled += 1;
    patientIds.add(v.patient_id);
    statusMix[v.status] = (statusMix[v.status] ?? 0) + 1;
    const date = v.opened_at.slice(0, 10);
    visitsByDate[date] = (visitsByDate[date] ?? 0) + 1;
  }

  // ── Best day ───────────────────────────────────────────────
  let best_day: ReportsOverview['best_day'] = null;
  for (const [date, count] of Object.entries(visitsByDate)) {
    if (!best_day || count > best_day.visits) {
      best_day = { date, visits: count };
    }
  }

  // ── Payment-side aggregations ──────────────────────────────
  let revenue_pence = 0;
  const paymentMethodMix: Record<string, number> = {};
  for (const p of payments) {
    revenue_pence += p.amount_pence;
    paymentMethodMix[p.method] = (paymentMethodMix[p.method] ?? 0) + p.amount_pence;
  }

  // Paid-cart count: distinct cart_ids among the visits in range
  // whose cart.status = 'paid'. Uses the visits' joined cart so we
  // don't need a separate carts query.
  const paidCartIds = new Set<string>();
  for (const v of visits) {
    const cart = pickOne(v.cart);
    if (cart && cart.status === 'paid') paidCartIds.add(cart.id);
  }
  const average_ticket_pence =
    paidCartIds.size > 0 ? Math.round(revenue_pence / paidCartIds.size) : null;

  // ── Top services ───────────────────────────────────────────
  // Group by (catalogue_id, name). catalogue_id can be null for
  // ad-hoc lines; group those by name only so a typo'd ad-hoc
  // line doesn't merge with its catalogue cousin.
  const serviceAgg = new Map<string, TopService>();
  for (const it of items) {
    const cart = pickOne(it.cart);
    const visit = pickOne(cart?.visit ?? null);
    if (!visit) continue; // safety: range filter should have caught this
    const key = it.catalogue_id ?? `__ad_hoc__${it.name}`;
    const prior = serviceAgg.get(key);
    if (prior) {
      prior.count += it.quantity;
      prior.revenue_pence += it.line_total_pence;
    } else {
      serviceAgg.set(key, {
        catalogue_id: it.catalogue_id,
        name: it.name,
        count: it.quantity,
        revenue_pence: it.line_total_pence,
      });
    }
  }
  const top_services = Array.from(serviceAgg.values())
    .sort((a, b) => b.revenue_pence - a.revenue_pence)
    .slice(0, 5);

  return {
    total_visits,
    walk_ins,
    scheduled,
    unique_patients: patientIds.size,
    status_mix: statusMix,
    revenue_pence,
    payments_count: payments.length,
    payment_method_mix: paymentMethodMix,
    average_ticket_pence,
    top_services,
    best_day,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookings vs walk-ins
// ─────────────────────────────────────────────────────────────────────────────

export interface BookingsAppointment {
  id: string;
  start_at: string;
  status: string;
  patient_id: string;
}

export interface BookingsVisit {
  id: string;
  appointment_id: string | null;
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  status: string;
  cart:
    | { id: string; status: string; total_pence: number | null }
    | { id: string; status: string; total_pence: number | null }[]
    | null;
}

export interface BookingsVsWalkInsData {
  daily: { date: string; booked: number; walk_in: number }[];
  funnel: { id: string; label: string; count: number }[];
  walk_in_hour_distribution: { hour: number; count: number }[];
  no_show_count: number;
  no_show_rate: number; // 0..1, null when no scheduled appointments
  walk_in_avg_ticket_pence: number | null;
  scheduled_avg_ticket_pence: number | null;
  // Convenience top-line numbers for the KPI strip.
  total_booked: number;
  total_walk_in: number;
}

export function aggregateBookingsVsWalkIns(
  range: DateRange,
  appointments: BookingsAppointment[],
  visits: BookingsVisit[],
): BookingsVsWalkInsData {
  // Build the inclusive date list once so the daily series has a row
  // for every calendar day, including ones with zero events.
  const dates: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysIso(d, 1)) {
    dates.push(d);
  }
  const bookedByDate: Record<string, number> = {};
  const walkInByDate: Record<string, number> = {};
  for (const d of dates) {
    bookedByDate[d] = 0;
    walkInByDate[d] = 0;
  }

  for (const a of appointments) {
    const date = a.start_at.slice(0, 10);
    if (date in bookedByDate) bookedByDate[date] = (bookedByDate[date] ?? 0) + 1;
  }
  for (const v of visits) {
    if (v.arrival_type !== 'walk_in') continue;
    const date = v.opened_at.slice(0, 10);
    if (date in walkInByDate) walkInByDate[date] = (walkInByDate[date] ?? 0) + 1;
  }
  const daily = dates.map((date) => ({
    date,
    booked: bookedByDate[date] ?? 0,
    walk_in: walkInByDate[date] ?? 0,
  }));

  // Funnel for booked appointments. Each stage is a strict superset
  // of the next: complete ⊆ in-chair ⊆ arrived ⊆ booked.
  const totalBooked = appointments.length;
  const arrivalsByApptId = new Set<string>();
  const inChairOrCompleteByApptId = new Set<string>();
  const completeByApptId = new Set<string>();
  for (const v of visits) {
    if (v.arrival_type !== 'scheduled' || !v.appointment_id) continue;
    arrivalsByApptId.add(v.appointment_id);
    if (v.status === 'in_chair' || v.status === 'complete') {
      inChairOrCompleteByApptId.add(v.appointment_id);
    }
    if (v.status === 'complete') {
      completeByApptId.add(v.appointment_id);
    }
  }
  // Match arrivals only against appointments that are in-range — so
  // an appointment that scheduled for next year and arrived inside
  // the range doesn't double-count.
  const inRangeApptIds = new Set(appointments.map((a) => a.id));
  const arrived = countIntersect(arrivalsByApptId, inRangeApptIds);
  const inChair = countIntersect(inChairOrCompleteByApptId, inRangeApptIds);
  const complete = countIntersect(completeByApptId, inRangeApptIds);
  const funnel = [
    { id: 'booked', label: 'Booked', count: totalBooked },
    { id: 'arrived', label: 'Arrived', count: arrived },
    { id: 'in_chair', label: 'Reached the chair', count: inChair },
    { id: 'complete', label: 'Completed', count: complete },
  ];

  // No-show rate: appointments with status='no_show' as a fraction of
  // appointments in the period. Cancelled / rescheduled don't count
  // as no-shows — those are deliberate. 0 when there were no
  // scheduled appointments in the period.
  const noShowCount = appointments.filter((a) => a.status === 'no_show').length;
  const noShowRate = totalBooked > 0 ? noShowCount / totalBooked : 0;

  // Walk-in distribution by hour-of-day (0-23). Uses local time for
  // intuition — staffing is a local-time concern.
  const hourCounts: number[] = new Array(24).fill(0);
  for (const v of visits) {
    if (v.arrival_type !== 'walk_in') continue;
    const hour = new Date(v.opened_at).getHours();
    if (hour >= 0 && hour < 24) {
      hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
    }
  }
  const walkInHourDistribution = hourCounts.map((count, hour) => ({ hour, count }));

  // Avg ticket per arrival type. Only paid carts contribute.
  const walkInPaid: number[] = [];
  const scheduledPaid: number[] = [];
  for (const v of visits) {
    const cart = pickOne(v.cart);
    if (!cart || cart.status !== 'paid' || cart.total_pence == null) continue;
    if (v.arrival_type === 'walk_in') walkInPaid.push(cart.total_pence);
    else scheduledPaid.push(cart.total_pence);
  }
  const walkInAvg = walkInPaid.length > 0 ? Math.round(walkInPaid.reduce((s, n) => s + n, 0) / walkInPaid.length) : null;
  const scheduledAvg = scheduledPaid.length > 0 ? Math.round(scheduledPaid.reduce((s, n) => s + n, 0) / scheduledPaid.length) : null;

  return {
    daily,
    funnel,
    walk_in_hour_distribution: walkInHourDistribution,
    no_show_count: noShowCount,
    no_show_rate: noShowRate,
    walk_in_avg_ticket_pence: walkInAvg,
    scheduled_avg_ticket_pence: scheduledAvg,
    total_booked: totalBooked,
    total_walk_in: visits.filter((v) => v.arrival_type === 'walk_in').length,
  };
}

function countIntersect(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
}

interface BookingsVsWalkInsResult {
  data: BookingsVsWalkInsData | null;
  loading: boolean;
  error: string | null;
}

export function useReportsBookingsVsWalkIns(range: DateRange): BookingsVsWalkInsResult {
  const [data, setData] = useState<BookingsVsWalkInsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const [apptRes, visitRes] = await Promise.all([
          supabase
            .from('lng_appointments')
            .select('id, start_at, status, patient_id')
            .gte('start_at', fromIso)
            .lte('start_at', toIso),
          supabase
            .from('lng_visits')
            .select(
              `id, appointment_id, arrival_type, opened_at, status,
               cart:lng_carts ( id, status, total_pence )`,
            )
            .gte('opened_at', fromIso)
            .lte('opened_at', toIso),
        ]);
        if (cancelled) return;
        if (apptRes.error) throw new Error(`appointments: ${apptRes.error.message}`);
        if (visitRes.error) throw new Error(`visits: ${visitRes.error.message}`);
        const appointments = (apptRes.data ?? []) as BookingsAppointment[];
        const visits = (visitRes.data ?? []) as BookingsVisit[];
        const out = aggregateBookingsVsWalkIns(range, appointments, visits);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load bookings vs walk-ins';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.bookings_vs_walkins',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient demographics + Marketing attribution
//
// One shared query backing two tabs. Both surfaces care about
// "patients who came in during this period and what they paid us"
// — demographics slices by age / sex / postcode / new-vs-returning;
// marketing slices by patients.referred_by. Aggregations are pure
// and unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientReportVisit {
  id: string;
  patient_id: string;
  arrival_type: 'walk_in' | 'scheduled';
  opened_at: string;
  patient:
    | {
        id: string;
        date_of_birth: string | null;
        sex: string | null;
        portal_ship_postcode: string | null;
        referred_by: string | null;
        registered_at: string | null;
      }
    | {
        id: string;
        date_of_birth: string | null;
        sex: string | null;
        portal_ship_postcode: string | null;
        referred_by: string | null;
        registered_at: string | null;
      }[]
    | null;
  cart:
    | { id: string; status: string; total_pence: number | null }
    | { id: string; status: string; total_pence: number | null }[]
    | null;
}

export type AgeBracket = 'under_18' | '18_29' | '30_44' | '45_59' | '60_74' | '75_plus' | 'unknown';

export const AGE_BRACKETS: { id: AgeBracket; label: string }[] = [
  { id: 'under_18', label: 'Under 18' },
  { id: '18_29', label: '18–29' },
  { id: '30_44', label: '30–44' },
  { id: '45_59', label: '45–59' },
  { id: '60_74', label: '60–74' },
  { id: '75_plus', label: '75+' },
  { id: 'unknown', label: 'Unknown' },
];

export interface AgeDistributionEntry {
  bracket: AgeBracket;
  label: string;
  count: number;
}

export interface SexDistributionEntry {
  key: string; // raw value from patients.sex (or 'unknown')
  label: string;
  count: number;
}

export interface PostcodeAreaEntry {
  outward: string; // e.g. "SW1A"; "Unknown" when patient has no postcode
  count: number;
  revenue_pence: number;
}

export interface ReferralSourceEntry {
  source: string; // grouped value of patients.referred_by; 'Unspecified' for null/empty
  patients: number; // unique patients
  visits: number; // visits in period
  revenue_pence: number; // total of paid carts attributed to those patients in period
}

export interface PatientReports {
  // Demographics — counts unique patients seen in the period.
  total_unique_patients: number;
  new_patients: number; // registered_at within range
  returning_patients: number;
  age_distribution: AgeDistributionEntry[];
  sex_distribution: SexDistributionEntry[];
  postcode_areas: PostcodeAreaEntry[]; // top 10 + Other aggregator separate
  postcode_other: { count: number; revenue_pence: number };
  // Marketing — referred_by aggregations, revenue based on paid carts
  // for visits in the period.
  referral_sources: ReferralSourceEntry[];
  // Headline numbers
  visits_in_period: number;
  revenue_in_period_pence: number;
}

export function aggregatePatientReports(
  range: DateRange,
  visits: PatientReportVisit[],
): PatientReports {
  // Per-patient bookkeeping.
  const seenPatients = new Map<
    string,
    {
      visits: number;
      revenue_pence: number;
      referred_by: string;
      sex: string;
      ageBracket: AgeBracket;
      postcode: string; // outward or "Unknown"
      isNew: boolean;
    }
  >();

  const rangeStart = new Date(`${range.start}T00:00:00`).getTime();
  const rangeEnd = new Date(`${range.end}T23:59:59.999`).getTime();
  const refDate = new Date(`${range.end}T00:00:00`); // age computed at end of range

  for (const v of visits) {
    const p = pickOne(v.patient);
    if (!p) continue;
    const cart = pickOne(v.cart);
    const paid = cart && cart.status === 'paid' && typeof cart.total_pence === 'number'
      ? cart.total_pence
      : 0;
    const existing = seenPatients.get(v.patient_id);
    if (existing) {
      existing.visits += 1;
      existing.revenue_pence += paid;
      continue;
    }
    seenPatients.set(v.patient_id, {
      visits: 1,
      revenue_pence: paid,
      referred_by: normaliseReferral(p.referred_by),
      sex: normaliseSex(p.sex),
      ageBracket: ageBracketFor(p.date_of_birth, refDate),
      postcode: outwardPostcode(p.portal_ship_postcode),
      isNew: isNewIn(p.registered_at, rangeStart, rangeEnd),
    });
  }

  // ── Top-line counts ───────────────────────────────────────────────
  const total_unique_patients = seenPatients.size;
  let new_patients = 0;
  let revenue_in_period_pence = 0;
  let visits_in_period = 0;
  for (const p of seenPatients.values()) {
    if (p.isNew) new_patients += 1;
    revenue_in_period_pence += p.revenue_pence;
    visits_in_period += p.visits;
  }
  const returning_patients = total_unique_patients - new_patients;

  // ── Age distribution ──────────────────────────────────────────────
  const ageBuckets = new Map<AgeBracket, number>();
  for (const def of AGE_BRACKETS) ageBuckets.set(def.id, 0);
  for (const p of seenPatients.values()) {
    ageBuckets.set(p.ageBracket, (ageBuckets.get(p.ageBracket) ?? 0) + 1);
  }
  const age_distribution: AgeDistributionEntry[] = AGE_BRACKETS.map((def) => ({
    bracket: def.id,
    label: def.label,
    count: ageBuckets.get(def.id) ?? 0,
  }));

  // ── Sex distribution ──────────────────────────────────────────────
  const sexCounts = new Map<string, number>();
  for (const p of seenPatients.values()) {
    sexCounts.set(p.sex, (sexCounts.get(p.sex) ?? 0) + 1);
  }
  const sex_distribution: SexDistributionEntry[] = Array.from(sexCounts.entries())
    .map(([key, count]) => ({ key, label: humaniseSex(key), count }))
    .sort((a, b) => b.count - a.count);

  // ── Postcode areas ────────────────────────────────────────────────
  const postcodeAgg = new Map<string, { count: number; revenue_pence: number }>();
  for (const p of seenPatients.values()) {
    const prior = postcodeAgg.get(p.postcode);
    if (prior) {
      prior.count += 1;
      prior.revenue_pence += p.revenue_pence;
    } else {
      postcodeAgg.set(p.postcode, { count: 1, revenue_pence: p.revenue_pence });
    }
  }
  const sortedPostcodes = Array.from(postcodeAgg.entries())
    .map(([outward, agg]) => ({ outward, count: agg.count, revenue_pence: agg.revenue_pence }))
    .sort((a, b) => b.count - a.count);
  const postcode_areas = sortedPostcodes.slice(0, 10);
  const postcode_other = sortedPostcodes.slice(10).reduce(
    (acc, e) => ({ count: acc.count + e.count, revenue_pence: acc.revenue_pence + e.revenue_pence }),
    { count: 0, revenue_pence: 0 },
  );

  // ── Referral sources (marketing) ─────────────────────────────────
  const referralAgg = new Map<string, ReferralSourceEntry>();
  for (const [, p] of seenPatients) {
    const entry = referralAgg.get(p.referred_by);
    if (entry) {
      entry.patients += 1;
      entry.visits += p.visits;
      entry.revenue_pence += p.revenue_pence;
    } else {
      referralAgg.set(p.referred_by, {
        source: p.referred_by,
        patients: 1,
        visits: p.visits,
        revenue_pence: p.revenue_pence,
      });
    }
  }
  const referral_sources = Array.from(referralAgg.values()).sort(
    (a, b) => b.revenue_pence - a.revenue_pence || b.patients - a.patients,
  );

  return {
    total_unique_patients,
    new_patients,
    returning_patients,
    age_distribution,
    sex_distribution,
    postcode_areas,
    postcode_other,
    referral_sources,
    visits_in_period,
    revenue_in_period_pence,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

// UK outward code. Strips spaces, takes the chars before the 2nd-last
// digit-letter pair. Returns "Unknown" when the input doesn't look
// like a postcode at all. Case-insensitive input → upper-case output.
export function outwardPostcode(input: string | null | undefined): string {
  if (!input) return 'Unknown';
  const cleaned = input.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length < 5) return 'Unknown';
  // Standard UK format: outward (2-4 chars) + space + inward (3 chars)
  // After stripping spaces, the inward is the last 3 chars.
  return cleaned.slice(0, cleaned.length - 3);
}

// Years between birth and refDate, integer. Null DOB → 'unknown'.
export function ageBracketFor(
  dob: string | null | undefined,
  refDate: Date,
): AgeBracket {
  if (!dob) return 'unknown';
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 'unknown';
  let years = refDate.getFullYear() - d.getFullYear();
  // Adjust for not-yet-had-birthday-this-year
  const m = refDate.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && refDate.getDate() < d.getDate())) years -= 1;
  if (years < 0) return 'unknown';
  if (years < 18) return 'under_18';
  if (years < 30) return '18_29';
  if (years < 45) return '30_44';
  if (years < 60) return '45_59';
  if (years < 75) return '60_74';
  return '75_plus';
}

function isNewIn(registeredAt: string | null | undefined, rangeStart: number, rangeEnd: number): boolean {
  if (!registeredAt) return false; // unknown registration → assume returning
  const r = new Date(registeredAt).getTime();
  if (Number.isNaN(r)) return false;
  return r >= rangeStart && r <= rangeEnd;
}

function normaliseSex(sex: string | null | undefined): string {
  if (!sex) return 'unknown';
  const trimmed = sex.trim().toLowerCase();
  if (trimmed.length === 0) return 'unknown';
  return trimmed;
}

function humaniseSex(key: string): string {
  switch (key) {
    case 'male':
      return 'Male';
    case 'female':
      return 'Female';
    case 'other':
      return 'Other';
    case 'unknown':
      return 'Unknown / not stated';
    default:
      // Unrecognised values render as their raw form, title-cased.
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}

function normaliseReferral(value: string | null | undefined): string {
  if (!value) return 'Unspecified';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Unspecified';
  return trimmed;
}

interface PatientReportsResult {
  data: PatientReports | null;
  loading: boolean;
  error: string | null;
}

export function useReportsPatients(range: DateRange): PatientReportsResult {
  const [data, setData] = useState<PatientReports | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);

    (async () => {
      try {
        const visitsRes = await supabase
          .from('lng_visits')
          .select(
            `id, patient_id, arrival_type, opened_at,
             patient:patients!inner ( id, date_of_birth, sex, portal_ship_postcode, referred_by, registered_at ),
             cart:lng_carts ( id, status, total_pence )`,
          )
          .gte('opened_at', fromIso)
          .lte('opened_at', toIso);
        if (cancelled) return;
        if (visitsRes.error) throw new Error(`patients: ${visitsRes.error.message}`);
        const visits = (visitsRes.data ?? []) as PatientReportVisit[];
        const out = aggregatePatientReports(range, visits);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load patient reports';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.patients',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor heatmap data — per-outward visitor counts + dominant
// service. Backs the Demographics tab's "Where customers are coming
// from" map. Reuses the patient + cart joins that the rest of the
// reports module already understands.
//
// Service classification matches the In Clinic board: catalogue
// service_type wins; the dominant service per cart is the most
// frequent service_type across the cart's items, with ties broken
// by the first match. A cart with no recognisable service falls
// into 'other'.
// ─────────────────────────────────────────────────────────────────────────────

export type VisitorMapService = 'denture_repair' | 'click_in_veneers' | 'same_day_appliance' | 'impression_appointment' | 'other';

export const VISITOR_MAP_SERVICES: { id: VisitorMapService; label: string }[] = [
  { id: 'denture_repair', label: 'Denture repair' },
  { id: 'click_in_veneers', label: 'Click-in veneers' },
  { id: 'same_day_appliance', label: 'Same-day appliance' },
  { id: 'impression_appointment', label: 'Impression' },
  { id: 'other', label: 'Other' },
];

// One drill-down level beneath VisitorMapService. Each parent service
// has its own sub-vocabulary:
//   • denture_repair    → catalogue.repair_variant
//   • same_day_appliance → catalogue.product_key
//   • click_in_veneers  → cart_items.arch
//   • impression_appointment → cart_items.arch
//   • other             → none (no drill)
//
// The aggregator computes the dominant sub per (patient, service) so
// the same de-dup rules as the parent service flow through.
export interface VisitorSubcategory {
  key: string; // raw value from the schema (e.g. 'Snapped denture', 'whitening_tray', 'upper')
  label: string; // human-friendly
  count: number;
}

export interface VisitorMapPointService {
  service: VisitorMapService;
  count: number;
  subs: VisitorSubcategory[];
}

export interface VisitorMapPoint {
  outward: string; // e.g. 'SW1A'; never 'Unknown' here — those are filtered out
  total: number;
  services: VisitorMapPointService[];
}

export interface VisitorMapData {
  points: VisitorMapPoint[];
  total_visitors: number;
  unknown_outward: number;
}

interface VisitorMapVisit {
  patient_id: string;
  patient:
    | { portal_ship_postcode: string | null }
    | { portal_ship_postcode: string | null }[]
    | null;
  cart:
    | {
        items:
          | {
              arch: string | null;
              catalogue:
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }[]
                | null;
            }[]
          | null;
      }
    | {
        items:
          | {
              arch: string | null;
              catalogue:
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }[]
                | null;
            }[]
          | null;
      }[]
    | null;
}

export function aggregateVisitorMap(visits: VisitorMapVisit[]): VisitorMapData {
  // De-dup on patient_id — visitors are unique people in the period,
  // not sums of visits. (Otherwise a frequent denture-repair patient
  // would dominate their outward purely by visit volume.)
  interface PatientFingerprint {
    outward: string;
    service: VisitorMapService;
    subKey: string | null;
  }
  const perPatient = new Map<string, PatientFingerprint>();
  let unknown_outward = 0;
  for (const v of visits) {
    if (perPatient.has(v.patient_id)) continue; // first visit wins

    const p = pickOne(v.patient);
    const outward = p ? outwardPostcode(p.portal_ship_postcode) : 'Unknown';
    const dominant = dominantClassification(v);

    if (outward === 'Unknown') {
      perPatient.set(v.patient_id, { outward: 'Unknown', service: dominant.service, subKey: dominant.subKey });
      unknown_outward += 1;
      continue;
    }
    perPatient.set(v.patient_id, { outward, service: dominant.service, subKey: dominant.subKey });
  }

  // Group by outward, then by service within outward.
  interface MutableServiceEntry {
    service: VisitorMapService;
    count: number;
    subs: Map<string, number>;
  }
  const aggByOutward = new Map<string, { total: number; services: Map<VisitorMapService, MutableServiceEntry> }>();

  for (const p of perPatient.values()) {
    if (p.outward === 'Unknown') continue;
    let outward = aggByOutward.get(p.outward);
    if (!outward) {
      outward = { total: 0, services: new Map() };
      aggByOutward.set(p.outward, outward);
    }
    outward.total += 1;
    let svc = outward.services.get(p.service);
    if (!svc) {
      svc = { service: p.service, count: 0, subs: new Map() };
      outward.services.set(p.service, svc);
    }
    svc.count += 1;
    if (p.subKey) {
      svc.subs.set(p.subKey, (svc.subs.get(p.subKey) ?? 0) + 1);
    }
  }

  const points: VisitorMapPoint[] = Array.from(aggByOutward.entries())
    .map(([outward, agg]) => ({
      outward,
      total: agg.total,
      services: Array.from(agg.services.values())
        .map((s) => ({
          service: s.service,
          count: s.count,
          subs: Array.from(s.subs.entries())
            .map(([key, count]) => ({ key, label: humaniseSub(s.service, key), count }))
            .sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total);

  const total_visitors = points.reduce((s, p) => s + p.total, 0);
  return { points, total_visitors, unknown_outward };
}

interface DominantClassification {
  service: VisitorMapService;
  subKey: string | null;
}

function dominantClassification(v: VisitorMapVisit): DominantClassification {
  const cart = pickOne(v.cart);
  const items = cart?.items ?? [];
  if (items.length === 0) return { service: 'other', subKey: null };

  // Step 1 — pick the dominant service across all items.
  const serviceCounts: Record<VisitorMapService, number> = {
    denture_repair: 0,
    click_in_veneers: 0,
    same_day_appliance: 0,
    impression_appointment: 0,
    other: 0,
  };
  for (const it of items) {
    const cat = pickOne(it.catalogue);
    const st = normaliseServiceType(cat?.service_type ?? null);
    serviceCounts[st] += 1;
  }
  let dominant: VisitorMapService = 'other';
  let dominantCount = -1;
  for (const k of Object.keys(serviceCounts) as VisitorMapService[]) {
    if (serviceCounts[k] > dominantCount) {
      dominantCount = serviceCounts[k];
      dominant = k;
    }
  }

  // Step 2 — pick the dominant sub-key inside that service. 'other'
  // has no sub-vocabulary, so return null.
  if (dominant === 'other') return { service: 'other', subKey: null };
  const subCounts = new Map<string, number>();
  for (const it of items) {
    const cat = pickOne(it.catalogue);
    if (normaliseServiceType(cat?.service_type ?? null) !== dominant) continue;
    const subKey = subKeyFor(dominant, it.arch, cat?.repair_variant ?? null, cat?.product_key ?? null);
    if (subKey) subCounts.set(subKey, (subCounts.get(subKey) ?? 0) + 1);
  }
  if (subCounts.size === 0) return { service: dominant, subKey: null };
  let bestSub: string | null = null;
  let bestSubCount = -1;
  for (const [k, c] of subCounts) {
    if (c > bestSubCount) {
      bestSub = k;
      bestSubCount = c;
    }
  }
  return { service: dominant, subKey: bestSub };
}

// Per-service sub-key extraction. Each service uses a different
// schema field for its drill-down. Returns null when the relevant
// field is empty so the patient still contributes to the parent
// service's count without polluting the sub-list with "Unknown"
// rows.
function subKeyFor(
  service: VisitorMapService,
  arch: string | null,
  repairVariant: string | null,
  productKey: string | null,
): string | null {
  switch (service) {
    case 'denture_repair':
      return repairVariant?.trim() || null;
    case 'same_day_appliance':
      return productKey?.trim() || null;
    case 'click_in_veneers':
    case 'impression_appointment':
      // Arch is the natural drill-down for veneers + impressions.
      return arch?.trim() || null;
    case 'other':
      return null;
  }
}

function humaniseSub(service: VisitorMapService, key: string): string {
  if (service === 'click_in_veneers' || service === 'impression_appointment') {
    if (key === 'upper') return 'Upper arch';
    if (key === 'lower') return 'Lower arch';
    if (key === 'both') return 'Both arches';
    return key;
  }
  if (service === 'same_day_appliance') {
    // Catalogue product_keys are snake_case identifiers — humanise.
    return key
      .split('_')
      .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join(' ');
  }
  // Denture repair already comes through with a human label
  // ('Snapped denture', 'Add a new tooth') in the catalogue.
  return key;
}

function normaliseServiceType(raw: string | null): VisitorMapService {
  switch (raw) {
    case 'denture_repair':
    case 'click_in_veneers':
    case 'same_day_appliance':
    case 'impression_appointment':
      return raw;
    default:
      return 'other';
  }
}

interface VisitorMapResult {
  data: VisitorMapData | null;
  loading: boolean;
  error: string | null;
}

export function useReportsVisitorMap(range: DateRange): VisitorMapResult {
  const [data, setData] = useState<VisitorMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const res = await supabase
          .from('lng_visits')
          .select(
            `patient_id,
             patient:patients!inner ( portal_ship_postcode ),
             cart:lng_carts (
               items:lng_cart_items (
                 arch,
                 catalogue:lwo_catalogue ( service_type, repair_variant, product_key )
               )
             )`,
          )
          .gte('opened_at', fromIso)
          .lte('opened_at', toIso);
        if (cancelled) return;
        if (res.error) throw new Error(`visitor_map: ${res.error.message}`);
        const out = aggregateVisitorMap((res.data ?? []) as VisitorMapVisit[]);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load visitor map';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.visitor_map',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visitor address map (admin-only)
//
// Sibling of the outward-postcode visitor map but at full-address
// resolution. Each unique patient address (line1 + postcode) becomes
// one point. Each point carries the list of visits that happened from
// that address — visit date, LAP appointment ref, and the items
// purchased — so the hover card on the map can surface real
// operational detail to clinical leadership.
//
// Privacy: precise residential addresses are personal data. This hook
// queries the lng_visits join with patient address fields and is
// intended for admin/super-admin only — DemographicsTab gates on
// account.is_admin / account.is_super_admin before instantiating this
// hook. The same gate is enforced again in geocode-address (the edge
// function that turns these into lat/lng); RLS on lng_address_geocodes
// is defence-in-depth.
//
// The aggregator de-duplicates by *address*, not by patient — two
// patients at the same household share one map point. Within a
// point, every visit is listed individually so the hover doesn't
// hide that two people came from the same address.
// ─────────────────────────────────────────────────────────────────────────────

export interface VisitorAddressVisitItem {
  // Display label as it should appear in the hover (e.g. "Cracked
  // denture" / "Click-in veneers"). Built once during aggregation so
  // the hover card stays purely presentational.
  label: string;
  service: VisitorMapService;
}

export interface VisitorAddressVisit {
  visit_id: string;
  visit_date: string; // ISO timestamp from lng_visits.opened_at
  appointment_ref: string | null; // LAP-xxxxx, from appointment or walk-in
  items: VisitorAddressVisitItem[];
  // Dominant service across the visit's items, used to colour the
  // marker when the point covers a single visit. When there are
  // multiple visits, the point's own dominant_service wins.
  dominant_service: VisitorMapService;
}

export interface VisitorAddressPoint {
  // Display form (preserves user-entered casing/spacing for the hover).
  line1: string;
  postcode: string;
  // Normalised form — must match the geocode hook's normalisation
  // (trimmed-collapsed-lowercased line1, no-space-uppercased postcode).
  line1_norm: string;
  postcode_norm: string;
  total_visits: number;
  // Distinct patient_ids that booked from this address — surfaced in
  // the hover so household-shared bookings are visible.
  patient_count: number;
  visits: VisitorAddressVisit[];
  dominant_service: VisitorMapService;
}

export interface VisitorAddressMapData {
  points: VisitorAddressPoint[];
  total_visits: number;
  // Patients in the period whose record is missing a line1 OR a
  // valid UK postcode shape. Surfaced as a "(N visits with no usable
  // address) not shown" footnote.
  unmappable_visits: number;
}

interface VisitorAddressMapVisit {
  id: string;
  opened_at: string;
  patient_id: string;
  patient:
    | {
        portal_ship_line1: string | null;
        portal_ship_postcode: string | null;
      }
    | {
        portal_ship_line1: string | null;
        portal_ship_postcode: string | null;
      }[]
    | null;
  appointment:
    | { appointment_ref: string | null }
    | { appointment_ref: string | null }[]
    | null;
  walk_in:
    | { appointment_ref: string | null }
    | { appointment_ref: string | null }[]
    | null;
  cart:
    | {
        items:
          | {
              arch: string | null;
              catalogue:
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }[]
                | null;
            }[]
          | null;
      }
    | {
        items:
          | {
              arch: string | null;
              catalogue:
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }
                | {
                    service_type: string | null;
                    repair_variant: string | null;
                    product_key: string | null;
                  }[]
                | null;
            }[]
          | null;
      }[]
    | null;
}

export function aggregateVisitorAddressMap(
  visits: VisitorAddressMapVisit[],
): VisitorAddressMapData {
  interface MutablePoint {
    line1: string;
    postcode: string;
    line1_norm: string;
    postcode_norm: string;
    visits: VisitorAddressVisit[];
    patient_ids: Set<string>;
    serviceCounts: Map<VisitorMapService, number>;
  }
  const byKey = new Map<string, MutablePoint>();
  let unmappable_visits = 0;
  let total_visits = 0;

  for (const v of visits) {
    const p = pickOne(v.patient);
    const line1Raw = p?.portal_ship_line1 ?? '';
    const postcodeRaw = p?.portal_ship_postcode ?? '';
    const line1_norm = line1Raw.trim().replace(/\s+/g, ' ').toLowerCase();
    const postcode_norm = postcodeRaw.replace(/\s+/g, '').toUpperCase();
    // Mirror the edge function's gate: missing line1 OR malformed UK
    // postcode means we can't pin this visit. The full UK postcode
    // shape (outward + inward) is required for address-level lookup.
    const validPostcode = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(postcode_norm);
    total_visits += 1;
    if (!line1_norm || !validPostcode) {
      unmappable_visits += 1;
      continue;
    }

    const key = `${line1_norm}|${postcode_norm}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        line1: line1Raw.trim(),
        postcode: postcodeRaw.trim(),
        line1_norm,
        postcode_norm,
        visits: [],
        patient_ids: new Set(),
        serviceCounts: new Map(),
      };
      byKey.set(key, bucket);
    }

    const dominant = dominantClassification(v);
    const items = buildAddressItems(v, dominant.service);
    const appt = pickOne(v.appointment);
    const walkIn = pickOne(v.walk_in);
    bucket.visits.push({
      visit_id: v.id,
      visit_date: v.opened_at,
      appointment_ref: appt?.appointment_ref ?? walkIn?.appointment_ref ?? null,
      items,
      dominant_service: dominant.service,
    });
    bucket.patient_ids.add(v.patient_id);
    bucket.serviceCounts.set(
      dominant.service,
      (bucket.serviceCounts.get(dominant.service) ?? 0) + 1,
    );
  }

  const points: VisitorAddressPoint[] = Array.from(byKey.values())
    .map((b) => {
      // Pick the most-booked service at this address as its colour.
      let dominant: VisitorMapService = 'other';
      let max = -1;
      for (const [svc, c] of b.serviceCounts.entries()) {
        if (c > max) {
          dominant = svc;
          max = c;
        }
      }
      return {
        line1: b.line1,
        postcode: b.postcode,
        line1_norm: b.line1_norm,
        postcode_norm: b.postcode_norm,
        total_visits: b.visits.length,
        patient_count: b.patient_ids.size,
        // Newest visit first so the hover-card list reads chronologically
        // backwards — most relevant booking on top.
        visits: b.visits.sort((a, x) => x.visit_date.localeCompare(a.visit_date)),
        dominant_service: dominant,
      };
    })
    .sort((a, b) => b.total_visits - a.total_visits);

  return { points, total_visits, unmappable_visits };
}

// Build the per-visit item list for the hover card. Reuses the
// existing dominant-classification helpers but expands every cart
// item (not only the dominant one) so the hover surfaces the full
// basket. Items collapse to a per-service summary — three "Cracked
// denture" items become "Cracked denture × 3" rather than three
// duplicated lines.
function buildAddressItems(
  v: VisitorAddressMapVisit,
  fallbackService: VisitorMapService,
): VisitorAddressVisitItem[] {
  const cart = pickOne(v.cart);
  const items = cart?.items ?? [];
  if (items.length === 0) {
    return [{ label: 'No items recorded', service: fallbackService }];
  }
  const counts = new Map<string, { label: string; service: VisitorMapService; count: number }>();
  for (const it of items) {
    const cat = pickOne(it.catalogue);
    const rawService = (cat?.service_type as string | null) ?? null;
    const service: VisitorMapService = isVisitorMapService(rawService) ? rawService : 'other';
    const label = humaniseSub(service, classificationKeyFor(service, cat, it.arch));
    const k = `${service}|${label}`;
    const existing = counts.get(k);
    if (existing) existing.count += 1;
    else counts.set(k, { label, service, count: 1 });
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      label: e.count > 1 ? `${e.label} × ${e.count}` : e.label,
      service: e.service,
    }));
}

function isVisitorMapService(s: string | null): s is VisitorMapService {
  return (
    s === 'denture_repair' ||
    s === 'click_in_veneers' ||
    s === 'same_day_appliance' ||
    s === 'impression_appointment' ||
    s === 'other'
  );
}

// Reproduces the sub-key extraction logic from dominantClassification
// but at the per-item level, so the hover card distinguishes a
// "Cracked denture" repair from an "Add a new tooth" repair on the
// same visit.
function classificationKeyFor(
  service: VisitorMapService,
  cat: { service_type: string | null; repair_variant: string | null; product_key: string | null } | null,
  arch: string | null,
): string {
  if (!cat) return service;
  switch (service) {
    case 'denture_repair':
      return cat.repair_variant ?? 'denture_repair';
    case 'same_day_appliance':
      return cat.product_key ?? 'same_day_appliance';
    case 'click_in_veneers':
    case 'impression_appointment':
      return arch ?? service;
    default:
      return service;
  }
}

interface VisitorAddressMapResult {
  data: VisitorAddressMapData | null;
  loading: boolean;
  error: string | null;
}

// useReportsVisitorAddressMap — admin-only.
//
// The select pulls patient line1 + postcode along with the cart and
// appointment-ref relations. Non-admins won't be able to read these
// rows due to RLS on lng_visits / patients (admin-scoped by location);
// for the heatmap context the parent component (DemographicsTab)
// already gates instantiation on the account flag. This hook does
// NOT additionally check account state — it's the caller's
// responsibility.
export function useReportsVisitorAddressMap(range: DateRange): VisitorAddressMapResult {
  const [data, setData] = useState<VisitorAddressMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const res = await supabase
          .from('lng_visits')
          .select(
            `id,
             opened_at,
             patient_id,
             patient:patients!inner ( portal_ship_line1, portal_ship_postcode ),
             appointment:lng_appointments ( appointment_ref ),
             walk_in:lng_walk_ins ( appointment_ref ),
             cart:lng_carts (
               items:lng_cart_items (
                 arch,
                 catalogue:lwo_catalogue ( service_type, repair_variant, product_key )
               )
             )`,
          )
          .gte('opened_at', fromIso)
          .lte('opened_at', toIso);
        if (cancelled) return;
        if (res.error) throw new Error(`visitor_address_map: ${res.error.message}`);
        const out = aggregateVisitorAddressMap((res.data ?? []) as VisitorAddressMapVisit[]);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load visitor address map';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.visitor_address_map',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service mix
//
// Slices catalogue line items by category + service_type and surfaces
// per-service revenue, count, average price, and the share of carts
// where that service was discounted (helpful for spotting services
// that frequently need a price adjustment).
// ─────────────────────────────────────────────────────────────────────────────

export interface ServiceMixItem {
  id: string;
  name: string;
  catalogue_id: string | null;
  line_total_pence: number;
  unit_price_pence: number;
  discount_pence: number; // line-level discount
  quantity: number;
  cart:
    | { id: string; status: string; discount_pence: number | null; visit: { id: string; opened_at: string } | { id: string; opened_at: string }[] | null }
    | { id: string; status: string; discount_pence: number | null; visit: { id: string; opened_at: string } | { id: string; opened_at: string }[] | null }[]
    | null;
  catalogue:
    | { service_type: string | null; category: string | null }
    | { service_type: string | null; category: string | null }[]
    | null;
}

export interface ServiceCategoryEntry {
  // Group key: catalogue.category, falling back to catalogue.service_type,
  // falling back to "Other".
  category: string;
  count: number;
  revenue_pence: number;
}

export interface ServiceLineEntry {
  catalogue_id: string | null;
  name: string;
  count: number;
  revenue_pence: number;
  avg_price_pence: number;
  discount_share: number; // 0..1 fraction of carts where the line had a discount
}

export interface ServiceMixData {
  total_items: number;
  total_revenue_pence: number;
  category_distribution: ServiceCategoryEntry[];
  top_lines: ServiceLineEntry[]; // top 10 individual catalogue items by revenue
}

export function aggregateServiceMix(items: ServiceMixItem[]): ServiceMixData {
  const categoryAgg = new Map<string, ServiceCategoryEntry>();
  const lineAgg = new Map<
    string,
    {
      catalogue_id: string | null;
      name: string;
      count: number;
      revenue_pence: number;
      unit_prices: number[];
      carts_with_discount: number;
      total_carts: number;
    }
  >();

  let total_items = 0;
  let total_revenue_pence = 0;

  for (const it of items) {
    const cat = pickOne(it.catalogue);
    const cart = pickOne(it.cart);
    if (!cart || !pickOne(cart.visit)) continue;
    const groupKey =
      (cat?.category && cat.category.trim().length > 0 && cat.category.trim()) ||
      (cat?.service_type && humaniseServiceType(cat.service_type)) ||
      'Other';
    total_items += it.quantity;
    total_revenue_pence += it.line_total_pence;

    const prior = categoryAgg.get(groupKey);
    if (prior) {
      prior.count += it.quantity;
      prior.revenue_pence += it.line_total_pence;
    } else {
      categoryAgg.set(groupKey, {
        category: groupKey,
        count: it.quantity,
        revenue_pence: it.line_total_pence,
      });
    }

    const lineKey = it.catalogue_id ?? `__ad_hoc__${it.name}`;
    const priorLine = lineAgg.get(lineKey);
    const hadDiscount = it.discount_pence > 0 || (cart.discount_pence ?? 0) > 0;
    if (priorLine) {
      priorLine.count += it.quantity;
      priorLine.revenue_pence += it.line_total_pence;
      priorLine.unit_prices.push(it.unit_price_pence);
      priorLine.total_carts += 1;
      if (hadDiscount) priorLine.carts_with_discount += 1;
    } else {
      lineAgg.set(lineKey, {
        catalogue_id: it.catalogue_id,
        name: it.name,
        count: it.quantity,
        revenue_pence: it.line_total_pence,
        unit_prices: [it.unit_price_pence],
        carts_with_discount: hadDiscount ? 1 : 0,
        total_carts: 1,
      });
    }
  }

  const category_distribution = Array.from(categoryAgg.values()).sort(
    (a, b) => b.revenue_pence - a.revenue_pence,
  );

  const top_lines = Array.from(lineAgg.values())
    .map((l) => ({
      catalogue_id: l.catalogue_id,
      name: l.name,
      count: l.count,
      revenue_pence: l.revenue_pence,
      avg_price_pence:
        l.unit_prices.length > 0
          ? Math.round(l.unit_prices.reduce((s, n) => s + n, 0) / l.unit_prices.length)
          : 0,
      discount_share: l.total_carts > 0 ? l.carts_with_discount / l.total_carts : 0,
    }))
    .sort((a, b) => b.revenue_pence - a.revenue_pence)
    .slice(0, 10);

  return { total_items, total_revenue_pence, category_distribution, top_lines };
}

function humaniseServiceType(st: string): string {
  switch (st) {
    case 'denture_repair':
      return 'Denture repair';
    case 'click_in_veneers':
      return 'Click-in veneers';
    case 'same_day_appliance':
      return 'Same-day appliance';
    case 'impression_appointment':
      return 'Impression';
    default:
      return st.replace(/_/g, ' ');
  }
}

interface ServiceMixResult {
  data: ServiceMixData | null;
  loading: boolean;
  error: string | null;
}

export function useReportsServices(range: DateRange): ServiceMixResult {
  const [data, setData] = useState<ServiceMixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        const itemsRes = await supabase
          .from('lng_cart_items')
          .select(
            `id, name, catalogue_id, line_total_pence, unit_price_pence, discount_pence, quantity,
             cart:lng_carts!inner ( id, status, discount_pence, visit:lng_visits!inner ( id, opened_at ) ),
             catalogue:lwo_catalogue ( service_type, category )`,
          )
          .is('removed_at', null)
          .gte('cart.visit.opened_at', fromIso)
          .lte('cart.visit.opened_at', toIso);
        if (cancelled) return;
        if (itemsRes.error) throw new Error(`service_mix: ${itemsRes.error.message}`);
        const items = (itemsRes.data ?? []) as ServiceMixItem[];
        const out = aggregateServiceMix(items);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load service mix';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.service_mix',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient lifetime value
//
// "What's the patient base for this period worth all-time, and what
// does their engagement loop look like?" Two queries:
//
//   1. lng_visits in range — picks the patient population.
//   2. For those patients, all-time succeeded payments + visit
//      counts.
//
// Surfaces top spenders, repeat-visit distribution, days-between-
// visits as a median.
// ─────────────────────────────────────────────────────────────────────────────

export interface LifetimeValuePatientRow {
  patient_id: string;
  display_name: string;
  visits: number;
  all_time_spend_pence: number;
  first_visit: string | null;
  last_visit: string | null;
}

export interface RepeatBucket {
  bucket: string; // "1 visit", "2-3", "4-6", "7+"
  patients: number;
}

export interface LifetimeValueData {
  cohort_size: number;
  cohort_revenue_pence: number;
  median_days_between_visits: number | null;
  repeat_distribution: RepeatBucket[];
  top_spenders: LifetimeValuePatientRow[];
}

interface LtvCohortVisit {
  patient_id: string;
}

interface LtvAllTimeVisit {
  id: string;
  patient_id: string;
  opened_at: string;
  patient:
    | { id: string; first_name: string | null; last_name: string | null; name: string | null }
    | { id: string; first_name: string | null; last_name: string | null; name: string | null }[]
    | null;
  cart:
    | { id: string; status: string; total_pence: number | null }
    | { id: string; status: string; total_pence: number | null }[]
    | null;
}

export function aggregateLifetimeValue(
  cohortPatientIds: string[],
  allTimeVisits: LtvAllTimeVisit[],
): LifetimeValueData {
  const cohort = new Set(cohortPatientIds);
  const perPatient = new Map<
    string,
    {
      patient_id: string;
      display_name: string;
      visits: number;
      all_time_spend_pence: number;
      visit_dates: number[]; // ms timestamps for median-gap calc
    }
  >();
  for (const v of allTimeVisits) {
    if (!cohort.has(v.patient_id)) continue;
    const p = pickOne(v.patient);
    const cart = pickOne(v.cart);
    const paid = cart && cart.status === 'paid' && typeof cart.total_pence === 'number'
      ? cart.total_pence
      : 0;
    const display = composeDisplay(p);
    const t = new Date(v.opened_at).getTime();
    const prior = perPatient.get(v.patient_id);
    if (prior) {
      prior.visits += 1;
      prior.all_time_spend_pence += paid;
      prior.visit_dates.push(t);
    } else {
      perPatient.set(v.patient_id, {
        patient_id: v.patient_id,
        display_name: display,
        visits: 1,
        all_time_spend_pence: paid,
        visit_dates: [t],
      });
    }
  }

  const patients = Array.from(perPatient.values());
  const cohort_size = patients.length;
  const cohort_revenue_pence = patients.reduce((s, p) => s + p.all_time_spend_pence, 0);

  // Days-between-visits across every patient with 2+ visits. Pool
  // all gaps then take the median — robust to outliers.
  const allGaps: number[] = [];
  for (const p of patients) {
    if (p.visit_dates.length < 2) continue;
    const sorted = [...p.visit_dates].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      allGaps.push((b - a) / (1000 * 60 * 60 * 24));
    }
  }
  const median_days_between_visits = allGaps.length === 0 ? null : median(allGaps);

  // Repeat-visit distribution buckets.
  const buckets = [
    { bucket: '1 visit', match: (n: number) => n === 1 },
    { bucket: '2–3', match: (n: number) => n === 2 || n === 3 },
    { bucket: '4–6', match: (n: number) => n >= 4 && n <= 6 },
    { bucket: '7+', match: (n: number) => n >= 7 },
  ];
  const repeat_distribution: RepeatBucket[] = buckets.map((b) => ({
    bucket: b.bucket,
    patients: patients.filter((p) => b.match(p.visits)).length,
  }));

  const top_spenders = patients
    .filter((p) => p.all_time_spend_pence > 0)
    .map((p) => ({
      patient_id: p.patient_id,
      display_name: p.display_name,
      visits: p.visits,
      all_time_spend_pence: p.all_time_spend_pence,
      first_visit: p.visit_dates.length > 0
        ? new Date(Math.min(...p.visit_dates)).toISOString()
        : null,
      last_visit: p.visit_dates.length > 0
        ? new Date(Math.max(...p.visit_dates)).toISOString()
        : null,
    }))
    .sort((a, b) => b.all_time_spend_pence - a.all_time_spend_pence)
    .slice(0, 20);

  return {
    cohort_size,
    cohort_revenue_pence,
    median_days_between_visits,
    repeat_distribution,
    top_spenders,
  };
}

function composeDisplay(
  p: { first_name: string | null; last_name: string | null; name: string | null } | null,
): string {
  if (!p) return 'Unknown patient';
  // Title Case patient + staff names so "BETH MACKAY" and
  // "beth mackay" both render as "Beth Mackay" in lifetime-value
  // top-spender lists, etc.
  const fn = properCase(p.first_name);
  const ln = properCase(p.last_name);
  if (fn && ln) return `${fn} ${ln}`;
  return fn || ln || properCase(p.name) || 'Unknown patient';
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1];
    const b = sorted[mid];
    if (typeof a !== 'number' || typeof b !== 'number') return 0;
    return (a + b) / 2;
  }
  const m = sorted[mid];
  return typeof m === 'number' ? m : 0;
}

interface LifetimeValueResult {
  data: LifetimeValueData | null;
  loading: boolean;
  error: string | null;
}

export function useReportsLifetimeValue(range: DateRange): LifetimeValueResult {
  const [data, setData] = useState<LifetimeValueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    (async () => {
      try {
        // 1) Identify the cohort: patients with a visit in the range.
        const cohortRes = await supabase
          .from('lng_visits')
          .select('patient_id')
          .gte('opened_at', fromIso)
          .lte('opened_at', toIso);
        if (cancelled) return;
        if (cohortRes.error) throw new Error(`cohort: ${cohortRes.error.message}`);
        const cohortIds = Array.from(
          new Set(
            ((cohortRes.data ?? []) as LtvCohortVisit[]).map((r) => r.patient_id),
          ),
        );
        if (cohortIds.length === 0) {
          if (cancelled) return;
          setData({
            cohort_size: 0,
            cohort_revenue_pence: 0,
            median_days_between_visits: null,
            repeat_distribution: [
              { bucket: '1 visit', patients: 0 },
              { bucket: '2–3', patients: 0 },
              { bucket: '4–6', patients: 0 },
              { bucket: '7+', patients: 0 },
            ],
            top_spenders: [],
          });
          setLoading(false);
          return;
        }
        // 2) All-time visits for those patients (no time filter), so
        //    we can compute their lifetime spend + visit cadence.
        const allRes = await supabase
          .from('lng_visits')
          .select(
            `id, patient_id, opened_at,
             patient:patients!inner ( id, first_name, last_name ),
             cart:lng_carts ( id, status, total_pence )`,
          )
          .in('patient_id', cohortIds);
        if (cancelled) return;
        if (allRes.error) throw new Error(`ltv: ${allRes.error.message}`);
        const allVisits = (allRes.data ?? []) as LtvAllTimeVisit[];
        const out = aggregateLifetimeValue(cohortIds, allVisits);
        if (cancelled) return;
        setData(out);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load lifetime value';
        setError(message);
        setLoading(false);
        await logFailure({
          source: 'reports.lifetime_value',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────

export function useReportsOverview(range: DateRange): OverviewResult {
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { fromIso, toIso } = dateRangeToUtcBounds(range);

    (async () => {
      try {
        const [visitsRes, paymentsRes, itemsRes] = await Promise.all([
          supabase
            .from('lng_visits')
            .select(
              `id, patient_id, arrival_type, opened_at, closed_at, status,
               cart:lng_carts ( id, total_pence, subtotal_pence, discount_pence, status )`,
            )
            .gte('opened_at', fromIso)
            .lte('opened_at', toIso),
          supabase
            .from('lng_payments')
            .select('id, amount_pence, method, payment_journey, succeeded_at')
            .eq('status', 'succeeded')
            .gte('succeeded_at', fromIso)
            .lte('succeeded_at', toIso),
          supabase
            .from('lng_cart_items')
            .select(
              // !inner on cart and visit promotes the embedded joins to
              // INNER JOINs so the root-level filter on the visit's
              // opened_at actually limits which lng_cart_items come back.
              // Without !inner PostgREST would still return every item
              // and just null the embedded join when the visit was out
              // of range — wrong shape for "items whose visit landed in
              // this period".
              `id, name, catalogue_id, line_total_pence, quantity,
               cart:lng_carts!inner ( id, visit:lng_visits!inner ( id, opened_at ) )`,
            )
            .is('removed_at', null)
            .gte('cart.visit.opened_at', fromIso)
            .lte('cart.visit.opened_at', toIso),
        ]);

        if (cancelled) return;

        if (visitsRes.error) throw new Error(`visits: ${visitsRes.error.message}`);
        if (paymentsRes.error) throw new Error(`payments: ${paymentsRes.error.message}`);
        if (itemsRes.error) throw new Error(`items: ${itemsRes.error.message}`);

        const visits = (visitsRes.data ?? []) as ReportsOverviewVisit[];
        const payments = (paymentsRes.data ?? []) as ReportsOverviewPayment[];
        const items = (itemsRes.data ?? []) as ReportsOverviewItem[];
        const overview = aggregateOverview(visits, payments, items);
        if (cancelled) return;
        setData(overview);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'Could not load overview';
        setError(message);
        setLoading(false);
        // Loud failure so the operator sees it on the Failures tab,
        // not just in the page's inline error state.
        await logFailure({
          source: 'reports.overview',
          severity: 'error',
          message,
          context: { range },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range]);

  return { data, loading, error };
}
