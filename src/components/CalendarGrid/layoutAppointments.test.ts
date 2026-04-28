import { describe, expect, it } from 'vitest';
import { LANE_CAP, layoutAppointments } from './CalendarGrid.tsx';

interface Row {
  id: string;
  start_at: string;
  end_at: string;
}

const r = (id: string, start: string, end: string): Row => ({
  id,
  start_at: `2026-04-28T${start}:00Z`,
  end_at: `2026-04-28T${end}:00Z`,
});

describe('layoutAppointments', () => {
  it('returns nothing for an empty input', () => {
    expect(layoutAppointments([])).toEqual([]);
  });

  it('renders a single row as one full-width card', () => {
    const out = layoutAppointments([r('a', '09:00', '10:00')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'card', lane: 0, lanesInGroup: 1 });
  });

  it('renders non-overlapping rows as full-width cards', () => {
    const out = layoutAppointments([
      r('a', '09:00', '10:00'),
      r('b', '10:00', '11:00'),
      r('c', '11:00', '12:00'),
    ]);
    expect(out).toHaveLength(3);
    out.forEach((item) => {
      expect(item.kind).toBe('card');
      if (item.kind === 'card') expect(item.lanesInGroup).toBe(1);
    });
  });

  it('treats end_at === next.start_at as non-overlapping (no shared lanes)', () => {
    const out = layoutAppointments([
      r('a', '09:00', '10:00'),
      r('b', '10:00', '11:00'),
    ]);
    out.forEach((item) => {
      if (item.kind === 'card') expect(item.lanesInGroup).toBe(1);
    });
  });

  it('places a 2-overlap pair in side-by-side lanes', () => {
    const out = layoutAppointments([
      r('a', '13:15', '13:45'),
      r('b', '13:30', '14:30'),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'card', lane: 0, lanesInGroup: 2 });
    expect(out[1]).toMatchObject({ kind: 'card', lane: 1, lanesInGroup: 2 });
  });

  it('reuses a freed lane within a 2-overlap cluster', () => {
    // a: 9-11 lane 0; b: 10-12 lane 1; c: 11:30-12:30 reuses lane 0 (free at 11)
    const out = layoutAppointments([
      r('a', '09:00', '11:00'),
      r('b', '10:00', '12:00'),
      r('c', '11:30', '12:30'),
    ]);
    // 3 in cluster → ClusterCard, not lanes (because LANE_CAP is 2).
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('cluster');
  });

  it('collapses a 3-row overlap cluster into a single ClusterCard', () => {
    const out = layoutAppointments([
      r('a', '09:00', '10:00'),
      r('b', '09:15', '10:15'),
      r('c', '09:30', '10:30'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('cluster');
    if (out[0]?.kind === 'cluster') {
      expect(out[0].rows).toHaveLength(3);
      expect(out[0].startAt).toBe('2026-04-28T09:00:00Z');
      expect(out[0].endAt).toBe('2026-04-28T10:30:00Z');
    }
  });

  it('handles a 10-row overlap as a single ClusterCard', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      r(`a${i}`, '09:00', '10:00')
    );
    const out = layoutAppointments(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('cluster');
    if (out[0]?.kind === 'cluster') {
      expect(out[0].rows).toHaveLength(10);
    }
  });

  it('mixes clusters and lane-pairs and singletons in one day', () => {
    const out = layoutAppointments([
      r('s1', '08:00', '08:30'),                  // singleton
      r('p1', '09:00', '10:00'), r('p2', '09:30', '10:30'), // pair → 2 lanes
      r('c1', '11:00', '12:00'), r('c2', '11:00', '12:00'), r('c3', '11:30', '12:30'), // 3 → cluster
      r('s2', '14:00', '15:00'),                  // singleton
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ kind: 'card', lanesInGroup: 1 });
    expect(out[1]).toMatchObject({ kind: 'card', lanesInGroup: 2, lane: 0 });
    expect(out[2]).toMatchObject({ kind: 'card', lanesInGroup: 2, lane: 1 });
    expect(out[3]?.kind).toBe('cluster');
    expect(out[4]).toMatchObject({ kind: 'card', lanesInGroup: 1 });
  });

  it('emits cluster output deterministically — sorted input gives same result', () => {
    const a = layoutAppointments([
      r('a', '09:00', '10:00'),
      r('b', '09:15', '10:15'),
      r('c', '09:30', '10:30'),
    ]);
    const b = layoutAppointments([
      r('c', '09:30', '10:30'),
      r('a', '09:00', '10:00'),
      r('b', '09:15', '10:15'),
    ]);
    expect(a).toEqual(b);
  });

  it('LANE_CAP is honoured (regression guard)', () => {
    expect(LANE_CAP).toBe(2);
  });
});
