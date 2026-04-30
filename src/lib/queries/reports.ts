import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { type DateRange, dateRangeToUtcBounds } from '../dateRange.ts';
import { addDaysIso } from '../calendarMonth.ts';
import { logFailure } from '../failureLog.ts';

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
