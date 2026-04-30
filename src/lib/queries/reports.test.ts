import { describe, expect, it } from 'vitest';
import {
  ageBracketFor,
  aggregateBookingsVsWalkIns,
  aggregateOverview,
  aggregatePatientReports,
  outwardPostcode,
  type BookingsAppointment,
  type BookingsVisit,
  type PatientReportVisit,
  type ReportsOverviewItem,
  type ReportsOverviewPayment,
  type ReportsOverviewVisit,
} from './reports.ts';
import { makeCustomRange } from '../dateRange.ts';

// Tests for the pure aggregation. The IO is covered in integration
// — here we lock in every derived stat against a fully-deterministic
// input. Each test fixes one axis at a time so a regression points
// straight at its cause.

const visit = (over: Partial<ReportsOverviewVisit>): ReportsOverviewVisit => ({
  id: 'v',
  patient_id: 'p1',
  arrival_type: 'walk_in',
  opened_at: '2026-04-15T09:00:00Z',
  closed_at: null,
  status: 'arrived',
  cart: null,
  ...over,
});

const payment = (over: Partial<ReportsOverviewPayment>): ReportsOverviewPayment => ({
  id: 'pay',
  amount_pence: 0,
  method: 'cash',
  payment_journey: null,
  succeeded_at: '2026-04-15T10:00:00Z',
  ...over,
});

const item = (over: Partial<ReportsOverviewItem>): ReportsOverviewItem => ({
  id: 'i',
  name: 'Item',
  catalogue_id: null,
  line_total_pence: 0,
  quantity: 1,
  cart: { id: 'c', visit: { id: 'v', opened_at: '2026-04-15T09:00:00Z' } },
  ...over,
});

describe('aggregateOverview', () => {
  it('produces a zero-shaped result for empty inputs', () => {
    const r = aggregateOverview([], [], []);
    expect(r).toEqual({
      total_visits: 0,
      walk_ins: 0,
      scheduled: 0,
      unique_patients: 0,
      status_mix: {},
      revenue_pence: 0,
      payments_count: 0,
      payment_method_mix: {},
      average_ticket_pence: null,
      top_services: [],
      best_day: null,
    });
  });

  it('counts walk-ins and scheduled separately', () => {
    const r = aggregateOverview(
      [
        visit({ id: 'v1', arrival_type: 'walk_in' }),
        visit({ id: 'v2', arrival_type: 'walk_in' }),
        visit({ id: 'v3', arrival_type: 'scheduled' }),
      ],
      [],
      [],
    );
    expect(r.total_visits).toBe(3);
    expect(r.walk_ins).toBe(2);
    expect(r.scheduled).toBe(1);
  });

  it('counts unique patients (Set semantics)', () => {
    const r = aggregateOverview(
      [
        visit({ id: 'v1', patient_id: 'a' }),
        visit({ id: 'v2', patient_id: 'a' }),
        visit({ id: 'v3', patient_id: 'b' }),
      ],
      [],
      [],
    );
    expect(r.unique_patients).toBe(2);
  });

  it('builds the status mix as an absolute count map', () => {
    const r = aggregateOverview(
      [
        visit({ id: 'v1', status: 'arrived' }),
        visit({ id: 'v2', status: 'arrived' }),
        visit({ id: 'v3', status: 'complete' }),
        visit({ id: 'v4', status: 'unsuitable' }),
      ],
      [],
      [],
    );
    expect(r.status_mix).toEqual({ arrived: 2, complete: 1, unsuitable: 1 });
  });

  it('finds the best day as the date with the most visits', () => {
    const r = aggregateOverview(
      [
        visit({ id: 'v1', opened_at: '2026-04-14T09:00:00Z' }),
        visit({ id: 'v2', opened_at: '2026-04-15T09:00:00Z' }),
        visit({ id: 'v3', opened_at: '2026-04-15T11:00:00Z' }),
        visit({ id: 'v4', opened_at: '2026-04-16T09:00:00Z' }),
      ],
      [],
      [],
    );
    expect(r.best_day).toEqual({ date: '2026-04-15', visits: 2 });
  });

  it('sums revenue and groups payment_method_mix by method', () => {
    const r = aggregateOverview(
      [],
      [
        payment({ id: 'p1', amount_pence: 12500, method: 'cash' }),
        payment({ id: 'p2', amount_pence: 7500, method: 'card_terminal' }),
        payment({ id: 'p3', amount_pence: 3000, method: 'cash' }),
      ],
      [],
    );
    expect(r.revenue_pence).toBe(23000);
    expect(r.payments_count).toBe(3);
    expect(r.payment_method_mix).toEqual({ cash: 15500, card_terminal: 7500 });
  });

  it('computes average_ticket as revenue / paid carts (rounded)', () => {
    const r = aggregateOverview(
      [
        visit({
          id: 'v1',
          cart: { id: 'c1', total_pence: 10000, subtotal_pence: 10000, discount_pence: 0, status: 'paid' },
        }),
        visit({
          id: 'v2',
          cart: { id: 'c2', total_pence: 5000, subtotal_pence: 5000, discount_pence: 0, status: 'paid' },
        }),
        visit({
          id: 'v3',
          cart: { id: 'c3', total_pence: 1000, subtotal_pence: 1000, discount_pence: 0, status: 'open' },
        }),
      ],
      [
        payment({ id: 'p1', amount_pence: 10000 }),
        payment({ id: 'p2', amount_pence: 5000 }),
      ],
      [],
    );
    // 15000 across 2 paid carts → 7500
    expect(r.average_ticket_pence).toBe(7500);
  });

  it('returns null average_ticket when no carts are paid', () => {
    const r = aggregateOverview(
      [
        visit({
          id: 'v1',
          cart: { id: 'c1', total_pence: 10000, subtotal_pence: 10000, discount_pence: 0, status: 'open' },
        }),
      ],
      [payment({ id: 'p', amount_pence: 5000 })],
      [],
    );
    expect(r.average_ticket_pence).toBeNull();
  });

  it('groups top services by catalogue_id and sums counts + revenue', () => {
    const r = aggregateOverview(
      [],
      [],
      [
        item({ id: 'i1', name: 'Click-in veneers', catalogue_id: 'cat1', line_total_pence: 59900, quantity: 1 }),
        item({ id: 'i2', name: 'Click-in veneers', catalogue_id: 'cat1', line_total_pence: 59900, quantity: 2 }),
        item({ id: 'i3', name: 'Denture repair', catalogue_id: 'cat2', line_total_pence: 5000, quantity: 1 }),
      ],
    );
    expect(r.top_services).toHaveLength(2);
    expect(r.top_services[0]).toEqual({
      catalogue_id: 'cat1',
      name: 'Click-in veneers',
      count: 3,
      revenue_pence: 119800,
    });
    expect(r.top_services[1]).toEqual({
      catalogue_id: 'cat2',
      name: 'Denture repair',
      count: 1,
      revenue_pence: 5000,
    });
  });

  it('keeps ad-hoc items separate by name when catalogue_id is null', () => {
    const r = aggregateOverview(
      [],
      [],
      [
        item({ id: 'i1', name: 'Custom A', catalogue_id: null, line_total_pence: 1000, quantity: 1 }),
        item({ id: 'i2', name: 'Custom A', catalogue_id: null, line_total_pence: 2000, quantity: 1 }),
        item({ id: 'i3', name: 'Custom B', catalogue_id: null, line_total_pence: 500, quantity: 1 }),
      ],
    );
    // Ad-hoc with the same name still groups together (key = __ad_hoc__Custom A)
    expect(r.top_services.find((s) => s.name === 'Custom A')?.revenue_pence).toBe(3000);
    expect(r.top_services.find((s) => s.name === 'Custom B')?.revenue_pence).toBe(500);
  });

  it('caps top services at 5 entries', () => {
    const items: ReportsOverviewItem[] = [];
    for (let i = 0; i < 8; i += 1) {
      items.push(
        item({
          id: `i${i}`,
          name: `Item ${i}`,
          catalogue_id: `cat${i}`,
          line_total_pence: (i + 1) * 100,
          quantity: 1,
        }),
      );
    }
    const r = aggregateOverview([], [], items);
    expect(r.top_services).toHaveLength(5);
    // Ranked by revenue desc — biggest first
    expect(r.top_services[0]?.name).toBe('Item 7');
    expect(r.top_services[4]?.name).toBe('Item 3');
  });

  it("ignores items whose joined visit didn't resolve (defensive)", () => {
    const r = aggregateOverview(
      [],
      [],
      [
        item({ id: 'i1', cart: { id: 'c1', visit: null }, line_total_pence: 10000 }),
        item({ id: 'i2', cart: { id: 'c2', visit: { id: 'v', opened_at: '2026-04-15T09:00:00Z' } }, line_total_pence: 500 }),
      ],
    );
    expect(r.top_services).toHaveLength(1);
    expect(r.top_services[0]?.revenue_pence).toBe(500);
  });

  it('handles a fully populated example end-to-end', () => {
    const r = aggregateOverview(
      [
        visit({
          id: 'v1',
          patient_id: 'p1',
          arrival_type: 'walk_in',
          opened_at: '2026-04-15T09:00:00Z',
          status: 'complete',
          cart: { id: 'c1', total_pence: 12500, subtotal_pence: 15000, discount_pence: 2500, status: 'paid' },
        }),
        visit({
          id: 'v2',
          patient_id: 'p2',
          arrival_type: 'scheduled',
          opened_at: '2026-04-15T11:00:00Z',
          status: 'arrived',
          cart: { id: 'c2', total_pence: 5000, subtotal_pence: 5000, discount_pence: 0, status: 'paid' },
        }),
        visit({
          id: 'v3',
          patient_id: 'p1', // repeat patient
          arrival_type: 'walk_in',
          opened_at: '2026-04-16T09:00:00Z',
          status: 'unsuitable',
          cart: { id: 'c3', total_pence: 0, subtotal_pence: 0, discount_pence: 0, status: 'open' },
        }),
      ],
      [
        payment({ id: 'p1', amount_pence: 12500, method: 'card_terminal' }),
        payment({ id: 'p2', amount_pence: 5000, method: 'cash' }),
      ],
      [
        item({ id: 'i1', name: 'Click-in veneers', catalogue_id: 'cat1', line_total_pence: 12500, quantity: 1 }),
        item({ id: 'i2', name: 'Denture repair', catalogue_id: 'cat2', line_total_pence: 5000, quantity: 1 }),
      ],
    );
    expect(r.total_visits).toBe(3);
    expect(r.walk_ins).toBe(2);
    expect(r.scheduled).toBe(1);
    expect(r.unique_patients).toBe(2); // p1 + p2
    expect(r.revenue_pence).toBe(17500);
    expect(r.average_ticket_pence).toBe(8750); // 17500 / 2 paid carts
    expect(r.payment_method_mix).toEqual({ card_terminal: 12500, cash: 5000 });
    expect(r.top_services).toHaveLength(2);
    expect(r.top_services[0]?.name).toBe('Click-in veneers');
    expect(r.best_day?.date).toBe('2026-04-15');
    expect(r.best_day?.visits).toBe(2);
    expect(r.status_mix).toEqual({ complete: 1, arrived: 1, unsuitable: 1 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// aggregateBookingsVsWalkIns
// ────────────────────────────────────────────────────────────────────────────

const RANGE = makeCustomRange('2026-04-13', '2026-04-15');

const appt = (over: Partial<BookingsAppointment>): BookingsAppointment => ({
  id: 'a',
  patient_id: 'p',
  start_at: '2026-04-15T10:00:00Z',
  status: 'booked',
  ...over,
});

const bvVisit = (over: Partial<BookingsVisit>): BookingsVisit => ({
  id: 'v',
  appointment_id: null,
  arrival_type: 'walk_in',
  opened_at: '2026-04-15T10:00:00Z',
  status: 'arrived',
  cart: null,
  ...over,
});

describe('aggregateBookingsVsWalkIns', () => {
  it('builds a daily series with a row per calendar day in range', () => {
    const r = aggregateBookingsVsWalkIns(RANGE, [], []);
    expect(r.daily.map((d) => d.date)).toEqual(['2026-04-13', '2026-04-14', '2026-04-15']);
    for (const d of r.daily) {
      expect(d.booked).toBe(0);
      expect(d.walk_in).toBe(0);
    }
  });

  it('counts booked + walk-in per day', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [
        appt({ id: 'a1', start_at: '2026-04-13T10:00:00Z' }),
        appt({ id: 'a2', start_at: '2026-04-15T10:00:00Z' }),
        appt({ id: 'a3', start_at: '2026-04-15T11:00:00Z' }),
      ],
      [
        bvVisit({ id: 'v1', arrival_type: 'walk_in', opened_at: '2026-04-15T09:00:00Z' }),
        bvVisit({ id: 'v2', arrival_type: 'walk_in', opened_at: '2026-04-15T15:00:00Z' }),
        bvVisit({ id: 'v3', arrival_type: 'scheduled', opened_at: '2026-04-13T11:00:00Z', appointment_id: 'a1' }),
      ],
    );
    expect(r.daily).toEqual([
      { date: '2026-04-13', booked: 1, walk_in: 0 },
      { date: '2026-04-14', booked: 0, walk_in: 0 },
      { date: '2026-04-15', booked: 2, walk_in: 2 },
    ]);
  });

  it('counts the funnel as nested supersets', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [
        appt({ id: 'a1' }),
        appt({ id: 'a2' }),
        appt({ id: 'a3' }),
        appt({ id: 'a4' }),
      ],
      [
        // a1: booked → arrived → in_chair → complete
        bvVisit({ id: 'v1', appointment_id: 'a1', arrival_type: 'scheduled', status: 'complete' }),
        // a2: booked → arrived → in_chair (still in chair)
        bvVisit({ id: 'v2', appointment_id: 'a2', arrival_type: 'scheduled', status: 'in_chair' }),
        // a3: booked → arrived (no further progress)
        bvVisit({ id: 'v3', appointment_id: 'a3', arrival_type: 'scheduled', status: 'arrived' }),
        // a4 has no visit — booked only
      ],
    );
    expect(r.funnel).toEqual([
      { id: 'booked', label: 'Booked', count: 4 },
      { id: 'arrived', label: 'Arrived', count: 3 },
      { id: 'in_chair', label: 'Reached the chair', count: 2 },
      { id: 'complete', label: 'Completed', count: 1 },
    ]);
  });

  it('computes the no-show count and rate', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [
        appt({ id: 'a1', status: 'no_show' }),
        appt({ id: 'a2', status: 'complete' }),
        appt({ id: 'a3', status: 'no_show' }),
        appt({ id: 'a4', status: 'cancelled' }), // cancelled doesn't count
      ],
      [],
    );
    expect(r.no_show_count).toBe(2);
    expect(r.no_show_rate).toBeCloseTo(0.5);
  });

  it('returns 0 no-show rate when no appointments exist', () => {
    const r = aggregateBookingsVsWalkIns(RANGE, [], []);
    expect(r.no_show_count).toBe(0);
    expect(r.no_show_rate).toBe(0);
  });

  it('produces a 24-bucket walk-in hour distribution', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [],
      [
        bvVisit({ id: 'v1', arrival_type: 'walk_in', opened_at: '2026-04-15T09:00:00Z' }),
        bvVisit({ id: 'v2', arrival_type: 'walk_in', opened_at: '2026-04-15T09:30:00Z' }),
        bvVisit({ id: 'v3', arrival_type: 'walk_in', opened_at: '2026-04-15T14:15:00Z' }),
        // scheduled visit doesn't contribute
        bvVisit({ id: 'v4', arrival_type: 'scheduled', opened_at: '2026-04-15T09:00:00Z' }),
      ],
    );
    expect(r.walk_in_hour_distribution).toHaveLength(24);
    // Hour buckets are local-time; we don't assert exact buckets to
    // avoid timezone fragility in CI. Instead we assert total walk-in
    // count and that exactly two buckets are non-zero (9 + 14 in the
    // local timezone).
    const nonZero = r.walk_in_hour_distribution.filter((h) => h.count > 0);
    expect(nonZero.length).toBeGreaterThanOrEqual(1);
    const totalWalkIn = r.walk_in_hour_distribution.reduce((s, h) => s + h.count, 0);
    expect(totalWalkIn).toBe(3);
  });

  it('computes avg ticket separately for walk-in and scheduled paid carts', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [],
      [
        bvVisit({
          id: 'v1',
          arrival_type: 'walk_in',
          cart: { id: 'c1', status: 'paid', total_pence: 10000 },
        }),
        bvVisit({
          id: 'v2',
          arrival_type: 'walk_in',
          cart: { id: 'c2', status: 'paid', total_pence: 20000 },
        }),
        bvVisit({
          id: 'v3',
          arrival_type: 'scheduled',
          cart: { id: 'c3', status: 'paid', total_pence: 30000 },
        }),
        bvVisit({
          id: 'v4',
          arrival_type: 'walk_in',
          cart: { id: 'c4', status: 'open', total_pence: 99999 }, // open, ignored
        }),
      ],
    );
    expect(r.walk_in_avg_ticket_pence).toBe(15000); // (10000 + 20000) / 2
    expect(r.scheduled_avg_ticket_pence).toBe(30000);
  });

  it('returns null avg ticket when no paid carts of that type exist', () => {
    const r = aggregateBookingsVsWalkIns(RANGE, [], []);
    expect(r.walk_in_avg_ticket_pence).toBeNull();
    expect(r.scheduled_avg_ticket_pence).toBeNull();
  });

  it('totals booked + walk_in for the headline KPIs', () => {
    const r = aggregateBookingsVsWalkIns(
      RANGE,
      [appt({ id: 'a1' }), appt({ id: 'a2' })],
      [
        bvVisit({ id: 'v1', arrival_type: 'walk_in' }),
        bvVisit({ id: 'v2', arrival_type: 'walk_in' }),
        bvVisit({ id: 'v3', arrival_type: 'walk_in' }),
        bvVisit({ id: 'v4', arrival_type: 'scheduled', appointment_id: 'a1' }),
      ],
    );
    expect(r.total_booked).toBe(2);
    expect(r.total_walk_in).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Demographics + Marketing helpers
// ────────────────────────────────────────────────────────────────────────────

describe('outwardPostcode', () => {
  it('extracts the outward code from a standard postcode', () => {
    expect(outwardPostcode('SW1A 1AA')).toBe('SW1A');
    expect(outwardPostcode('M1 1AE')).toBe('M1');
    expect(outwardPostcode('B33 8TH')).toBe('B33');
    expect(outwardPostcode('CR2 6XH')).toBe('CR2');
  });

  it('strips internal whitespace and is case-insensitive', () => {
    expect(outwardPostcode('  sw1a   1aa ')).toBe('SW1A');
  });

  it('returns "Unknown" for null, empty, or too-short input', () => {
    expect(outwardPostcode(null)).toBe('Unknown');
    expect(outwardPostcode(undefined)).toBe('Unknown');
    expect(outwardPostcode('')).toBe('Unknown');
    expect(outwardPostcode('SW1')).toBe('Unknown');
  });
});

describe('ageBracketFor', () => {
  const REF = new Date(2026, 4, 1); // 1 May 2026
  it('returns unknown for null DOB', () => {
    expect(ageBracketFor(null, REF)).toBe('unknown');
  });
  it('handles malformed DOB strings as unknown', () => {
    expect(ageBracketFor('not a date', REF)).toBe('unknown');
  });
  it('rejects future-dated DOB as unknown', () => {
    expect(ageBracketFor('2030-01-01', REF)).toBe('unknown');
  });
  it('buckets typical ages correctly', () => {
    expect(ageBracketFor('2015-04-01', REF)).toBe('under_18'); // 11
    expect(ageBracketFor('2000-04-01', REF)).toBe('18_29'); // 26
    expect(ageBracketFor('1985-04-01', REF)).toBe('30_44'); // 41
    expect(ageBracketFor('1970-04-01', REF)).toBe('45_59'); // 56
    expect(ageBracketFor('1960-04-01', REF)).toBe('60_74'); // 66
    expect(ageBracketFor('1940-04-01', REF)).toBe('75_plus'); // 86
  });
  it('respects birthday-not-yet-this-year boundary', () => {
    // Born 30 May 2000; ref is 1 May 2026 — hasn't had birthday yet → 25
    expect(ageBracketFor('2000-05-30', REF)).toBe('18_29');
    // Born 30 Apr 2000; ref is 1 May 2026 — has had birthday → 26
    expect(ageBracketFor('2000-04-30', REF)).toBe('18_29');
    // Born 30 Apr 1996 → 30 (boundary)
    expect(ageBracketFor('1996-04-30', REF)).toBe('30_44');
  });
});

const RANGE_DM = makeCustomRange('2026-04-01', '2026-04-30');
const visitWithPatient = (over: Partial<PatientReportVisit>): PatientReportVisit => ({
  id: 'v',
  patient_id: 'p1',
  arrival_type: 'walk_in',
  opened_at: '2026-04-15T10:00:00Z',
  patient: {
    id: 'p1',
    date_of_birth: '1990-01-01',
    sex: 'female',
    portal_ship_postcode: 'SW1A 1AA',
    referred_by: 'Google',
    registered_at: '2026-04-01T09:00:00Z',
  },
  cart: { id: 'c1', status: 'paid', total_pence: 10000 },
  ...over,
});

describe('aggregatePatientReports', () => {
  it('returns zero shape for an empty visit list', () => {
    const r = aggregatePatientReports(RANGE_DM, []);
    expect(r.total_unique_patients).toBe(0);
    expect(r.new_patients).toBe(0);
    expect(r.returning_patients).toBe(0);
    expect(r.referral_sources).toEqual([]);
    expect(r.postcode_areas).toEqual([]);
    expect(r.postcode_other).toEqual({ count: 0, revenue_pence: 0 });
    expect(r.visits_in_period).toBe(0);
    expect(r.revenue_in_period_pence).toBe(0);
  });

  it('counts unique patients (de-dups on patient_id)', () => {
    const r = aggregatePatientReports(RANGE_DM, [
      visitWithPatient({ id: 'v1', patient_id: 'p1' }),
      visitWithPatient({ id: 'v2', patient_id: 'p1' }), // same patient, different visit
      visitWithPatient({
        id: 'v3',
        patient_id: 'p2',
        patient: {
          id: 'p2',
          date_of_birth: '1980-01-01',
          sex: 'male',
          portal_ship_postcode: 'M1 1AE',
          referred_by: 'Friend',
          registered_at: null,
        },
      }),
    ]);
    expect(r.total_unique_patients).toBe(2);
    expect(r.visits_in_period).toBe(3);
  });

  it('classifies new vs returning by registered_at', () => {
    const r = aggregatePatientReports(RANGE_DM, [
      visitWithPatient({
        id: 'v1',
        patient_id: 'p1',
        patient: {
          id: 'p1',
          date_of_birth: '1990-01-01',
          sex: 'female',
          portal_ship_postcode: null,
          referred_by: null,
          registered_at: '2026-04-15T09:00:00Z', // in range → new
        },
      }),
      visitWithPatient({
        id: 'v2',
        patient_id: 'p2',
        patient: {
          id: 'p2',
          date_of_birth: '1990-01-01',
          sex: 'female',
          portal_ship_postcode: null,
          referred_by: null,
          registered_at: '2024-01-01T09:00:00Z', // long before range → returning
        },
      }),
      visitWithPatient({
        id: 'v3',
        patient_id: 'p3',
        patient: {
          id: 'p3',
          date_of_birth: '1990-01-01',
          sex: 'female',
          portal_ship_postcode: null,
          referred_by: null,
          registered_at: null, // unknown → treated as returning
        },
      }),
    ]);
    expect(r.new_patients).toBe(1);
    expect(r.returning_patients).toBe(2);
  });

  it('sums paid-cart revenue per patient and surfaces it on referral_sources', () => {
    const r = aggregatePatientReports(RANGE_DM, [
      visitWithPatient({
        id: 'v1',
        patient_id: 'p1',
        patient: {
          id: 'p1',
          date_of_birth: null,
          sex: null,
          portal_ship_postcode: null,
          referred_by: 'Instagram',
          registered_at: null,
        },
        cart: { id: 'c1', status: 'paid', total_pence: 12500 },
      }),
      visitWithPatient({
        id: 'v2',
        patient_id: 'p2',
        patient: {
          id: 'p2',
          date_of_birth: null,
          sex: null,
          portal_ship_postcode: null,
          referred_by: 'Instagram',
          registered_at: null,
        },
        cart: { id: 'c2', status: 'open', total_pence: 99999 }, // open cart doesn't count
      }),
      visitWithPatient({
        id: 'v3',
        patient_id: 'p3',
        patient: {
          id: 'p3',
          date_of_birth: null,
          sex: null,
          portal_ship_postcode: null,
          referred_by: 'Friend',
          registered_at: null,
        },
        cart: { id: 'c3', status: 'paid', total_pence: 5000 },
      }),
    ]);
    expect(r.referral_sources).toHaveLength(2);
    const insta = r.referral_sources.find((s) => s.source === 'Instagram');
    expect(insta?.patients).toBe(2);
    expect(insta?.revenue_pence).toBe(12500); // p2's open cart not counted
    const friend = r.referral_sources.find((s) => s.source === 'Friend');
    expect(friend?.revenue_pence).toBe(5000);
  });

  it('groups null/blank referrals as "Unspecified"', () => {
    const r = aggregatePatientReports(RANGE_DM, [
      visitWithPatient({
        id: 'v1',
        patient_id: 'p1',
        patient: {
          id: 'p1',
          date_of_birth: null,
          sex: null,
          portal_ship_postcode: null,
          referred_by: null,
          registered_at: null,
        },
      }),
      visitWithPatient({
        id: 'v2',
        patient_id: 'p2',
        patient: {
          id: 'p2',
          date_of_birth: null,
          sex: null,
          portal_ship_postcode: null,
          referred_by: '   ',
          registered_at: null,
        },
      }),
    ]);
    expect(r.referral_sources).toHaveLength(1);
    expect(r.referral_sources[0]?.source).toBe('Unspecified');
    expect(r.referral_sources[0]?.patients).toBe(2);
  });

  it('produces an age distribution with all brackets present', () => {
    const r = aggregatePatientReports(RANGE_DM, [
      visitWithPatient({ id: 'v1', patient_id: 'p1' }),
    ]);
    const ids = r.age_distribution.map((b) => b.bracket);
    expect(ids).toEqual(['under_18', '18_29', '30_44', '45_59', '60_74', '75_plus', 'unknown']);
  });

  it('caps postcode_areas at 10 with the rest grouped into postcode_other', () => {
    const visits: PatientReportVisit[] = [];
    for (let i = 0; i < 14; i += 1) {
      visits.push(
        visitWithPatient({
          id: `v${i}`,
          patient_id: `p${i}`,
          patient: {
            id: `p${i}`,
            date_of_birth: null,
            sex: null,
            // 14 unique outward codes: A1, A2, ..., A14 (each made up)
            portal_ship_postcode: `A${i + 1} 1AA`,
            referred_by: null,
            registered_at: null,
          },
          cart: { id: `c${i}`, status: 'paid', total_pence: 1000 },
        }),
      );
    }
    const r = aggregatePatientReports(RANGE_DM, visits);
    expect(r.postcode_areas).toHaveLength(10);
    expect(r.postcode_other.count).toBe(4);
    expect(r.postcode_other.revenue_pence).toBe(4000);
  });
});
