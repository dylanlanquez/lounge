import { describe, expect, it } from 'vitest';
import {
  DATE_RANGE_PRESETS,
  dateRangeLabel,
  dateRangeToUtcBounds,
  defaultDateRange,
  makeCustomRange,
  resolvePreset,
} from './dateRange.ts';

// Deterministic "now" for every test — Wednesday 15 Apr 2026 14:30 local.
// Picked because it lands mid-week, mid-month, mid-quarter so every preset
// produces a non-trivial range distinct from the others. Tests parameterise
// `now` everywhere to keep results stable across machine clocks.
const NOW = new Date(2026, 3, 15, 14, 30);

describe('resolvePreset', () => {
  it('today resolves to a single day', () => {
    const r = resolvePreset('today', NOW);
    expect(r).toEqual({ start: '2026-04-15', end: '2026-04-15', preset: 'today' });
  });

  it('yesterday is the day before today', () => {
    const r = resolvePreset('yesterday', NOW);
    expect(r).toEqual({ start: '2026-04-14', end: '2026-04-14', preset: 'yesterday' });
  });

  it('last_7 covers a 7-day window ending today (inclusive)', () => {
    const r = resolvePreset('last_7', NOW);
    expect(r.start).toBe('2026-04-09');
    expect(r.end).toBe('2026-04-15');
    expect(r.preset).toBe('last_7');
  });

  it('last_30 covers a 30-day window ending today', () => {
    const r = resolvePreset('last_30', NOW);
    expect(r.start).toBe('2026-03-17');
    expect(r.end).toBe('2026-04-15');
  });

  it('this_week is Monday → Sunday containing today', () => {
    // 2026-04-15 is a Wednesday → week is 2026-04-13 (Mon) → 2026-04-19 (Sun)
    const r = resolvePreset('this_week', NOW);
    expect(r.start).toBe('2026-04-13');
    expect(r.end).toBe('2026-04-19');
  });

  it('last_week is the previous Mon → Sun', () => {
    const r = resolvePreset('last_week', NOW);
    expect(r.start).toBe('2026-04-06');
    expect(r.end).toBe('2026-04-12');
  });

  it('this_month covers the whole month', () => {
    const r = resolvePreset('this_month', NOW);
    expect(r.start).toBe('2026-04-01');
    expect(r.end).toBe('2026-04-30');
  });

  it('last_month works across a year boundary', () => {
    const jan = new Date(2026, 0, 5, 9, 0);
    const r = resolvePreset('last_month', jan);
    expect(r.start).toBe('2025-12-01');
    expect(r.end).toBe('2025-12-31');
  });

  it('last_month handles February in a leap year', () => {
    const mar2024 = new Date(2024, 2, 10, 9, 0);
    const r = resolvePreset('last_month', mar2024);
    expect(r.start).toBe('2024-02-01');
    expect(r.end).toBe('2024-02-29'); // leap day included
  });

  it('this_quarter aligns to Jan–Mar / Apr–Jun / Jul–Sep / Oct–Dec', () => {
    expect(resolvePreset('this_quarter', new Date(2026, 0, 5)).end).toBe('2026-03-31');
    expect(resolvePreset('this_quarter', new Date(2026, 3, 15)).start).toBe('2026-04-01');
    expect(resolvePreset('this_quarter', new Date(2026, 3, 15)).end).toBe('2026-06-30');
    expect(resolvePreset('this_quarter', new Date(2026, 11, 31)).start).toBe('2026-10-01');
  });

  it('this_year covers Jan 1 to Dec 31', () => {
    const r = resolvePreset('this_year', NOW);
    expect(r.start).toBe('2026-01-01');
    expect(r.end).toBe('2026-12-31');
  });

  it("throws if asked to resolve 'custom' — that path is reserved for makeCustomRange", () => {
    expect(() => resolvePreset('custom', NOW)).toThrow(/custom/);
  });

  it('throws on an unknown preset id', () => {
    // @ts-expect-error — testing runtime guard for an invalid id
    expect(() => resolvePreset('not_a_preset', NOW)).toThrow(/Unknown/);
  });
});

describe('makeCustomRange', () => {
  it('builds a valid custom range', () => {
    const r = makeCustomRange('2026-01-15', '2026-02-10');
    expect(r).toEqual({ start: '2026-01-15', end: '2026-02-10', preset: 'custom' });
  });

  it('accepts a single-day range (start = end)', () => {
    const r = makeCustomRange('2026-04-15', '2026-04-15');
    expect(r.start).toBe('2026-04-15');
    expect(r.end).toBe('2026-04-15');
  });

  it('throws when start is malformed', () => {
    expect(() => makeCustomRange('not-a-date', '2026-04-15')).toThrow(/start/);
  });

  it('throws when end is malformed', () => {
    expect(() => makeCustomRange('2026-04-15', '15-04-2026')).toThrow(/end/);
  });

  it('throws on impossible calendar dates (e.g. Feb 31)', () => {
    expect(() => makeCustomRange('2026-02-31', '2026-03-01')).toThrow(/start/);
  });

  it('throws when end is before start', () => {
    expect(() => makeCustomRange('2026-04-15', '2026-04-10')).toThrow(/before/);
  });
});

describe('defaultDateRange', () => {
  it('lands on the last_30 preset', () => {
    const r = defaultDateRange(NOW);
    expect(r.preset).toBe('last_30');
    expect(r.start).toBe('2026-03-17');
    expect(r.end).toBe('2026-04-15');
  });
});

describe('dateRangeToUtcBounds', () => {
  it('produces inclusive UTC bounds spanning the requested calendar days', () => {
    const range = makeCustomRange('2026-04-15', '2026-04-15');
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    // Bounds frame the day from local midnight to the millisecond before
    // the next local midnight. We don't assert exact UTC offsets because
    // those depend on the test machine's timezone; we assert that:
    //   • from is the start of the day (parses to a local time of 00:00)
    //   • to is just under 24h later (1 ms before the next local midnight)
    const fromMs = new Date(fromIso).getTime();
    const toMs = new Date(toIso).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    expect(toMs - fromMs).toBe(dayMs - 1);
  });

  it('handles a multi-day range', () => {
    const range = makeCustomRange('2026-04-01', '2026-04-30');
    const { fromIso, toIso } = dateRangeToUtcBounds(range);
    const fromMs = new Date(fromIso).getTime();
    const toMs = new Date(toIso).getTime();
    const expected = 30 * 24 * 60 * 60 * 1000 - 1;
    expect(toMs - fromMs).toBe(expected);
  });
});

describe('dateRangeLabel', () => {
  it('shows the preset label when one is set', () => {
    const r = resolvePreset('last_7', NOW);
    expect(dateRangeLabel(r)).toBe('Last 7 days');
  });

  it('shows a long single-day label for a custom range that spans one day', () => {
    const r = makeCustomRange('2026-04-15', '2026-04-15');
    expect(dateRangeLabel(r)).toMatch(/15 Apr 2026/);
  });

  it('shows a short start → end label for multi-day custom ranges', () => {
    const r = makeCustomRange('2026-04-12', '2026-04-25');
    const label = dateRangeLabel(r);
    expect(label).toContain('12 Apr');
    expect(label).toContain('25 Apr');
    expect(label).toContain('→');
  });

  it('throws on a corrupted preset id', () => {
    const corrupt = { start: '2026-04-15', end: '2026-04-15', preset: 'mystery' as never };
    expect(() => dateRangeLabel(corrupt)).toThrow(/Unknown preset/);
  });
});

describe('DATE_RANGE_PRESETS exposure', () => {
  it("does not include 'custom' in the user-facing preset list", () => {
    const ids = DATE_RANGE_PRESETS.map((p) => p.id);
    expect(ids).not.toContain('custom');
  });

  it('lists every shortcut a report card might want to show', () => {
    const ids = DATE_RANGE_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'last_30',
        'last_7',
        'last_month',
        'last_week',
        'this_month',
        'this_quarter',
        'this_week',
        'this_year',
        'today',
        'yesterday',
      ].sort(),
    );
  });
});
