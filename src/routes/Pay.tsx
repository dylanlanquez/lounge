import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Banknote, CreditCard, ShoppingBag } from 'lucide-react';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { BottomSheet, Breadcrumb, Button, Card, EmptyState, Input, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { TerminalPaymentModal } from '../components/TerminalPaymentModal/TerminalPaymentModal.tsx';
import { BNPLHelper, type BnplProvider } from '../components/BNPLHelper/BNPLHelper.tsx';
import { KlarnaInStoreModal } from '../components/KlarnaInStoreModal/KlarnaInStoreModal.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { formatVisitCrumb, useVisitDetail } from '../lib/queries/visits.ts';
import {
  useCart,
  formatPence,
  computeCartSubtotal,
  computeCartOutstanding,
} from '../lib/queries/carts.ts';
import {
  recordCashPayment,
  useCartPayments,
  useVisitPaidStatus,
  voidPayment,
  type CartPaymentRow,
} from '../lib/queries/payments.ts';
import { listManagers, type ManagerRow } from '../lib/queries/cartDiscounts.ts';
import { DropdownSelect } from '../components/DropdownSelect/DropdownSelect.tsx';
import { patientFullName } from '../lib/queries/patients.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
import { supabase } from '../lib/supabase.ts';
import { formatDepositSourceSuffix } from '../lib/queries/visits.ts';

type Stage = 'choose' | 'cash' | 'card' | 'bnpl' | 'success';
type Journey = 'standard' | 'klarna' | 'clearpay';
// Two top-level modes on the choose stage. 'full' is the default and
// charges the entire outstanding on the picked method. 'split' reveals
// an explicit "Take £X now" panel so staff can collect part of the
// balance and finish on a different method on the next round.
type PaymentMode = 'full' | 'split';

// Router state read by PayBreadcrumbs to render the right trail. The
// "Take payment" button on VisitDetail forwards a `from: 'visit'`
// payload that carries the visit id, opened-at, and the visit's own
// entry so the breadcrumb here can render [origin] › Visit › Take
// payment, with each crumb popping back to the right place. Direct
// URL pastes (no state) fall back to a sensible default chain.
interface PayEntryState {
  from?: 'visit';
  visitId?: string;
  visitOpenedAt?: string;
  // Full preview of the visit's own entry state, mirrored from
  // VisitDetail's VisitEntryState. Carries patientName and
  // visitOpenedAt so navigating back to the visit pre-renders
  // every breadcrumb crumb on first paint.
  visitEntry?: {
    from?: 'patient' | 'schedule' | 'in_clinic';
    patientId?: string;
    patientName?: string;
    visitOpenedAt?: string;
  } | null;
}

export function Pay() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const { visit, patient, deposit, loading: visitLoading } = useVisitDetail(id);
  const { cart, items, loading: cartLoading } = useCart(id);
  const navigate = useNavigate();
  const location = useLocation();
  // Hop back to the visit page with its original entry chain intact.
  // VisitDetail forwarded its own state when sending us here; passing
  // it back through means the visit's breadcrumb pre-renders every
  // crumb (origin / patient / timestamp) on first paint with no
  // shimmer transition.
  const visitState = (location.state as PayEntryState | null)?.visitEntry ?? undefined;
  const goBackToVisit = () =>
    navigate(`/visit/${id}`, visitState ? { state: visitState } : undefined);
  const [stage, setStage] = useState<Stage>('choose');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [receiptChannel, setReceiptChannel] = useState<'email' | 'sms' | 'none'>('email');
  const [receiptRecipient, setReceiptRecipient] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [bnplOpen, setBnplOpen] = useState(false);
  // Klarna goes through the native In-Store API now (its own QR +
  // payment_link modal) rather than the virtual-Visa-via-S700 path
  // BNPLHelper drives. Clearpay still uses BNPLHelper.
  const [klarnaOpen, setKlarnaOpen] = useState(false);
  const [journey, setJourney] = useState<Journey>('standard');
  const { data: readers } = useTerminalReaders();
  const reader = readers[0] ?? null;

  const openTerminal = (j: Journey) => {
    if (!reader) {
      setError(
        'No card reader registered. Activate Terminal in Stripe Dashboard, register a Simulated WisePOS E or your S700, then INSERT a row into lng_terminal_readers.'
      );
      return;
    }
    setJourney(j);
    setTerminalOpen(true);
  };

  const openBnpl = (provider: BnplProvider) => {
    // Klarna routes to the native In-Store API modal (QR + payment
    // link). The S700 reader is irrelevant for Klarna in this path
    // — the customer pays in their own app, no terminal involved —
    // so we don't gate Klarna on a connected reader. Clearpay
    // still uses the virtual-Visa-via-S700 path and DOES need a
    // reader, so the guard stays in place for that branch.
    if (provider === 'klarna') {
      setJourney('klarna');
      setKlarnaOpen(true);
      return;
    }
    if (!reader) {
      setError('No card reader registered. BNPL needs the same reader.');
      return;
    }
    setJourney(provider);
    setBnplOpen(true);
  };

  const isMobile = useIsMobile(640);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  // Subtotal = sum of line items (after any per-line discount). Cart-
  // level discount (lng_carts.discount_pence — applied via the manager-
  // approved Apply Discount sheet on VisitDetail) comes off next.
  //
  // The deposit is NOT subtracted again here. lng_visit_paid_status's
  // amount_paid_pence already credits paid deposits + Shopify-prepaid
  // orders alongside succeeded lng_payments, so the outstanding is
  // simply subtotal-after-discount minus that single combined credit.
  // (The previous shape did `subtotal − deposit − amount_paid` and
  // double-subtracted every deposit pound.)
  //
  // Subtotal math goes through the canonical carts.ts helper so the
  // Pay breakdown can never drift from server-side outstanding checks.
  const cartDiscount = cart?.discount_pence ?? 0;
  const subtotalAfterDiscount = computeCartSubtotal(items, cartDiscount);
  const subtotal = subtotalAfterDiscount + cartDiscount;
  const depositPence = deposit?.status === 'paid' ? deposit.pence : 0;

  // Split-payment plumbing. Read the visit's paid-status view so we
  // know how much has already been collected on this cart (deposit +
  // succeeded payments + any linked Shopify order). Outstanding is
  // the only number we need to compute against — the view does the
  // summing. Refresh after each successful payment so the next method
  // picker sees the new balance.
  const { data: paidStatus, refresh: refreshPaid } = useVisitPaidStatus(id);
  const amountPaidPence = paidStatus?.amount_paid_pence ?? 0;
  const outstandingPence = computeCartOutstanding(subtotalAfterDiscount, amountPaidPence);
  // Pence collected at the till today, separate from the deposit and
  // any Shopify pre-paid credit. Used in the visible breakdown so we
  // can show "Deposit −£X · Collected −£Y" without double-counting.
  const tillCollectedPence = Math.max(0, amountPaidPence - depositPence);
  // Captured payments on this cart, used for the "Already collected"
  // list with per-row Void buttons. Refreshes alongside paidStatus
  // after a successful void / new payment.
  const { data: cartPayments, refresh: refreshCartPayments } = useCartPayments(cart?.id ?? null);
  const succeededPayments = cartPayments.filter((p) => p.status === 'succeeded');

  // Void sheet state. Captures the reason + the approving manager's
  // credentials. The cashier can't approve their own void — the
  // manager re-auths in a parallel client and we capture their
  // accounts.id without disturbing the cashier's session.
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<CartPaymentRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidManagerId, setVoidManagerId] = useState('');
  const [voidManagers, setVoidManagers] = useState<ManagerRow[]>([]);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const openVoidSheet = async (p: CartPaymentRow) => {
    setVoidTarget(p);
    setVoidReason('');
    setVoidManagerId('');
    setVoidError(null);
    setVoidOpen(true);
    try {
      const list = await listManagers();
      setVoidManagers(list);
    } catch (e) {
      setVoidError(e instanceof Error ? e.message : 'Could not load managers');
    }
  };
  const submitVoid = async () => {
    if (!voidTarget) return;
    if (!voidManagerId) {
      setVoidError('Pick the manager who approved this.');
      return;
    }
    setVoidBusy(true);
    setVoidError(null);
    try {
      await voidPayment(voidTarget.id, voidTarget.method, voidReason, voidManagerId);
      setVoidOpen(false);
      setVoidTarget(null);
      // Both the paid roll-up and the captured-payments list need
      // refreshing — voiding drops the succeeded sum and reopens
      // the cart, so the next render shows the new outstanding.
      refreshPaid();
      refreshCartPayments();
      // Drop the user back to the choose stage if they were on
      // the success/cash/etc. stage — the bill isn't settled now.
      setStage('choose');
    } catch (e) {
      setVoidError(e instanceof Error ? e.message : 'Could not void');
    } finally {
      setVoidBusy(false);
    }
  };

  // Pay-in-full vs split mode. 'full' is the default — picking a
  // method charges the full outstanding. 'split' reveals an explicit
  // "Take £X now" panel and the method cards reflect the partial
  // amount. We default back to 'full' whenever the outstanding hits
  // zero or the user comes back from a successful charge.
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('full');
  // splitAmountText: typed amount for the "Take £X now" field in
  // split mode. Stored as text so half-typed values like "20." don't
  // snap back. Only consulted when paymentMode === 'split'.
  const [splitAmountText, setSplitAmountText] = useState('');
  const parsedSplitAmount = (() => {
    const trimmed = splitAmountText.trim();
    if (trimmed === '') return 0;
    const n = Number(trimmed.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100), outstandingPence);
  })();
  // The amount the chosen method will actually charge.
  //   - full mode: the full outstanding
  //   - split mode with an amount typed: that amount
  //   - split mode with nothing typed: zero, which disables the
  //     method cards so an accidental tap can't push the whole bill
  //     through when the intent was a partial.
  const chargeAmountPence =
    paymentMode === 'split' ? parsedSplitAmount : outstandingPence;
  // Boolean: is this charge going to clear the bill?
  const willClearBill = chargeAmountPence > 0 && chargeAmountPence >= outstandingPence;
  // Variable kept around for receipt copy (the "£X paid" headline).
  const total = chargeAmountPence;

  const submitCash = async () => {
    if (!cart) return;
    if (chargeAmountPence <= 0) {
      setError('Charge amount must be positive.');
      return;
    }
    const tenderedFloat = Number(tendered.replace(/[^\d.]/g, ''));
    const tenderedPence = Math.round(tenderedFloat * 100);
    if (!Number.isFinite(tenderedPence) || tenderedPence < chargeAmountPence) {
      setError(`Tendered amount must be at least ${formatPence(chargeAmountPence)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const change = tenderedPence - chargeAmountPence;
      const splitBit =
        chargeAmountPence < outstandingPence
          ? ` Split payment, outstanding ${formatPence(outstandingPence - chargeAmountPence)} after this.`
          : '';
      const note =
        depositPence > 0
          ? `Tendered ${formatPence(tenderedPence)}, change ${formatPence(change)}. Deposit ${formatPence(depositPence)} via ${deposit?.provider ?? 'paypal'} already collected at booking.${splitBit}`
          : `Tendered ${formatPence(tenderedPence)}, change ${formatPence(change)}.${splitBit}`;
      const payment = await recordCashPayment(cart.id, chargeAmountPence, note);
      setPaymentId(payment.id);
      // Refresh the paid status so the next render sees the new
      // outstanding. If this charge cleared the bill, advance to
      // success; otherwise return to the method picker so staff
      // can take the next part of the split.
      refreshPaid();
      if (willClearBill) {
        setStage('success');
      } else {
        setTendered('');
        // Reset split state so the next leg defaults to "pay full
        // remaining" — staff can opt back into split mode if they
        // need to break the remainder up further.
        setPaymentMode('full');
        setSplitAmountText('');
        setStage('choose');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const sendReceipt = async () => {
    if (!paymentId || receiptChannel === 'none') {
      goBackToVisit();
      return;
    }
    setBusy(true);
    try {
      // 1. Insert as queued (no sent_at). The edge function flips it to sent
      //    after Resend confirms delivery — or sets failure_reason.
      const { data: receipt, error: insErr } = await supabase
        .from('lng_receipts')
        .insert({
          payment_id: paymentId,
          channel: receiptChannel,
          recipient: receiptRecipient || null,
          content: null,
        })
        .select('id')
        .single();
      if (insErr || !receipt) throw new Error(insErr?.message ?? 'Could not queue receipt');

      // 2. Invoke the send-receipt edge function via supabase-js. The SDK
      //    handles token refresh, base-URL resolution and CORS preflight
      //    transparently — the same path the manual-booking confirmation
      //    uses, which made it the most reliable email send-site in the
      //    app. The previous raw-fetch path bypassed the SDK and dropped
      //    delivery whenever the session token rotated mid-checkout.
      const { data: invokeData, error: invokeErr } = await supabase.functions.invoke<{
        ok?: boolean;
        error?: string;
        provider?: string;
      }>('send-receipt', {
        body: { receiptId: (receipt as { id: string }).id },
      });
      if (invokeErr) {
        // Transport failure (network, auth, function 5xx). The receipt row
        // stays queued so /admin can retry — staff are told explicitly
        // that the receipt didn't ship yet.
        setError(
          `Receipt queued but not delivered: ${invokeErr.message}. You can resend from /admin → Pending receipts.`,
        );
      } else if (invokeData && invokeData.ok !== true) {
        const reason = invokeData.error ?? 'unknown';
        setError(
          `Receipt queued but not delivered: ${reason}. You can resend from /admin → Pending receipts.`,
        );
      }

      // Visit completion is now an explicit step on VisitDetail
      // (Complete visit button + fulfilment sheet). Pay only handles
      // payment + receipt; staff hits Complete back on the visit
      // page and answers the in-person-vs-shipping question there.
      goBackToVisit();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  // Wait for BOTH the visit and the cart to finish loading before
  // deciding whether the page is empty. Otherwise the user sees the
  // empty-state copy ("Nothing to pay for") flash while items are
  // still in flight, then snap to the real page once they land. See
  // memory: feedback_no_load_flicker. Skeleton renders during load
  // so the page shape stays stable.
  const isLoading = visitLoading || cartLoading;
  const isEmpty = !isLoading && (!visit || !cart || items.length === 0);
  if (isLoading || isEmpty) {
    return (
      <main
        style={{
          minHeight: '100dvh',
          background: theme.color.bg,
          padding: isMobile ? theme.space[4] : theme.space[6],
          paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
          paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
          <PayBreadcrumbs visitId={id ?? null} entry={location.state as PayEntryState | null} />
          <Card padding="lg" style={{ marginTop: theme.space[5] }}>
            {isLoading ? (
              // Mirrors the resolved layout: heading band, totals
              // strip, two payment-method tiles. Keeps the visual
              // weight of the skeleton close to the real page so the
              // hand-off lands without a layout shift.
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }} aria-busy="true" aria-live="polite">
                <Skeleton height={32} width="60%" radius={8} />
                <Skeleton height={20} width="35%" radius={6} />
                <Skeleton height={120} radius={12} />
                <Skeleton height={120} radius={12} />
              </div>
            ) : (
              <EmptyState
                title="Nothing to pay for"
                description="Cart has no line items. Add some, then come back."
                action={<Button variant="primary" onClick={goBackToVisit}>Back to appointment</Button>}
              />
            )}
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <PayBreadcrumbs visitId={id ?? null} entry={location.state as PayEntryState | null} />

        <h1
          style={{
            margin: `${theme.space[5]}px 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {patient ? patientFullName(patient) : 'Appointment'} · {formatPence(outstandingPence)}
          <span
            style={{
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.medium,
              color: theme.color.inkMuted,
              marginLeft: theme.space[2],
            }}
          >
            {tillCollectedPence > 0 ? 'outstanding' : depositPence > 0 ? 'to collect' : ''}
          </span>
        </h1>
        {cartDiscount > 0 || depositPence > 0 || tillCollectedPence > 0 ? (
          <p
            style={{
              margin: `0 0 ${theme.space[3]}px`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>Subtotal {formatPence(subtotal)}</span>
            {cartDiscount > 0 ? (
              <>
                <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                  Discount −{formatPence(cartDiscount)}
                </span>
              </>
            ) : null}
            {depositPence > 0 ? (
              <>
                <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                  {deposit?.paidInFullAtBooking ? 'Paid in full' : 'Deposit'} −{formatPence(depositPence)}
                </span>
                <span style={{ color: theme.color.inkSubtle }}>
                  {' '}
                  ({formatDepositSourceSuffix(deposit)})
                </span>
              </>
            ) : null}
            {tillCollectedPence > 0 ? (
              <>
                <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                  Collected −{formatPence(tillCollectedPence)}
                </span>
              </>
            ) : null}
          </p>
        ) : null}
        <p style={{ margin: `0 0 ${theme.space[6]}px`, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
          {stage === 'choose' &&
            (succeededPayments.length > 0
              ? 'Take the rest of the payment, or void a leg above to start over.'
              : 'Take the full amount in one go, or split across more than one method.')}
          {stage === 'cash' && 'Tap what the customer hands you. Change is calculated for you.'}
          {stage === 'card' && 'Card terminal flow ships in slice 8.'}
          {stage === 'bnpl' && 'Customer pays via Klarna or Clearpay through the same reader.'}
          {stage === 'success' && 'Choose how to send the receipt.'}
        </p>

        {stage === 'choose' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            {/* Collected-so-far panel. Only shown mid-split, and only
                when at least one payment has actually landed on the
                cart. Frames the "this payment isn't the only one"
                state at the top of the page so onlookers immediately
                see the bill is being broken up. */}
            {succeededPayments.length > 0 ? (
              <CollectedSoFarCard
                payments={succeededPayments}
                onVoid={openVoidSheet}
              />
            ) : null}

            <PaymentModeToggle
              mode={paymentMode}
              outstandingPence={outstandingPence}
              splitAmountPence={parsedSplitAmount}
              onChange={(next) => {
                setPaymentMode(next);
                if (next === 'full') setSplitAmountText('');
              }}
            />

            {paymentMode === 'split' ? (
              <SplitAmountPanel
                outstandingPence={outstandingPence}
                splitAmountText={splitAmountText}
                onChangeAmount={setSplitAmountText}
              />
            ) : null}

            {/* Method picker. Each card shows what it will actually
                charge (mode + amount); under split mode the cards
                are disabled until the staff has set a split amount,
                so an accidental tap can't push the full balance
                through when the intent was a partial. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <MethodCard
                icon={<CreditCard size={20} />}
                title="Card"
                description={
                  !reader
                    ? 'No reader registered yet'
                    : paymentMode === 'split' && parsedSplitAmount === 0
                      ? 'Set a split amount above first'
                      : `Charge ${formatPence(chargeAmountPence)} on ${reader.friendly_name}`
                }
                onClick={() => openTerminal('standard')}
                disabled={!reader || chargeAmountPence <= 0}
              />
              <MethodCard
                icon={<Banknote size={20} />}
                title="Cash"
                description={
                  paymentMode === 'split' && parsedSplitAmount === 0
                    ? 'Set a split amount above first'
                    : `Take ${formatPence(chargeAmountPence)} in cash, change calculated for you`
                }
                onClick={() => setStage('cash')}
                disabled={chargeAmountPence <= 0}
              />
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Buy now, pay later"
                description={
                  !reader
                    ? 'Needs a registered reader'
                    : paymentMode === 'split' && parsedSplitAmount === 0
                      ? 'Set a split amount above first'
                      : `Charge ${formatPence(chargeAmountPence)} via Klarna or Clearpay`
                }
                onClick={() => setStage('bnpl')}
                disabled={!reader || chargeAmountPence <= 0}
              />
            </div>
          </div>
        ) : stage === 'bnpl' ? (
          <Card padding="lg">
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Pick a provider
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Both work the same way: customer opens their app, taps phone on the reader. Receipt says Visa contactless.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Klarna"
                description={`£30 minimum, £2,000 max. Reader: ${reader?.friendly_name ?? '—'}`}
                onClick={() => openBnpl('klarna')}
                disabled={!reader}
              />
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Clearpay"
                description={`Customer's app caps the limit. Reader: ${reader?.friendly_name ?? '—'}`}
                onClick={() => openBnpl('clearpay')}
                disabled={!reader}
              />
            </div>
            <Button variant="tertiary" onClick={() => setStage('choose')} style={{ marginTop: theme.space[4] }}>
              Back to methods
            </Button>
          </Card>
        ) : stage === 'cash' ? (
          <Card padding="lg">
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold, letterSpacing: theme.type.tracking.tight }}>
              Cash · {formatPence(chargeAmountPence)} due
            </h2>
            <p
              style={{
                margin: `${theme.space[2]}px 0 ${theme.space[5]}px`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.normal,
              }}
            >
              {chargeAmountPence < outstandingPence
                ? `Tap the amount the customer hands over. ${formatPence(outstandingPence - chargeAmountPence)} will still be due after this leg.`
                : 'Tap the amount the customer hands over. Change is calculated for you.'}
            </p>
            <QuickAmountButtons
              chargeAmountPence={chargeAmountPence}
              tendered={tendered}
              onSelect={setTendered}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], marginTop: theme.space[5] }}>
              <Input
                label="Or type an exact amount (£)"
                numericFormat="currency"
                placeholder={`min ${formatPence(chargeAmountPence)}`}
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
              />
            </div>
            <ChangeRow tendered={tendered} totalPence={chargeAmountPence} />
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', marginTop: theme.space[5] }}>
              <Button variant="tertiary" onClick={() => setStage('choose')}>
                Back
              </Button>
              <Button variant="primary" onClick={submitCash} loading={busy}>
                Record cash payment
              </Button>
            </div>
          </Card>
        ) : stage === 'card' ? (
          <Card padding="lg">
            <EmptyState
              title="Use the Card option above"
              description="The terminal modal opens automatically when you pick Card."
              action={<Button variant="primary" onClick={() => setStage('choose')}>Back</Button>}
            />
          </Card>
        ) : (
          <Card padding="lg">
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              {formatPence(total)} paid
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted }}>
              Receipt channel:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <ReceiptOption
                value="email"
                label="Email"
                hint="To the address on file or one you enter below."
                selected={receiptChannel === 'email'}
                onClick={() => setReceiptChannel('email')}
              />
              <ReceiptOption
                value="sms"
                label="SMS"
                hint="Slice 13b — provider not wired yet. Logs only."
                selected={receiptChannel === 'sms'}
                onClick={() => setReceiptChannel('sms')}
              />
              <ReceiptOption
                value="none"
                label="No receipt"
                hint="Customer doesn't want one."
                selected={receiptChannel === 'none'}
                onClick={() => setReceiptChannel('none')}
              />
            </div>

            {receiptChannel !== 'none' ? (
              <div style={{ marginTop: theme.space[4] }}>
                <Input
                  label={receiptChannel === 'email' ? 'Email address' : 'Phone number'}
                  placeholder={receiptChannel === 'email' ? (patient?.email ?? 'name@example.com') : (patient?.phone ?? '+44...')}
                  value={receiptRecipient}
                  onChange={(e) => setReceiptRecipient(e.target.value)}
                />
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', marginTop: theme.space[5] }}>
              <Button variant="primary" onClick={sendReceipt} loading={busy} showArrow>
                Done
              </Button>
            </div>
          </Card>
        )}

        <div style={{ marginTop: theme.space[5], display: 'flex', justifyContent: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <StatusPill tone="neutral" size="sm">
            Subtotal: {formatPence(subtotal)}
          </StatusPill>
          {amountPaidPence > 0 ? (
            <StatusPill tone="neutral" size="sm">
              Collected: {formatPence(amountPaidPence)}
            </StatusPill>
          ) : null}
          <StatusPill tone="neutral" size="sm">
            Outstanding: {formatPence(outstandingPence)}
          </StatusPill>
        </div>
      </div>

      {reader && cart ? (
        <>
          <TerminalPaymentModal
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            visitId={visit?.id ?? ''}
            cartId={cart.id}
            amountPence={chargeAmountPence}
            readerId={reader.id}
            readerName={reader.friendly_name}
            paymentJourney={journey === 'klarna' || journey === 'clearpay' ? journey : 'standard'}
            onSucceeded={(pid) => {
              setPaymentId(pid);
              setTerminalOpen(false);
              refreshPaid();
              if (willClearBill) {
                setStage('success');
              } else {
                setPaymentMode('full');
                setSplitAmountText('');
                setStage('choose');
              }
            }}
          />
          {/* Clearpay still rides the virtual-Visa-via-S700 path
              that BNPLHelper drives. Klarna moved off it onto the
              native In-Store API (KlarnaInStoreModal below) where
              the customer scans a QR and pays in their own app —
              no S700 tap, no fumbling with Apple/Google Pay. */}
          {journey === 'clearpay' ? (
            <BNPLHelper
              open={bnplOpen}
              onClose={() => setBnplOpen(false)}
              provider={journey}
              visitId={visit?.id ?? ''}
              cartId={cart.id}
              amountPence={chargeAmountPence}
              readerId={reader.id}
              readerName={reader.friendly_name}
              onSucceeded={(pid) => {
                setPaymentId(pid);
                setBnplOpen(false);
                refreshPaid();
                if (willClearBill) {
                  setStage('success');
                } else {
                  setPaymentMode('full');
                  setSplitAmountText('');
                  setStage('choose');
                }
              }}
            />
          ) : null}
        </>
      ) : null}

      {/* Klarna In-Store API modal. Rendered OUTSIDE the reader
          guard above because Klarna doesn't need the S700 — the
          customer pays in their own Klarna app via the QR. cart is
          still required (we need the cart_id for the session). */}
      {cart ? (
        <KlarnaInStoreModal
          open={klarnaOpen}
          onClose={() => setKlarnaOpen(false)}
          visitId={visit?.id ?? ''}
          cartId={cart.id}
          amountPence={chargeAmountPence}
          onSucceeded={(pid) => {
            setPaymentId(pid);
            setKlarnaOpen(false);
            refreshPaid();
            if (willClearBill) {
              setStage('success');
            } else {
              setPaymentMode('full');
              setSplitAmountText('');
              setStage('choose');
            }
          }}
        />
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not record payment" description={error} duration={8000} onDismiss={() => setError(null)} />
        </div>
      ) : null}

      {/* Void payment sheet. Required reason + manager email/password
          for the 2-staff sign-off. The manager signs in to a
          parallel Supabase client (no session swap) so we can
          capture their accounts.id without disturbing the cashier
          who's running the till. */}
      <BottomSheet
        open={voidOpen}
        onClose={() => !voidBusy && setVoidOpen(false)}
        dismissable={!voidBusy}
        title={voidTarget ? `Void ${formatPence(voidTarget.amount_pence)} payment` : 'Void payment'}
        description="Voiding requires a manager sign-off. Both you and the manager will be on the audit row."
        footer={
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              justifyContent: 'flex-end',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button variant="secondary" onClick={() => setVoidOpen(false)} disabled={voidBusy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitVoid} loading={voidBusy}>
              Void payment
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <Input
            label="Reason"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder="e.g. Customer changed mind on method, retake as card"
          />
          <div
            style={{
              padding: theme.space[4],
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.bg,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: theme.type.size.md,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                }}
              >
                Manager sign-off
              </h3>
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                Pick the manager who approved this void. Their email lands on the audit row.
              </p>
            </div>
            <DropdownSelect<string>
              label="Approving manager"
              required
              value={voidManagerId}
              options={voidManagers.map((m) => ({
                value: m.id,
                label: `${m.name} (${m.login_email})`,
              }))}
              onChange={(v) => setVoidManagerId(v)}
              placeholder={
                voidManagers.length === 0
                  ? 'No managers configured. Add one in Admin > Staff.'
                  : 'Pick the manager who approved this'
              }
              disabled={voidManagers.length === 0}
            />
          </div>
          {voidError ? (
            <p
              role="alert"
              style={{
                margin: 0,
                color: theme.color.alert,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
              }}
            >
              {voidError}
            </p>
          ) : null}
        </div>
      </BottomSheet>
    </main>
  );
}

function PayBreadcrumbs({
  visitId,
  entry,
}: {
  visitId: string | null;
  entry: PayEntryState | null;
}) {
  const navigate = useNavigate();
  const e = entry ?? {};

  const items = (() => {
    // Entered from a visit page: render the full chain so each crumb
    // pops back to the right step. The "Visit" crumb preserves the
    // visit's own entry state so its breadcrumb stays intact when
    // navigated back to.
    if (e.from === 'visit' && e.visitId && e.visitOpenedAt) {
      // Pay's chain has no separate patient crumb, so the visit
      // crumb takes ownership of the patient name. Falls back to
      // bare "Appt. {date}" when the name isn't in state.
      const visitLabel = formatVisitCrumb({
        name: e.visitEntry?.patientName ?? null,
        openedAtIso: e.visitOpenedAt,
        includeName: true,
      });
      const visitState = e.visitEntry ?? null;
      const visitFrom = visitState?.from;
      const baseCrumb =
        visitFrom === 'patient'
          ? { label: 'Patients', onClick: () => navigate('/patients') }
          : visitFrom === 'in_clinic'
            ? { label: 'In clinic', onClick: () => navigate('/in-clinic') }
            : { label: 'Schedule', onClick: () => navigate('/schedule') };
      return [
        baseCrumb,
        {
          label: visitLabel,
          onClick: () =>
            navigate(`/visit/${e.visitId}`, {
              state: visitState ?? undefined,
            }),
        },
        { label: 'Take payment' },
      ];
    }
    // No entry state — direct URL paste or browser refresh. Show a
    // sensible default that still gets the receptionist out via the
    // visit page.
    return [
      { label: 'Schedule', onClick: () => navigate('/schedule') },
      visitId
        ? { label: 'Appointment', onClick: () => navigate(`/visit/${visitId}`) }
        : { label: 'Appointment' },
      { label: 'Take payment' },
    ];
  })();

  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb items={items} />
    </div>
  );
}

function MethodCard({
  icon,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        borderRadius: 16,
        padding: theme.space[5],
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        gap: theme.space[4],
        alignItems: 'center',
        fontFamily: 'inherit',
        boxShadow: theme.shadow.card,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {title}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          {description}
        </p>
      </div>
    </button>
  );
}

// Round amounts a patient is likely to hand over in cash, picked to
// match the actual UK note denominations (£5/£10/£20/£50) rather than
// arbitrary increments. We surface the exact bill first so a clean
// "tendered = total, no change" tap is always one button away, then
// climb in natural cash steps:
//   - First chip past exact: round up to the next £5/£10/£20/£50
//     depending on the bill size (small bills round in £5s; £100+
//     bills round in £50s).
//   - Then bigger natural breakpoints so the four chips span the
//     range a customer could plausibly hand over.
// e.g. £398 → [£398, £400, £450, £500]
//      £85  → [£85,  £90,  £100, £150]
//      £12  → [£12,  £15,  £20,  £30]
function quickAmounts(chargeAmountPence: number): { pence: number; isExact: boolean }[] {
  if (chargeAmountPence <= 0) return [];
  const pounds = chargeAmountPence / 100;
  // Step sizes mapped to plausible cash denomination behaviour.
  const baseStep =
    pounds < 20 ? 500        // £5 steps for small bills
    : pounds < 100 ? 1000    // £10 steps
    : pounds < 500 ? 5000    // £50 steps for clinic-sized bills
    : 10000;                 // £100 steps for big bills
  const exactIsRound = chargeAmountPence % baseStep === 0;
  const firstRoundUp = Math.ceil(chargeAmountPence / baseStep) * baseStep;
  const climbing: number[] = [];
  let cursor = firstRoundUp;
  while (climbing.length < 3) {
    cursor += baseStep;
    climbing.push(cursor);
  }
  const all: { pence: number; isExact: boolean }[] = [
    { pence: chargeAmountPence, isExact: true },
  ];
  if (!exactIsRound) all.push({ pence: firstRoundUp, isExact: false });
  for (const c of climbing) {
    if (all.length >= 4) break;
    all.push({ pence: c, isExact: false });
  }
  // De-dupe defensively (shouldn't happen but cheap to guard).
  const seen = new Set<number>();
  return all.filter((a) => {
    if (seen.has(a.pence)) return false;
    seen.add(a.pence);
    return true;
  }).slice(0, 4);
}

// Quick-pay buttons for the cash tender screen. Bigger and more
// obvious than the previous pill chips: a 2-column grid of full-
// width buttons so any onlooker sees them as the primary action.
// First button is always "Exact £X" so a clean no-change tap is one
// touch away; the rest climb in real cash denominations (see
// quickAmounts above for the algorithm).
function QuickAmountButtons({
  chargeAmountPence,
  tendered,
  onSelect,
}: {
  chargeAmountPence: number;
  tendered: string;
  onSelect: (value: string) => void;
}) {
  const amounts = quickAmounts(chargeAmountPence);
  if (amounts.length === 0) return null;

  const tenderedPence = Math.round(Number(tendered.replace(/[^\d.]/g, '')) * 100);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: theme.space[3],
      }}
    >
      {amounts.map(({ pence, isExact }) => {
        const isSelected = tenderedPence === pence;
        const change = pence - chargeAmountPence;
        const amountLabel = `£${(pence / 100).toLocaleString('en-GB', {
          minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
          maximumFractionDigits: 2,
        })}`;
        const sub = isExact
          ? 'Exact, no change'
          : change > 0
            ? `Change ${formatPence(change)}`
            : '';
        return (
          <button
            key={pence}
            type="button"
            onClick={() => onSelect((pence / 100).toFixed(2))}
            style={{
              appearance: 'none',
              border: `1.5px solid ${isSelected ? theme.color.ink : theme.color.border}`,
              background: isSelected ? 'rgba(14, 20, 20, 0.04)' : theme.color.surface,
              borderRadius: theme.radius.input,
              padding: `${theme.space[4]}px ${theme.space[3]}px`,
              fontFamily: 'inherit',
              color: theme.color.ink,
              cursor: 'pointer',
              minHeight: 72,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              justifyContent: 'center',
              gap: 2,
              transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: theme.type.tracking.tight,
                lineHeight: theme.type.leading.tight,
              }}
            >
              {amountLabel}
            </span>
            {sub ? (
              <span
                style={{
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  fontWeight: theme.type.weight.medium,
                }}
              >
                {sub}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// Pay-in-full / Split toggle. Two large pill buttons sit side by
// side; "Pay in full" is highlighted by default so the common path
// is the one staff sees first. Picking Split flips the panel below
// to reveal the amount-to-take-now field.
function PaymentModeToggle({
  mode,
  outstandingPence,
  splitAmountPence,
  onChange,
}: {
  mode: PaymentMode;
  outstandingPence: number;
  splitAmountPence: number;
  onChange: (next: PaymentMode) => void;
}) {
  const splitLabel =
    mode === 'split' && splitAmountPence > 0
      ? `Split · ${formatPence(splitAmountPence)} now`
      : 'Split payment';
  return (
    <div
      role="tablist"
      aria-label="Payment mode"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: theme.space[2],
        padding: theme.space[1],
        background: theme.color.bg,
        borderRadius: theme.radius.pill,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <ModeTab
        selected={mode === 'full'}
        label={`Pay in full · ${formatPence(outstandingPence)}`}
        onClick={() => onChange('full')}
      />
      <ModeTab
        selected={mode === 'split'}
        label={splitLabel}
        onClick={() => onChange('split')}
      />
    </div>
  );
}

function ModeTab({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: selected ? theme.color.surface : 'transparent',
        boxShadow: selected ? theme.shadow.card : 'none',
        borderRadius: theme.radius.pill,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: selected ? theme.color.ink : theme.color.inkMuted,
        cursor: 'pointer',
        minHeight: 44,
        letterSpacing: theme.type.tracking.tight,
        fontVariantNumeric: 'tabular-nums',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {label}
    </button>
  );
}

// "Take £X now" panel revealed when split mode is on. Quick chips
// suggest natural splits (50%, 25%, half rounded down to £50) so
// staff can set a sensible amount in one tap; manual entry is right
// underneath for any custom amount. A live "£Y still due" line at
// the bottom makes the consequence of the split obvious.
function SplitAmountPanel({
  outstandingPence,
  splitAmountText,
  onChangeAmount,
}: {
  outstandingPence: number;
  splitAmountText: string;
  onChangeAmount: (next: string) => void;
}) {
  const splitChips = splitChipAmounts(outstandingPence);
  const trimmed = splitAmountText.trim();
  const parsed = trimmed === '' ? 0 : Math.round(Number(trimmed.replace(/[^\d.]/g, '')) * 100);
  const safeParsed = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, outstandingPence) : 0;
  const remainingPence = Math.max(0, outstandingPence - safeParsed);
  return (
    <div
      style={{
        padding: theme.space[5],
        borderRadius: 16,
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
        boxShadow: theme.shadow.card,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Take part of the bill now
        </h3>
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
          Pick how much to charge on this method. The rest stays on the bill so you can finish on a different method next.
        </p>
      </div>
      {splitChips.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${splitChips.length}, 1fr)`,
            gap: theme.space[2],
          }}
        >
          {splitChips.map((pence) => {
            const isSelected = safeParsed === pence;
            return (
              <button
                key={pence}
                type="button"
                onClick={() => onChangeAmount((pence / 100).toFixed(2))}
                style={{
                  appearance: 'none',
                  border: `1.5px solid ${isSelected ? theme.color.ink : theme.color.border}`,
                  background: isSelected ? 'rgba(14, 20, 20, 0.04)' : theme.color.bg,
                  borderRadius: theme.radius.input,
                  padding: `${theme.space[3]}px ${theme.space[2]}px`,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.base,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  cursor: 'pointer',
                  minHeight: 52,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: theme.type.tracking.tight,
                  transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                }}
              >
                {formatPence(pence)}
              </button>
            );
          })}
        </div>
      ) : null}
      <Input
        label="Or type the amount (£)"
        numericFormat="currency"
        placeholder={`up to ${(outstandingPence / 100).toFixed(2)}`}
        value={splitAmountText}
        onChange={(e) => onChangeAmount(e.target.value)}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          borderRadius: theme.radius.input,
          background: theme.color.bg,
        }}
      >
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          Still due after this leg
        </span>
        <span
          style={{
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {formatPence(remainingPence)}
        </span>
      </div>
    </div>
  );
}

// Suggest 3 natural split points for the outstanding balance. Picks
// from a pool of "obvious" cuts (half, quarter, half rounded to the
// nearest cash-friendly £50) and keeps only the ones strictly
// between £0 and the outstanding so they're useful as a partial.
function splitChipAmounts(outstandingPence: number): number[] {
  if (outstandingPence < 1000) return [];
  const candidates = new Set<number>();
  // Half — works for any bill.
  candidates.add(Math.round(outstandingPence / 2));
  // Round half down to the nearest £50 chunk for clinic-sized bills.
  if (outstandingPence >= 10000) {
    candidates.add(Math.floor(outstandingPence / 2 / 5000) * 5000);
  }
  // Quarter — useful for breaking bigger bills into "deposit then
  // three more" patterns.
  if (outstandingPence >= 8000) {
    candidates.add(Math.round(outstandingPence / 4));
  }
  // Round £100 just below half — common round-number ask.
  const halfRound100 = Math.floor(outstandingPence / 2 / 10000) * 10000;
  if (halfRound100 > 0 && outstandingPence >= 20000) candidates.add(halfRound100);
  // Strip any zero or full-balance entries — those aren't splits.
  const valid = Array.from(candidates)
    .filter((p) => p > 0 && p < outstandingPence)
    .sort((a, b) => a - b);
  return valid.slice(0, 3);
}

// "Already collected" panel. Bold heading + per-payment row with a
// Void button. Sits at the top of the choose stage when at least one
// payment has landed; the page hero already shows the outstanding,
// this panel shows where the rest came from.
function CollectedSoFarCard({
  payments,
  onVoid,
}: {
  payments: CartPaymentRow[];
  onVoid: (payment: CartPaymentRow) => void;
}) {
  const total = payments.reduce((s, p) => s + p.amount_pence, 0);
  return (
    <div
      style={{
        padding: theme.space[5],
        borderRadius: 16,
        background: theme.color.accentBg,
        border: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[4],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space[3] }}>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Already collected on this bill
        </h3>
        <span
          style={{
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.accent,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatPence(total)}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {payments.map((p) => {
          const methodLabel =
            p.method === 'cash' ? 'Cash' : p.method === 'card_terminal' ? 'Card' : p.method;
          const journeyBit =
            p.payment_journey === 'klarna'
              ? ' · Klarna'
              : p.payment_journey === 'clearpay'
                ? ' · Clearpay'
                : '';
          return (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.input,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: theme.type.size.base,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  {formatPence(p.amount_pence)} · {methodLabel}
                  {journeyBit}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.sm,
                    color: theme.color.inkMuted,
                  }}
                >
                  {p.taken_by_name ? `Taken by ${p.taken_by_name}` : 'Cashier unknown'}
                </span>
              </div>
              <Button variant="tertiary" size="sm" onClick={() => onVoid(p)}>
                Void
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChangeRow({ tendered, totalPence }: { tendered: string; totalPence: number }) {
  const tFloat = Number(tendered.replace(/[^\d.]/g, ''));
  const tPence = Math.round(tFloat * 100);
  const change = Number.isFinite(tPence) ? tPence - totalPence : null;
  return (
    <div
      style={{
        marginTop: theme.space[4],
        padding: theme.space[3],
        background: theme.color.bg,
        borderRadius: 12,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}
    >
      <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Change due</span>
      <span
        style={{
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: change !== null && change >= 0 ? theme.color.ink : theme.color.alert,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {change === null ? '—' : formatPence(Math.max(0, change))}
        {change !== null && change < 0 ? ' short' : ''}
      </span>
    </div>
  );
}

function ReceiptOption({
  value,
  label,
  hint,
  selected,
  onClick,
}: {
  value: string;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
        background: selected ? theme.color.ink : theme.color.surface,
        color: selected ? theme.color.surface : theme.color.ink,
        borderRadius: 12,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
      }}
    >
      <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base }}>{label}</span>
      <span style={{ color: selected ? 'rgba(255,255,255,0.7)' : theme.color.inkMuted, fontSize: theme.type.size.xs }}>{hint}</span>
      <span style={{ display: 'none' }}>{value}</span>
    </button>
  );
}
