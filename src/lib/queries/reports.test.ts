import { describe, expect, it } from 'vitest';
import {
  aggregateOverview,
  type ReportsOverviewItem,
  type ReportsOverviewPayment,
  type ReportsOverviewVisit,
} from './reports.ts';

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
