// Regression cover for the walk-in calendar marker left on 'arrived'.
//
// A walk-in owns two rows: the visit (lng_visits, keyed by walk_in_id)
// and a marker in lng_appointments that the schedule actually renders.
// completeVisit used to flip lng_appointments only when the visit
// carried an appointment_id, which a walk-in visit never does, so
// processed walk-ins kept an "Arrived" pill and never dimmed.

import { describe, expect, it, beforeEach, vi } from 'vitest';

interface Recorded {
  table: string;
  op: 'update' | 'insert';
  payload: Record<string, unknown>;
  filters: [string, unknown][];
}

const calls: Recorded[] = [];

function builder(table: string): Record<string, unknown> {
  const rec: Recorded = { table, op: 'update', payload: {}, filters: [] };
  const proxy: Record<string, unknown> = {
    update(p: Record<string, unknown>) {
      rec.op = 'update';
      rec.payload = p;
      calls.push(rec);
      return proxy;
    },
    insert(p: Record<string, unknown>) {
      rec.op = 'insert';
      rec.payload = p;
      calls.push(rec);
      return proxy;
    },
    eq(k: string, v: unknown) {
      rec.filters.push([k, v]);
      return proxy;
    },
    neq: () => proxy,
    select: () => proxy,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(res),
  };
  return proxy;
}

vi.mock('../supabase.ts', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: 'account-1', error: null }),
  },
}));

const { completeVisit } = await import('./visits.ts');

const apptUpdates = () =>
  calls.filter((c) => c.table === 'lng_appointments' && c.op === 'update');

beforeEach(() => {
  calls.length = 0;
});

describe('completeVisit — schedule row reaches a terminal status', () => {
  it('flips the walk-in calendar marker to complete via walk_in_id', async () => {
    await completeVisit({
      visit_id: 'v1',
      patient_id: 'p1',
      // A walk-in visit always has a NULL appointment_id — the
      // exactly-one constraint on lng_visits forces walk_in_id.
      appointment_id: null,
      walk_in_id: 'w1',
      fulfilment_method: 'in_person',
    });

    const marker = apptUpdates().find((c) =>
      c.filters.some(([k]) => k === 'walk_in_id'),
    );
    expect(marker).toBeDefined();
    expect(marker?.payload.status).toBe('complete');
    expect(marker?.filters).toContainEqual(['walk_in_id', 'w1']);
  });

  it('frees the walk-in job box on lng_walk_ins, not on the marker', async () => {
    await completeVisit({
      visit_id: 'v1',
      patient_id: 'p1',
      appointment_id: null,
      walk_in_id: 'w1',
      fulfilment_method: 'in_person',
    });

    const walkIn = calls.find((c) => c.table === 'lng_walk_ins');
    expect(walkIn?.payload.jb_ref).toBeNull();

    // The marker never carries a jb_ref, so completing must not
    // write one back onto it.
    const marker = apptUpdates().find((c) =>
      c.filters.some(([k]) => k === 'walk_in_id'),
    );
    expect(marker?.payload).not.toHaveProperty('jb_ref');
  });

  it('still flips a booked appointment by id, and only by id', async () => {
    await completeVisit({
      visit_id: 'v2',
      patient_id: 'p2',
      appointment_id: 'a2',
      walk_in_id: null,
      fulfilment_method: 'shipping',
    });

    const updates = apptUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload.status).toBe('complete');
    expect(updates[0]?.payload.jb_ref).toBeNull();
    expect(updates[0]?.filters).toContainEqual(['id', 'a2']);
  });
});
