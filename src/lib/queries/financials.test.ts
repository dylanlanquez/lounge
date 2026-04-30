import { describe, expect, it } from 'vitest';
import {
  aggregateFinancialsOverview,
  shapeDiscounts,
  shapeSalesRows,
  shapeVoids,
  type FinancialsOverviewPayment,
} from './financials.ts';
import { makeCustomRange } from '../dateRange.ts';

const RANGE = makeCustomRange('2026-04-13', '2026-04-15');

const pay = (over: Partial<FinancialsOverviewPayment>): FinancialsOverviewPayment => ({
  id: 'p',
  amount_pence: 0,
  method: 'cash',
  status: 'succeeded',
  succeeded_at: '2026-04-15T10:00:00Z',
  cancelled_at: null,
  taken_by: null,
  ...over,
});

describe('aggregateFinancialsOverview', () => {
  it('produces a zero-shaped result on empty input', () => {
    const r = aggregateFinancialsOverview(RANGE, []);
    expect(r.total_revenue_pence).toBe(0);
    expect(r.payments_count).toBe(0);
    expect(r.voided_count).toBe(0);
    expect(r.failed_count).toBe(0);
    expect(r.daily.map((d) => d.pence)).toEqual([0, 0, 0]);
    expect(r.method_mix).toEqual([]);
  });

  it('sums revenue + groups by method on succeeded', () => {
    const r = aggregateFinancialsOverview(RANGE, [
      pay({ id: 'p1', amount_pence: 12500, method: 'cash' }),
      pay({ id: 'p2', amount_pence: 7500, method: 'card_terminal' }),
      pay({ id: 'p3', amount_pence: 3000, method: 'cash' }),
    ]);
    expect(r.total_revenue_pence).toBe(23000);
    expect(r.payments_count).toBe(3);
    expect(r.method_mix).toEqual([
      { method: 'cash', pence: 15500, count: 2 },
      { method: 'card_terminal', pence: 7500, count: 1 },
    ]);
  });

  it('counts cancelled separately and includes their amounts', () => {
    const r = aggregateFinancialsOverview(RANGE, [
      pay({ id: 'p1', amount_pence: 5000, status: 'succeeded' }),
      pay({ id: 'p2', amount_pence: 12000, status: 'cancelled', succeeded_at: null, cancelled_at: '2026-04-14T10:00:00Z' }),
    ]);
    expect(r.voided_count).toBe(1);
    expect(r.voided_pence).toBe(12000);
    // Voids don't show up in revenue.
    expect(r.total_revenue_pence).toBe(5000);
  });

  it('counts failed separately', () => {
    const r = aggregateFinancialsOverview(RANGE, [
      pay({ id: 'p1', status: 'failed', amount_pence: 5000, succeeded_at: null }),
      pay({ id: 'p2', status: 'failed', amount_pence: 1000, succeeded_at: null }),
    ]);
    expect(r.failed_count).toBe(2);
  });

  it('builds a zero-padded daily series for every calendar day in range', () => {
    const r = aggregateFinancialsOverview(RANGE, [
      pay({ id: 'p1', amount_pence: 10000, succeeded_at: '2026-04-13T10:00:00Z' }),
      pay({ id: 'p2', amount_pence: 5000, succeeded_at: '2026-04-15T10:00:00Z' }),
    ]);
    expect(r.daily).toEqual([
      { date: '2026-04-13', pence: 10000 },
      { date: '2026-04-14', pence: 0 },
      { date: '2026-04-15', pence: 5000 },
    ]);
  });
});

// ── shapeSalesRows ──────────────────────────────────────────────────────────

const visit = (over: Record<string, unknown>) => ({
  id: 'v',
  opened_at: '2026-04-15T10:00:00Z',
  arrival_type: 'walk_in' as const,
  patient: { first_name: 'Beth', last_name: 'Mackay', name: null },
  appointment: null,
  walk_in: { appointment_ref: 'LAP-00001' },
  cart: {
    id: 'c',
    status: 'paid',
    subtotal_pence: 10000,
    discount_pence: 0,
    total_pence: 10000,
    items: [{ name: 'Click-in veneers', removed_at: null }],
    payments: [{ method: 'cash', amount_pence: 10000, status: 'succeeded' }],
  },
  ...over,
});

describe('shapeSalesRows', () => {
  it('shapes a basic paid cart row', () => {
    const r = shapeSalesRows([visit({})], { paymentMethod: null, cartStatus: null, arrivalType: null });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.patient_name).toBe('Beth Mackay');
    expect(row.appointment_ref).toBe('LAP-00001');
    expect(row.cart_status).toBe('paid');
    expect(row.payment_methods).toBe('Cash');
    expect(row.amount_paid_pence).toBe(10000);
    expect(r.total_subtotal_pence).toBe(10000);
  });

  it('compresses long item lists into "+N more"', () => {
    const r = shapeSalesRows(
      [
        visit({
          cart: {
            id: 'c',
            status: 'paid',
            subtotal_pence: 0,
            discount_pence: 0,
            total_pence: 0,
            items: [
              { name: 'A', removed_at: null },
              { name: 'B', removed_at: null },
              { name: 'C', removed_at: null },
              { name: 'D', removed_at: null },
            ],
            payments: [],
          },
        }),
      ],
      { paymentMethod: null, cartStatus: null, arrivalType: null },
    );
    expect(r.rows[0]?.items_summary).toBe('A · B +2 more');
  });

  it('skips removed cart items when summarising', () => {
    const r = shapeSalesRows(
      [
        visit({
          cart: {
            id: 'c',
            status: 'paid',
            subtotal_pence: 0,
            discount_pence: 0,
            total_pence: 0,
            items: [
              { name: 'Active', removed_at: null },
              { name: 'Removed', removed_at: '2026-04-15T11:00:00Z' },
            ],
            payments: [],
          },
        }),
      ],
      { paymentMethod: null, cartStatus: null, arrivalType: null },
    );
    expect(r.rows[0]?.items_summary).toBe('Active');
  });

  it('joins multiple payment methods with " + "', () => {
    const r = shapeSalesRows(
      [
        visit({
          cart: {
            id: 'c',
            status: 'paid',
            subtotal_pence: 10000,
            discount_pence: 0,
            total_pence: 10000,
            items: [],
            payments: [
              { method: 'cash', amount_pence: 4000, status: 'succeeded' },
              { method: 'card_terminal', amount_pence: 6000, status: 'succeeded' },
            ],
          },
        }),
      ],
      { paymentMethod: null, cartStatus: null, arrivalType: null },
    );
    expect(r.rows[0]?.payment_methods).toBe('Cash + Card');
    expect(r.rows[0]?.amount_paid_pence).toBe(10000);
  });

  it('filters by payment method', () => {
    const v1 = visit({ id: 'v1', cart: { id: 'c1', status: 'paid', subtotal_pence: 0, discount_pence: 0, total_pence: 0, items: [], payments: [{ method: 'cash', amount_pence: 1000, status: 'succeeded' }] } });
    const v2 = visit({ id: 'v2', cart: { id: 'c2', status: 'paid', subtotal_pence: 0, discount_pence: 0, total_pence: 0, items: [], payments: [{ method: 'card_terminal', amount_pence: 1000, status: 'succeeded' }] } });
    const r = shapeSalesRows([v1, v2], { paymentMethod: 'cash', cartStatus: null, arrivalType: null });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.visit_id).toBe('v1');
  });

  it('filters by cart status', () => {
    const v1 = visit({ id: 'v1', cart: { id: 'c1', status: 'paid', subtotal_pence: 0, discount_pence: 0, total_pence: 0, items: [], payments: [] } });
    const v2 = visit({ id: 'v2', cart: { id: 'c2', status: 'open', subtotal_pence: 0, discount_pence: 0, total_pence: 0, items: [], payments: [] } });
    const r = shapeSalesRows([v1, v2], { paymentMethod: null, cartStatus: 'paid', arrivalType: null });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.cart_status).toBe('paid');
  });

  it('filters by arrival type', () => {
    const v1 = visit({ id: 'v1', arrival_type: 'walk_in' });
    const v2 = visit({ id: 'v2', arrival_type: 'scheduled' });
    const r = shapeSalesRows([v1, v2], { paymentMethod: null, cartStatus: null, arrivalType: 'walk_in' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.arrival_type).toBe('walk_in');
  });

  it('skips visits without a cart (defensive)', () => {
    const r = shapeSalesRows([visit({ cart: null })], { paymentMethod: null, cartStatus: null, arrivalType: null });
    expect(r.rows).toEqual([]);
  });

  it('orders rows by visit_date desc', () => {
    const r = shapeSalesRows(
      [
        visit({ id: 'v1', opened_at: '2026-04-13T10:00:00Z' }),
        visit({ id: 'v2', opened_at: '2026-04-15T10:00:00Z' }),
        visit({ id: 'v3', opened_at: '2026-04-14T10:00:00Z' }),
      ],
      { paymentMethod: null, cartStatus: null, arrivalType: null },
    );
    expect(r.rows.map((row) => row.visit_id)).toEqual(['v2', 'v3', 'v1']);
  });
});

// ── shapeDiscounts ──────────────────────────────────────────────────────────

describe('shapeDiscounts', () => {
  const baseDiscount = (over: Record<string, unknown> = {}) => ({
    id: 'd1',
    cart_id: 'c1',
    amount_pence: 5000,
    reason: 'Compensation',
    applied_at: '2026-04-15T10:00:00Z',
    removed_at: null,
    removed_reason: null,
    approver: { first_name: 'Sarah', last_name: 'Smith', name: null },
    applier: { first_name: 'Beth', last_name: 'Mackay', name: null },
    cart: { visit: { id: 'v1', patient: { first_name: 'Pat', last_name: 'X', name: null } } },
    ...over,
  });

  it('returns empty shape for empty input', () => {
    const r = shapeDiscounts([]);
    expect(r.rows).toEqual([]);
    expect(r.total_amount_pence).toBe(0);
    expect(r.active_count).toBe(0);
    expect(r.removed_count).toBe(0);
    expect(r.approver_leaderboard).toEqual([]);
  });

  it('counts active vs removed', () => {
    const r = shapeDiscounts([
      baseDiscount({ id: 'd1' }),
      baseDiscount({ id: 'd2', removed_at: '2026-04-15T11:00:00Z', removed_reason: 'Cashier mistake' }),
    ]);
    expect(r.active_count).toBe(1);
    expect(r.removed_count).toBe(1);
  });

  it('builds the approver leaderboard sorted by total', () => {
    const r = shapeDiscounts([
      baseDiscount({
        id: 'd1',
        amount_pence: 1000,
        approver: { first_name: 'A', last_name: 'A', name: null },
      }),
      baseDiscount({
        id: 'd2',
        amount_pence: 5000,
        approver: { first_name: 'B', last_name: 'B', name: null },
      }),
      baseDiscount({
        id: 'd3',
        amount_pence: 2000,
        approver: { first_name: 'A', last_name: 'A', name: null },
      }),
    ]);
    expect(r.approver_leaderboard).toEqual([
      { name: 'B B', count: 1, total_pence: 5000 },
      { name: 'A A', count: 2, total_pence: 3000 },
    ]);
  });

  it('orders rows newest first', () => {
    const r = shapeDiscounts([
      baseDiscount({ id: 'd1', applied_at: '2026-04-13T10:00:00Z' }),
      baseDiscount({ id: 'd2', applied_at: '2026-04-15T10:00:00Z' }),
      baseDiscount({ id: 'd3', applied_at: '2026-04-14T10:00:00Z' }),
    ]);
    expect(r.rows.map((x) => x.id)).toEqual(['d2', 'd3', 'd1']);
  });
});

// ── shapeVoids ──────────────────────────────────────────────────────────────

describe('shapeVoids', () => {
  const baseVoid = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    cart_id: 'c1',
    amount_pence: 5000,
    method: 'card_terminal',
    failure_reason: 'Customer changed their mind',
    succeeded_at: '2026-04-15T10:00:00Z',
    cancelled_at: '2026-04-15T10:30:00Z', // 30 min later
    taken_by: { first_name: 'Beth', last_name: 'Mackay', name: null },
    cart: { visit: { id: 'v1', patient: { first_name: 'Pat', last_name: 'X', name: null } } },
    ...over,
  });

  it('returns empty shape for empty input', () => {
    const r = shapeVoids([], 60);
    expect(r.rows).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.same_day_count).toBe(0);
  });

  it('computes minutes_to_void as the gap from succeeded_at to cancelled_at', () => {
    const r = shapeVoids([baseVoid({})], 60);
    expect(r.rows[0]?.minutes_to_void).toBe(30);
  });

  it('flags same_day_count when within window', () => {
    const r = shapeVoids(
      [
        baseVoid({ id: 'p1', succeeded_at: '2026-04-15T10:00:00Z', cancelled_at: '2026-04-15T10:15:00Z' }),
        baseVoid({ id: 'p2', succeeded_at: '2026-04-15T10:00:00Z', cancelled_at: '2026-04-15T13:00:00Z' }),
      ],
      60,
    );
    expect(r.same_day_count).toBe(1);
  });

  it('returns null minutes_to_void when never succeeded (cancelled pre-capture)', () => {
    const r = shapeVoids(
      [baseVoid({ succeeded_at: null, cancelled_at: '2026-04-15T10:30:00Z' })],
      60,
    );
    expect(r.rows[0]?.minutes_to_void).toBeNull();
    expect(r.same_day_count).toBe(0);
  });

  it('orders by cancelled_at desc', () => {
    const r = shapeVoids(
      [
        baseVoid({ id: 'p1', cancelled_at: '2026-04-13T10:00:00Z' }),
        baseVoid({ id: 'p2', cancelled_at: '2026-04-15T10:00:00Z' }),
        baseVoid({ id: 'p3', cancelled_at: '2026-04-14T10:00:00Z' }),
      ],
      60,
    );
    expect(r.rows.map((v) => v.id)).toEqual(['p2', 'p3', 'p1']);
  });
});
