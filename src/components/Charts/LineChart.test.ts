import { describe, expect, it } from 'vitest';
import { computeNiceTicks } from './LineChart.tsx';

// Pure helpers exposed by LineChart that the chart axis math relies
// on. Locking each rounding case in unit tests means a future tweak
// can't silently break the visual rhythm of the y-axis.

describe('computeNiceTicks', () => {
  it('returns [0, 1] for non-positive max', () => {
    expect(computeNiceTicks(0, 4)).toEqual([0, 1]);
    expect(computeNiceTicks(-5, 4)).toEqual([0, 1]);
  });

  it('rounds up to a nice top tick', () => {
    const ticks = computeNiceTicks(7, 4);
    // Step ≈ 7/4 = 1.75 → nice step 2; top = 8.
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(8);
  });

  it('produces evenly spaced ticks', () => {
    const ticks = computeNiceTicks(20, 4);
    expect(ticks).toEqual([0, 5, 10, 15, 20]);
  });

  it('handles small fractional inputs', () => {
    const ticks = computeNiceTicks(0.42, 4);
    // step ≈ 0.105 → nice 0.1; top = 0.5
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(0.42);
  });

  it('handles very large inputs', () => {
    const ticks = computeNiceTicks(12345, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(12345);
    // Should round to a friendly thousand-something number rather
    // than 12345.
    expect((ticks[ticks.length - 1] ?? 0) % 1000).toBe(0);
  });

  it('always includes 0 as the first tick', () => {
    expect(computeNiceTicks(1, 1)[0]).toBe(0);
    expect(computeNiceTicks(100, 4)[0]).toBe(0);
  });
});
