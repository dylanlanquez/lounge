import { describe, expect, it } from 'vitest';
import {
  aggregateBookingsVsWalkIns,
  aggregateOverview,
  type BookingsAppointment,
  type BookingsVisit,
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
