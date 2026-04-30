import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Banknote, CreditCard, ShoppingBag } from 'lucide-react';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { BottomSheet, Breadcrumb, Button, Card, EmptyState, Input, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { TerminalPaymentModal } from '../components/TerminalPaymentModal/TerminalPaymentModal.tsx';
import { BNPLHelper, type BnplProvider } from '../components/BNPLHelper/BNPLHelper.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { formatVisitCrumb, useVisitDetail } from '../lib/queries/visits.ts';
import { useCart, formatPence } from '../lib/queries/carts.ts';
import {
  approveAsManager,
  recordCashPayment,
  useCartPayments,
  useVisitPaidStatus,
  voidPayment,
  type CartPaymentRow,
} from '../lib/queries/payments.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
import { supabase } from '../lib/supabase.ts';

type Stage = 'choose' | 'cash' | 'card' | 'bnpl' | 'success';
type Journey = 'standard' | 'klarna' | 'clearpay';

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

  // Subtotal = sum of line items. Only PAID deposits credit the bill; a
  // failed deposit is informational (the receptionist sees a red badge in
  // the schedule sheet) and the till still collects the full subtotal.
  // Floor at 0 so a deposit larger than the bill doesn't produce a
  // negative charge — refund handled manually in PayPal.
  const subtotal = items.reduce((s, i) => s + i.line_total_pence - i.discount_pence, 0);
  const depositPence = deposit?.status === 'paid' ? deposit.pence : 0;
  const billAfterDeposit = Math.max(0, subtotal - depositPence);

  // Split-payment plumbing. Read the visit's paid-status view so we
  // know how much has already been collected on this cart (cash +
  // card + BNPL combined). Outstanding = bill - amount paid so far.
  // Refresh after each successful payment so the next method picker
  // sees the new balance.
  const { data: paidStatus, refresh: refreshPaid } = useVisitPaidStatus(id);
  const amountPaidPence = paidStatus?.amount_paid_pence ?? 0;
  const outstandingPence = Math.max(0, billAfterDeposit - amountPaidPence);
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
  const [voidApproverEmail, setVoidApproverEmail] = useState('');
  const [voidApproverPassword, setVoidApproverPassword] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const openVoidSheet = (p: CartPaymentRow) => {
    setVoidTarget(p);
    setVoidReason('');
    setVoidApproverEmail('');
    setVoidApproverPassword('');
    setVoidError(null);
    setVoidOpen(true);
  };
  const submitVoid = async () => {
    if (!voidTarget) return;
    setVoidBusy(true);
    setVoidError(null);
    try {
      const approverId = await approveAsManager(voidApproverEmail, voidApproverPassword);
      await voidPayment(voidTarget.id, voidTarget.method, voidReason, approverId);
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

  // chargeAmountPence: what the next single payment will be for.
  // Defaults to outstanding so the common case (single full
  // payment) needs no extra clicks. Staff edits it down to support
  // splits ("£40 on this card, then £60 cash"). Stored as text so
  // intermediate edits like "20." don't snap back.
  const [chargeAmountText, setChargeAmountText] = useState('');
  const parsedChargeAmount = (() => {
    const trimmed = chargeAmountText.trim();
    if (trimmed === '') return outstandingPence;
    const n = Number(trimmed.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100), outstandingPence);
  })();
  // The amount the chosen method will actually charge. Always
  // bounded to the current outstanding so a stale text value can't
  // overshoot.
  const chargeAmountPence = Math.min(parsedChargeAmount, outstandingPence);
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
        setChargeAmountText('');
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
      //    after Resend/Twilio confirms delivery — or sets failure_reason.
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

      // 2. Invoke the send-receipt edge function. Surface but don't block on
      //    a delivery failure — the row is recoverable from /admin later.
      const url = new URL(import.meta.env.VITE_SUPABASE_URL);
      const projectRef = url.hostname.split('.')[0];
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const r = await fetch(`https://${projectRef}.functions.supabase.co/send-receipt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiptId: (receipt as { id: string }).id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) {
        const reason = body?.error ?? `HTTP ${r.status}`;
        setError(`Receipt queued but not delivered: ${reason}. You can resend from the appointment later.`);
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
            {amountPaidPence > 0 ? 'outstanding' : depositPence > 0 ? 'to collect' : ''}
          </span>
        </h1>
        {depositPence > 0 || amountPaidPence > 0 ? (
          <p
            style={{
              margin: `0 0 ${theme.space[3]}px`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>Subtotal {formatPence(subtotal)}</span>
            {depositPence > 0 ? (
              <>
                <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                  Deposit −{formatPence(depositPence)}
                </span>
                <span style={{ color: theme.color.inkSubtle }}>
                  {' '}
                  ({deposit?.provider === 'stripe' ? 'Stripe' : 'PayPal'} via Calendly)
                </span>
              </>
            ) : null}
            {amountPaidPence > 0 ? (
              <>
                <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                  Collected −{formatPence(amountPaidPence)}
                </span>
              </>
            ) : null}
          </p>
        ) : null}
        <p style={{ margin: `0 0 ${theme.space[6]}px`, color: theme.color.inkMuted }}>
          {stage === 'choose' && 'Choose a payment method.'}
          {stage === 'cash' && 'Enter the amount tendered. Change calculates live.'}
          {stage === 'card' && 'Card terminal flow ships in slice 8.'}
          {stage === 'bnpl' && 'BNPL helper ships in slice 12.'}
          {stage === 'success' && 'Choose how to send the receipt.'}
        </p>

        {stage === 'choose' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            {/* Already-collected list. Each succeeded payment is
                voidable but only with manager sign-off. Reasons
                land in the audit trail; the row itself stays as
                'cancelled' rather than being deleted. */}
            {succeededPayments.length > 0 ? (
              <Card padding="md" style={{ background: theme.color.surface }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontWeight: theme.type.weight.medium,
                    textTransform: 'uppercase',
                    letterSpacing: theme.type.tracking.wide,
                    marginBottom: theme.space[3],
                  }}
                >
                  Already collected
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                  {succeededPayments.map((p) => {
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
                          padding: theme.space[3],
                          borderRadius: theme.radius.input,
                          border: `1px solid ${theme.color.border}`,
                          background: theme.color.bg,
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: theme.type.size.base,
                              fontWeight: theme.type.weight.semibold,
                              color: theme.color.ink,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {formatPence(p.amount_pence)} · {methodLabel}
                            {journeyBit}
                          </span>
                          <span
                            style={{
                              fontSize: theme.type.size.xs,
                              color: theme.color.inkMuted,
                            }}
                          >
                            {p.taken_by_name ? `by ${p.taken_by_name}` : 'Cashier unknown'}
                          </span>
                        </div>
                        <Button variant="tertiary" size="sm" onClick={() => openVoidSheet(p)}>
                          Void
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ) : null}

            {/* Charge-amount input — defaults to outstanding so the
                common single-payment case needs no extra clicks.
                Edit it down to take a partial (split payment): the
                next method picks up the new outstanding for the
                second part. */}
            <div
              style={{
                padding: theme.space[4],
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[2],
              }}
            >
              <Input
                label="Amount to charge now (£)"
                inputMode="decimal"
                placeholder={(outstandingPence / 100).toFixed(2)}
                value={chargeAmountText}
                onChange={(e) => setChargeAmountText(e.target.value)}
              />
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                Defaults to the outstanding {formatPence(outstandingPence)}. Edit it down to split across methods (cash and card together, etc).
              </p>
            </div>
            <MethodCard
              icon={<CreditCard size={20} />}
              title="Card"
              description={reader ? `${formatPence(chargeAmountPence)} on ${reader.friendly_name}` : 'No reader registered yet'}
              onClick={() => openTerminal('standard')}
              disabled={!reader || chargeAmountPence <= 0}
            />
            <MethodCard
              icon={<Banknote size={20} />}
              title="Cash"
              description={`${formatPence(chargeAmountPence)} cash, change calculator built in.`}
              onClick={() => setStage('cash')}
              disabled={chargeAmountPence <= 0}
            />
            <MethodCard
              icon={<ShoppingBag size={20} />}
              title="Buy now, pay later"
              description={reader ? `${formatPence(chargeAmountPence)} via Klarna or Clearpay on the same reader` : 'Needs a registered reader'}
              onClick={() => setStage('bnpl')}
              disabled={!reader || chargeAmountPence <= 0}
            />
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
            <p
              style={{
                margin: `0 0 ${theme.space[3]}px`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              Recording {formatPence(chargeAmountPence)} cash.
              {chargeAmountPence < outstandingPence
                ? ` Outstanding ${formatPence(outstandingPence - chargeAmountPence)} after this — pick the next method on the previous screen.`
                : ''}
            </p>
            <Input
              label="Tendered (£)"
              autoFocus
              inputMode="decimal"
              placeholder={`min ${formatPence(chargeAmountPence)}`}
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
            />
            <ChangeRow tendered={tendered} totalPence={chargeAmountPence} />
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', marginTop: theme.space[4] }}>
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
                setChargeAmountText('');
                setStage('choose');
              }
            }}
          />
          {(journey === 'klarna' || journey === 'clearpay') ? (
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
                  setChargeAmountText('');
                  setStage('choose');
                }
              }}
            />
          ) : null}
        </>
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
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.bg,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontWeight: theme.type.weight.medium,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              Manager sign-off
            </p>
            <Input
              label="Manager email"
              type="email"
              value={voidApproverEmail}
              onChange={(e) => setVoidApproverEmail(e.target.value)}
              placeholder="manager@venneir.com"
            />
            <Input
              label="Manager password"
              type="password"
              value={voidApproverPassword}
              onChange={(e) => setVoidApproverPassword(e.target.value)}
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
