// @vitest-environment jsdom
//
// Reproduces the real production bug: the data hooks resolve in stages,
// and useCart publishes `cart` BEFORE its line items, so there is a
// render window where cart is present, items are still [], paid-status
// and payments HAVE loaded -> the outstanding transiently computes to
// £0. The auto-advance effect must NOT treat that window as "bill
// settled" and jump to the receipt stage (latching the took-payment
// ref, which then blocks the stale-success self-correct).
//
// Staged via a tiny external store so each phase renders deterministically:
//   phase 1: visit + cart present, items [], cart loading, paid loading
//   phase 2: paid-status + the one succeeded payment land; items STILL [] (cart loading)  <-- the trap
//   phase 3: items resolve, cart settles -> outstanding = £229.60
//
// Without the fix the page is stuck on the receipt screen at phase 3.
// With the fix it stays on the method picker.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const store = vi.hoisted(() => {
  let phase = 0;
  const subs = new Set<() => void>();
  return {
    get: () => phase,
    set: (p: number) => { phase = p; subs.forEach((f) => f()); },
    sub: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
});

vi.mock('../lib/auth.tsx', () => ({ useAuth: () => ({ user: { id: 'u1' }, loading: false }) }));
vi.mock('../lib/useIsMobile.ts', () => ({ useIsMobile: () => false }));

vi.mock('../lib/queries/visits.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  const React = await import('react');
  return {
    ...actual,
    useVisitDetail: () => {
      const phase = React.useSyncExternalStore(store.sub, store.get);
      return phase >= 1
        ? {
            visit: { id: 'v1', appointment_id: 'a1', opened_at: '2026-06-17T10:00:00Z', status: 'arrived' },
            patient: { id: 'pt1', first_name: 'Ben', last_name: 'Jones', email: 'ben@example.com', phone: '+447000000000' },
            deposit: { status: 'paid', pence: 2500, provider: 'stripe', paidInFullAtBooking: false },
            appointment: { service_type: 'click_in_veneers' },
            shopifyOrder: null,
            loading: false,
          }
        : { visit: null, patient: null, deposit: null, appointment: null, shopifyOrder: null, loading: true };
    },
  };
});

vi.mock('../lib/queries/carts.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  const React = await import('react');
  return {
    ...actual,
    useCart: () => {
      const phase = React.useSyncExternalStore(store.sub, store.get);
      // cart present from phase 1; items only at phase 3; loading until then.
      return {
        cart: phase >= 1 ? { id: 'c1', discount_pence: 11480 } : null,
        items: phase >= 3 ? [{ id: 'i1', name: 'Click-in Veneers', quantity: 1, unit_price_pence: 59900, line_total_pence: 59900, discount_pence: 0 }] : [],
        loading: phase < 3,
      };
    },
  };
});

vi.mock('../lib/queries/payments.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  const React = await import('react');
  return {
    ...actual,
    useVisitPaidStatus: () => {
      const phase = React.useSyncExternalStore(store.sub, store.get);
      return phase >= 2
        ? { data: { visit_id: 'v1', cart_id: 'c1', amount_due_pence: 48420, amount_paid_pence: 25460, paid_status: 'partially_paid' }, loading: false, refresh: () => {} }
        : { data: null, loading: true, refresh: () => {} };
    },
    useCartPayments: () => {
      const phase = React.useSyncExternalStore(store.sub, store.get);
      return {
        data: phase >= 2 ? [{ id: 'p1', method: 'card_moto', payment_journey: 'standard', amount_pence: 22960, status: 'succeeded', succeeded_at: '2026-06-16T16:35:11Z', cancelled_at: null, taken_by_name: 'Jade Cassidy' }] : [],
        refresh: () => {},
      };
    },
  };
});

vi.mock('../lib/queries/currentAccount.tsx', () => ({ useCurrentAccount: () => ({ account: null }) }));
vi.mock('../lib/queries/terminalReaders.ts', () => ({ useTerminalReaders: () => ({ data: [] }) }));
vi.mock('../lib/queries/quickSale.ts', () => ({ completeQuickSaleVisit: () => Promise.resolve() }));
vi.mock('../lib/queries/managerNotifications.ts', () => ({ sendManagerNotification: () => Promise.resolve() }));
vi.mock('../components/TerminalPaymentModal/TerminalPaymentModal.tsx', () => ({ TerminalPaymentModal: () => null }));
vi.mock('../components/MotoPaymentModal/MotoPaymentModal.tsx', () => ({ MotoPaymentModal: () => null }));
vi.mock('../components/BNPLHelper/BNPLHelper.tsx', () => ({ BNPLHelper: () => null }));
vi.mock('../components/KlarnaInStoreModal/KlarnaInStoreModal.tsx', () => ({ KlarnaInStoreModal: () => null }));
vi.mock('../components/ManagerNotificationNotice/ManagerNotificationNotice.tsx', () => ({ ManagerNotificationNotice: () => null }));

const makeThenable = (result: unknown): unknown =>
  new Proxy(
    { then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res) },
    { get: (t, p) => (p === 'then' ? (t as Record<string, unknown>).then : () => makeThenable(result)) },
  );
vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: () => makeThenable({ data: [], error: null }),
    rpc: () => makeThenable({ data: null, error: null }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
    functions: { invoke: () => Promise.resolve({ data: { ok: true }, error: null }) },
  },
}));

import { Pay } from './Pay.tsx';

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { cleanup(); store.set(0); });

describe('Pay loading-window guard', () => {
  it('does not auto-advance to the receipt stage during the items-still-loading window', async () => {
    store.set(0);
    render(
      <MemoryRouter initialEntries={['/visit/v1/pay']}>
        <Routes>
          <Route path="/visit/:id/pay" element={<Pay />} />
          <Route path="/visit/:id" element={<div>VISIT PAGE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    // Drive the staged loads, flushing effects between each phase so the
    // dangerous phase-2 window actually renders (and its effects run).
    await act(async () => { store.set(1); await tick(); });
    await act(async () => { store.set(2); await tick(); });
    await act(async () => { store.set(3); await tick(); });

    // Bill is £229.60 owed: must be on the method picker, never the receipt screen.
    expect(screen.getByText('Charge on this method')).toBeTruthy();
    expect(screen.queryByText('Choose how to send the receipt.')).toBeNull();
  });
});
