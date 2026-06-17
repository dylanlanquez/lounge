// @vitest-environment jsdom
//
// Regression test for the "Take payment lands on a stale receipt screen"
// glitch. Mounts the REAL Pay route at a spent ?stage=success URL and
// proves the self-correcting guard behaves:
//   • money still owed  -> drops to the method picker (choose)
//   • bill fully settled -> keeps the receipt picker (success)
//
// The data hooks are mocked to the exact partial-payment state from the
// reported bug (Click-in Veneers £599, £114.80 discount, £25 deposit,
// £229.60 collected -> £229.60 still outstanding). The cart maths run
// for real so the outstanding figure is computed exactly as in prod.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const state = vi.hoisted(() => ({ amountPaid: 0, paymentAmount: 0 }));

vi.mock('../lib/auth.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1' }, loading: false }),
}));

vi.mock('../lib/useIsMobile.ts', () => ({ useIsMobile: () => false }));

vi.mock('../lib/queries/visits.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    useVisitDetail: () => ({
      visit: { id: 'v1', appointment_id: 'a1', opened_at: '2026-06-17T10:00:00Z', status: 'arrived' },
      patient: { id: 'pt1', first_name: 'Ben', last_name: 'Jones', email: 'ben@example.com', phone: '+447000000000' },
      deposit: { status: 'paid', pence: 2500, provider: 'stripe', paidInFullAtBooking: false },
      appointment: { service_type: 'click_in_veneers' },
      shopifyOrder: null,
      loading: false,
    }),
  };
});

vi.mock('../lib/queries/carts.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    useCart: () => ({
      cart: { id: 'c1', discount_pence: 11480 },
      items: [{ id: 'i1', name: 'Click-in Veneers', quantity: 1, unit_price_pence: 59900, line_total_pence: 59900, discount_pence: 0 }],
      loading: false,
    }),
  };
});

vi.mock('../lib/queries/payments.ts', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    useVisitPaidStatus: () => ({
      data: { visit_id: 'v1', cart_id: 'c1', amount_due_pence: 48420, amount_paid_pence: state.amountPaid, paid_status: 'partially_paid' },
      loading: false,
      refresh: () => {},
    }),
    useCartPayments: () => ({
      data: [{ id: 'p1', method: 'card_terminal', payment_journey: 'standard', amount_pence: state.paymentAmount, status: 'succeeded', succeeded_at: '2026-06-17T16:35:00Z', cancelled_at: null, taken_by_name: 'Jade Cassidy' }],
      refresh: () => {},
    }),
  };
});

vi.mock('../lib/queries/currentAccount.tsx', () => ({ useCurrentAccount: () => ({ account: null }) }));
vi.mock('../lib/queries/terminalReaders.ts', () => ({ useTerminalReaders: () => ({ data: [] }) }));
vi.mock('../lib/queries/quickSale.ts', () => ({ completeQuickSaleVisit: () => Promise.resolve() }));
vi.mock('../lib/queries/managerNotifications.ts', () => ({ sendManagerNotification: () => Promise.resolve() }));

// Payment modals pull in Stripe; they are rendered closed here, so stub them.
vi.mock('../components/TerminalPaymentModal/TerminalPaymentModal.tsx', () => ({ TerminalPaymentModal: () => null }));
vi.mock('../components/MotoPaymentModal/MotoPaymentModal.tsx', () => ({ MotoPaymentModal: () => null }));
vi.mock('../components/BNPLHelper/BNPLHelper.tsx', () => ({ BNPLHelper: () => null }));
vi.mock('../components/KlarnaInStoreModal/KlarnaInStoreModal.tsx', () => ({ KlarnaInStoreModal: () => null }));
vi.mock('../components/ManagerNotificationNotice/ManagerNotificationNotice.tsx', () => ({ ManagerNotificationNotice: () => null }));

// Chainable, thenable Supabase stub: every query resolves to no rows, and
// realtime channel calls are no-ops.
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

function renderPay() {
  return render(
    <MemoryRouter initialEntries={['/visit/v1/pay?stage=success&payment=p1']}>
      <Routes>
        <Route path="/visit/:id/pay" element={<Pay />} />
        <Route path="/visit/:id" element={<div>VISIT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('Pay stale-success self-correction', () => {
  it('drops a spent ?stage=success URL to the method picker when a balance is still owed', async () => {
    // £25 deposit + £229.60 collected = £254.60 paid; £229.60 still due.
    state.amountPaid = 25460;
    state.paymentAmount = 22960;
    renderPay();
    // It self-corrects to the choose stage: the charge control appears...
    await waitFor(() => expect(screen.getByText('Charge on this method')).toBeTruthy());
    // ...and the receipt picker is gone.
    expect(screen.queryByText('Choose how to send the receipt.')).toBeNull();
  });

  it('keeps the receipt picker when the bill is fully settled', async () => {
    // £25 deposit + £459.20 collected = £484.20 = full bill; nothing owed.
    state.amountPaid = 48420;
    state.paymentAmount = 45920;
    renderPay();
    await waitFor(() => expect(screen.getByText('Choose how to send the receipt.')).toBeTruthy());
    expect(screen.queryByText('Charge on this method')).toBeNull();
  });
});
