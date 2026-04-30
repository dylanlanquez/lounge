import { describe, expect, it } from 'vitest';
import { aggregateAnomalies, shapeCashCounts, type AnomalyThresholds } from './cashCounts.ts';

const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  discount_pct: 50,
  void_window_minutes: 60,
  cash_variance_pence: 500,
  cash_count_overdue_days: 30,
};

describe('shapeCashCounts', () => {
  it('handles empty input', () => {
    expect(shapeCashCounts([])).toEqual([]);
  });

  it('orders by period_end desc', () => {
    const r = shapeCashCounts([
      { id: 'a', period_start: '2026-04-01', period_end: '2026-04-01', expected_pence: 0, actual_pence: 0, variance_pence: 0, status: 'signed', notes: null, counted_at: '2026-04-01T10:00:00Z', signed_off_at: '2026-04-01T11:00:00Z', counted_by: null, signed_off_by: null },
      { id: 'b', period_start: '2026-04-15', period_end: '2026-04-15', expected_pence: 0, actual_pence: 0, variance_pence: 0, status: 'signed', notes: null, counted_at: '2026-04-15T10:00:00Z', signed_off_at: '2026-04-15T11:00:00Z', counted_by: null, signed_off_by: null },
    ]);
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('humanises counter and signer names', () => {
    const r = shapeCashCounts([
      {
        id: 'a',
        period_start: '2026-04-01',
        period_end: '2026-04-01',
        expected_pence: 0,
        actual_pence: 0,
        variance_pence: 0,
        status: 'signed',
        notes: null,
        counted_at: '2026-04-01T10:00:00Z',
        signed_off_at: '2026-04-01T11:00:00Z',
        counted_by: { first_name: 'Beth', last_name: 'Mackay', name: null },
        signed_off_by: { first_name: 'Sarah', last_name: 'Smith', name: null },
      },
    ]);
    expect(r[0]?.counted_by_name).toBe('Beth Mackay');
    expect(r[0]?.signed_off_by_name).toBe('Sarah Smith');
  });
});

describe('aggregateAnomalies', () => {
  const NOW = new Date('2026-05-01T10:00:00Z');

  it('flags a discount whose share of subtotal is over the threshold', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [
        // 60% discount on a £100 cart — flagged
        { id: 'd1', amount_pence: 6000, applied_at: '2026-04-15T10:00:00Z', cart: { subtotal_pence: 10000, visit: { id: 'v1' } } },
        // 30% discount — under threshold
        { id: 'd2', amount_pence: 3000, applied_at: '2026-04-15T11:00:00Z', cart: { subtotal_pence: 10000, visit: { id: 'v2' } } },
      ],
      [],
      null,
      NOW,
    );
    const flagged = r.flags.filter((f) => f.kind === 'discount_above_threshold');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reference).toBe('d1');
  });

  it('flags voids inside the window after capture', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [],
      [
        { id: 'p1', amount_pence: 5000, succeeded_at: '2026-04-15T10:00:00Z', cancelled_at: '2026-04-15T10:30:00Z', cart: { visit: { id: 'v1' } } }, // 30 min — flag
        { id: 'p2', amount_pence: 5000, succeeded_at: '2026-04-15T10:00:00Z', cancelled_at: '2026-04-15T13:00:00Z', cart: { visit: { id: 'v2' } } }, // 3h — no flag
        { id: 'p3', amount_pence: 5000, succeeded_at: null, cancelled_at: '2026-04-15T10:30:00Z', cart: { visit: { id: 'v3' } } }, // pre-capture — no flag
      ],
      null,
      NOW,
    );
    const flagged = r.flags.filter((f) => f.kind === 'void_in_window');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reference).toBe('p1');
  });

  it('flags cash count overdue when last signed count is older than threshold', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [],
      [],
      { period_end: '2026-03-15T00:00:00Z' }, // 47 days before NOW
      NOW,
    );
    const flagged = r.flags.filter((f) => f.kind === 'cash_count_overdue');
    expect(flagged).toHaveLength(1);
  });

  it('flags missing cash count when there has never been one', () => {
    const r = aggregateAnomalies(DEFAULT_THRESHOLDS, [], [], null, NOW);
    const flagged = r.flags.filter((f) => f.kind === 'cash_count_overdue');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.reference).toBe('no_count');
  });

  it('does NOT flag a recent signed count', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [],
      [],
      { period_end: '2026-04-25T00:00:00Z' }, // 6 days before NOW — under threshold
      NOW,
    );
    expect(r.flags.filter((f) => f.kind === 'cash_count_overdue')).toHaveLength(0);
  });

  it('counts each kind correctly', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [
        { id: 'd1', amount_pence: 6000, applied_at: '2026-04-15T10:00:00Z', cart: { subtotal_pence: 10000, visit: { id: 'v1' } } },
        { id: 'd2', amount_pence: 7500, applied_at: '2026-04-16T10:00:00Z', cart: { subtotal_pence: 10000, visit: { id: 'v2' } } },
      ],
      [
        { id: 'p1', amount_pence: 1000, succeeded_at: '2026-04-15T10:00:00Z', cancelled_at: '2026-04-15T10:10:00Z', cart: { visit: { id: 'v1' } } },
      ],
      null,
      NOW,
    );
    expect(r.counts.discount_above_threshold).toBe(2);
    expect(r.counts.void_in_window).toBe(1);
    expect(r.counts.cash_count_overdue).toBe(1);
  });

  it('skips discounts on zero-subtotal carts (no division by zero)', () => {
    const r = aggregateAnomalies(
      DEFAULT_THRESHOLDS,
      [
        { id: 'd1', amount_pence: 6000, applied_at: '2026-04-15T10:00:00Z', cart: { subtotal_pence: 0, visit: { id: 'v1' } } },
      ],
      [],
      null,
      NOW,
    );
    expect(r.flags.filter((f) => f.kind === 'discount_above_threshold')).toHaveLength(0);
  });
});
