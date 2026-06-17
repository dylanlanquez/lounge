import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banknote, CreditCard, Phone, ShoppingBag } from 'lucide-react';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { BottomSheet, Breadcrumb, Button, Card, EmptyState, Input, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { TerminalPaymentModal } from '../components/TerminalPaymentModal/TerminalPaymentModal.tsx';
import { MotoPaymentModal } from '../components/MotoPaymentModal/MotoPaymentModal.tsx';
import { BNPLHelper, type BnplProvider } from '../components/BNPLHelper/BNPLHelper.tsx';
import { KlarnaInStoreModal } from '../components/KlarnaInStoreModal/KlarnaInStoreModal.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { formatVisitCrumb, useVisitDetail } from '../lib/queries/visits.ts';
import { completeQuickSaleVisit } from '../lib/queries/quickSale.ts';
import {
  useCart,
  formatPence,
  computeCartSubtotal,
  computeCartOutstanding,
} from '../lib/queries/carts.ts';
import {
  recordCashPayment,
  useCartPayments,
  shopifyOrderAppliesToVisit,
  useVisitPaidStatus,
  voidPayment,
  type CartPaymentRow,
} from '../lib/queries/payments.ts';
import { sendManagerNotification } from '../lib/queries/managerNotifications.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { ManagerNotificationNotice } from '../components/ManagerNotificationNotice/ManagerNotificationNotice.tsx';
import { COUNTER_SALE_EMAIL, patientFullName } from '../lib/queries/patients.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
import { supabase } from '../lib/supabase.ts';
import { formatDepositSourceSuffix } from '../lib/queries/visits.ts';

type Stage = 'choose' | 'cash' | 'card' | 'success';
type Journey = 'standard' | 'klarna' | 'clearpay';
// Two top-level modes on the choose stage. 'full' is the default and
// charges the entire outstanding on the picked method. 'split' reveals
// an explicit "Take £X now" panel so staff can collect part of the
// balance and finish on a different method on the next round.

// Router state read by PayBreadcrumbs to render the right trail. The
// "Take payment" button on VisitDetail forwards a `from: 'visit'`
// payload that carries the visit id, opened-at, and the visit's own
// entry so the breadcrumb here can render [origin] › Visit › Take
// payment, with each crumb popping back to the right place. Direct
// URL pastes (no state) fall back to a sensible default chain.
interface PayEntryState {
  // 'visit' — opened from a clinical visit's "Take payment".
  // 'quick_sale' — opened from the retail Quick Sale flow; the post-
  // payment "Done" returns to a fresh /quick-sale instead of a visit
  // page, and BNPL methods are suppressed (retail sales never offer
  // Klarna/Clearpay).
  from?: 'visit' | 'quick_sale';
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
  const { visit, patient, deposit, appointment, shopifyOrder, loading: visitLoading } = useVisitDetail(id);
  const { cart, items, loading: cartLoading } = useCart(id);
  const navigate = useNavigate();
  const location = useLocation();
  // Hop back to the visit page with its original entry chain intact.
  // VisitDetail forwarded its own state when sending us here; passing
  // it back through means the visit's breadcrumb pre-renders every
  // crumb (origin / patient / timestamp) on first paint with no
  // shimmer transition.
  const payEntry = location.state as PayEntryState | null;
  const visitState = payEntry?.visitEntry ?? undefined;
  // Retail Quick Sale has no clinical visit page to return to — send the
  // operator back to a fresh sale instead. Also gates BNPL visibility.
  const fromQuickSale = payEntry?.from === 'quick_sale';
  const goBackToVisit = () =>
    fromQuickSale
      ? navigate('/quick-sale')
      : navigate(`/visit/${id}`, visitState ? { state: visitState } : undefined);
  // ── URL-survives-refresh stage state ──────────────────────────
  // The success stage is the only payment stage worth preserving
  // across tab-switches / refreshes / browser back. Cash/card are
  // mid-flow and resetting them to 'choose' on reload is the
  // safer default (an interrupted card swipe shouldn't replay
  // itself). When stage='success' we write ?stage=success&payment=<id>
  // to the URL; on next mount we read it back so the receipt
  // picker re-mounts on the same payment instead of dropping the
  // staff onto the method picker for a £0 outstanding bill.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlStage = searchParams.get('stage');
  const urlPayment = searchParams.get('payment');
  const [stage, setStage] = useState<Stage>(
    urlStage === 'success' && urlPayment ? 'success' : 'choose',
  );
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(urlPayment);
  // Retail Quick Sale defaults to "No receipt": a walk-up sale rings up
  // against the anonymous Counter Sale patient (no real email/phone), so
  // emailing by default would send to that system address. Staff can
  // still pick email/SMS and type a recipient. Clinical visits keep the
  // email default (the patient's address prefills).
  const [receiptChannel, setReceiptChannel] = useState<'email' | 'sms' | 'none'>(
    fromQuickSale ? 'none' : 'email',
  );
  const [receiptRecipient, setReceiptRecipient] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  // MOTO (card not present, over the phone) modal. The moto flag is set
  // server-side only on this path; every in-person method never sets it.
  const [motoOpen, setMotoOpen] = useState(false);
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
  const { data: paidStatus, loading: paidStatusLoading, refresh: refreshPaid } = useVisitPaidStatus(id);
  // A retail Quick Sale's visit is created `arrived` (open) and only
  // becomes `complete` once the bill clears — so an abandoned sale never
  // shows as a finished sale. Watching the paid status is the single
  // robust hook across every payment method (cash, terminal, MOTO,
  // Klarna, Clearpay) plus the split auto-advance: when it reads 'paid'
  // we flip the visit complete. The DB update is idempotent
  // (.neq status complete) so a duplicate render can't double-apply, and
  // it's best-effort — a failed flip just leaves the (already-off-board)
  // visit `arrived` until the next reconcile rather than blocking the
  // receipt.
  useEffect(() => {
    if (fromQuickSale && paidStatus?.paid_status === 'paid' && visit?.id) {
      completeQuickSaleVisit(visit.id).catch(() => {});
    }
  }, [fromQuickSale, paidStatus?.paid_status, visit?.id]);
  // Subtract the un-applied Shopify credit on impression visits so the
  // Pay screen doesn't show the £14.95 upgrade fee as collected against
  // a £0 impression cart. See shopifyOrderAppliesToVisit for the gate
  // — same rule as VisitDetail's cart math.
  const rawShopifyCreditPence = shopifyOrder?.pence ?? 0;
  const shopifyAppliesToBill = shopifyOrderAppliesToVisit(appointment?.service_type ?? null);
  const amountPaidPence = Math.max(
    0,
    (paidStatus?.amount_paid_pence ?? 0) - (shopifyAppliesToBill ? 0 : rawShopifyCreditPence),
  );

  // Refund totals split by source so the header credit line can show
  // the NET-of-refunds deposit + an audit sub-line ("£X paid · £Y
  // refunded back to {name}") that matches the cart rollup exactly.
  // Previously the header just showed gross deposit, which read as
  // "paid in full −£500" alongside "outstanding £460" — i.e. the
  // patient had paid more than the cart total yet we were still
  // collecting. The math underneath is correct (amountPaidPence is
  // net of refunds) but the credit line wasn't showing the refund.
  const [refundedAgainstDepositPence, setRefundedAgainstDepositPence] = useState(0);
  const [refundedAgainstTillPence, setRefundedAgainstTillPence] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tillRefund = 0;
      let depositRefund = 0;
      if (cart?.id) {
        const { data: paymentRefunds } = await supabase
          .from('lng_payment_refunds')
          .select('amount_pence, payment:lng_payments!payment_id ( cart_id )')
          .eq('status', 'succeeded')
          .not('payment_id', 'is', null);
        if (cancelled) return;
        for (const r of (paymentRefunds ?? []) as Array<{
          amount_pence: number;
          payment:
            | { cart_id: string | null }
            | { cart_id: string | null }[]
            | null;
        }>) {
          const p = Array.isArray(r.payment) ? r.payment[0] ?? null : r.payment ?? null;
          if (p?.cart_id === cart.id) tillRefund += r.amount_pence ?? 0;
        }
      }
      if (visit?.appointment_id) {
        const { data: depositRefunds } = await supabase
          .from('lng_payment_refunds')
          .select('amount_pence')
          .eq('deposit_appointment_id', visit.appointment_id)
          .eq('status', 'succeeded');
        if (cancelled) return;
        for (const r of (depositRefunds ?? []) as Array<{ amount_pence: number }>) {
          depositRefund += r.amount_pence ?? 0;
        }
      }
      if (!cancelled) {
        setRefundedAgainstDepositPence(depositRefund);
        setRefundedAgainstTillPence(tillRefund);
      }
    })();
    return () => { cancelled = true; };
  }, [cart?.id, visit?.appointment_id, paidStatus?.amount_paid_pence]);
  const patientFirstName = patient?.first_name ?? null;
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

  // Cart-level safety net for terminal + Klarna + BNPL payments. The
  // per-modal onSucceeded path is the happy case, but in production
  // we've seen the receipt screen never appear when the modal misses
  // the UPDATE event for a succeeded payment — modal closed before the
  // Stripe webhook landed, realtime channel dropped mid-tap, retry
  // sequence that minted a fresh attempt_id and the previous channel
  // was bound to the old payment_id. The DB still ends up correct
  // (lng_payments.status='succeeded', cart flipped to paid) but the
  // UI is stuck on the method picker.
  //
  // This subscription watches every lng_payments row for the current
  // cart. Any UPDATE fires a refresh of paidStatus + cartPayments.
  // A second effect below then advances stage='success' whenever a
  // NEW succeeded payment arrives AND the cart is fully settled.
  useEffect(() => {
    if (!cart?.id) return;
    const channel = supabase
      .channel(`lng_payments:cart:${cart.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'lng_payments',
          filter: `cart_id=eq.${cart.id}`,
        },
        () => {
          refreshPaid();
          refreshCartPayments();
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'lng_payments',
          filter: `cart_id=eq.${cart.id}`,
        },
        () => {
          refreshPaid();
          refreshCartPayments();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [cart?.id, refreshPaid, refreshCartPayments]);

  // Count of succeeded payments captured the first time the cart
  // mounts. The safety-net effect below only fires when this count
  // grows — without it, opening Pay for an already-paid visit would
  // skip past the "Already collected" view straight to the receipt
  // picker, which is a behaviour change beyond the bug we're fixing.
  const initialSucceededCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (cart && initialSucceededCountRef.current === null) {
      initialSucceededCountRef.current = succeededPayments.length;
    }
  }, [cart, succeededPayments.length]);

  // True once the operator has actually taken a payment in THIS
  // mounted session (cash recorded, terminal / Klarna / Clearpay /
  // MOTO succeeded, or the realtime safety-net auto-advance fired).
  // It gates the stale-success guard below: a success stage that was
  // genuinely earned this session keeps its receipt picker even if a
  // concurrent refund later reopens the bill, whereas a success stage
  // merely restored from a spent ?stage=success URL gets corrected.
  const tookPaymentThisSessionRef = useRef(false);

  // Auto-advance to the receipt picker when a new succeeded payment
  // lands and clears the outstanding. The lastAdvancedRef gate stops
  // a second render from re-firing for the same payment id.
  const lastAdvancedRef = useRef<string | null>(null);
  useEffect(() => {
    // Never act on half-loaded data. useCart sets `cart` BEFORE its
    // second query (line items) resolves, so there is a render window
    // where cart is present but items is still [] — during which the
    // subtotal reads 0 and, if paid-status has already loaded, the
    // outstanding transiently computes to 0. Without this guard the
    // block below would fire a spurious auto-advance to the receipt
    // stage (and latch tookPaymentThisSessionRef) on a bill that is in
    // fact still owed, which then blocks the stale-success self-correct
    // from ever recovering. Wait until both the cart (incl. items) and
    // the paid status have genuinely settled before judging the bill.
    if (cartLoading || paidStatusLoading) return;
    if (!cart) return;
    if (stage === 'success') return;
    if (outstandingPence > 0) return;
    if (initialSucceededCountRef.current === null) return;
    if (succeededPayments.length <= initialSucceededCountRef.current) return;
    const latest = succeededPayments[succeededPayments.length - 1];
    if (!latest) return;
    if (lastAdvancedRef.current === latest.id) return;
    lastAdvancedRef.current = latest.id;
    tookPaymentThisSessionRef.current = true;
    setPaymentId(latest.id);
    setTerminalOpen(false);
    setKlarnaOpen(false);
    setBnplOpen(false);
    setChargeAmountText('');
    setStage('success');
  }, [cart, cartLoading, paidStatusLoading, stage, outstandingPence, succeededPayments]);

  // Self-correcting guard against a STALE success stage. The success
  // (receipt) stage is restored from ?stage=success&payment=<id> in
  // the URL on mount so a refresh right after the bill clears keeps
  // the receipt picker on screen. But the success screen is only ever
  // a post-payment screen: if the operator arrives here while money is
  // STILL owed — browser back onto a spent success URL, or a discount
  // / refund that reopened the bill after the receipt screen was last
  // shown — then pressing "Take payment" should land on the method
  // picker to collect the remainder, not replay a previous payment's
  // receipt. Once the cart and paid status have loaded for real, drop
  // any stale success back to 'choose'. A payment taken in this very
  // session (tookPaymentThisSessionRef) is never bounced — it earned
  // its receipt screen. Flipping stage clears the ?stage param via the
  // URL-sync effect above, so the address bar self-heals too.
  useEffect(() => {
    if (cartLoading || paidStatusLoading) return;
    if (stage !== 'success') return;
    if (tookPaymentThisSessionRef.current) return;
    if (outstandingPence <= 0) return;
    setStage('choose');
  }, [cartLoading, paidStatusLoading, stage, outstandingPence]);

  // Void sheet state. Captures the reason — manager approval has
  // moved out of band: configured managers get an emailed
  // notification after the void succeeds (Admin → Emails → Manager
  // notifications).
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<CartPaymentRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const { account: currentAccount } = useCurrentAccount();
  const openVoidSheet = (p: CartPaymentRow) => {
    setVoidTarget(p);
    setVoidReason('');
    setVoidError(null);
    setVoidOpen(true);
  };
  const submitVoid = async () => {
    if (!voidTarget) return;
    setVoidBusy(true);
    setVoidError(null);
    try {
      const result = await voidPayment(voidTarget.id, voidTarget.method, voidReason, null);
      void sendManagerNotification({
        actionKind: 'payment_voided',
        amountPence: result.amountPence,
        reason: voidReason.trim(),
        patientId: patient?.id ?? null,
        visitId: visit?.id ?? null,
        staffAccountId: currentAccount?.account_id ?? null,
      });
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

  // Charge amount — single source of truth for how much this leg of
  // the bill will take. Held as text so a half-typed value like
  // "20." doesn't snap back while the operator is typing. Empty
  // string means "full outstanding" — the most common path, and the
  // one that maps to the previous Pay-in-full default.
  //
  // The previous shape used a Pay-in-full / Split mode toggle plus a
  // separate splitAmountText state. That created an unnecessary
  // mental model swap (mode pick → amount pick) when the user
  // really just answers one question: "how much to take on this
  // method?" Collapsing both pieces of state into one matches
  // Stripe Terminal / Square / Toast and removes a fork in the UI.
  const [chargeAmountText, setChargeAmountText] = useState('');
  const chargeAmountPence = ((): number => {
    const trimmed = chargeAmountText.trim();
    if (trimmed === '') return outstandingPence;
    const n = Number(trimmed.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100), outstandingPence);
  })();
  // Whether this charge will clear the bill in one shot. Used to
  // pick the post-charge stage transition (success vs back to
  // choose for the next leg).
  const willClearBill = chargeAmountPence > 0 && chargeAmountPence >= outstandingPence;
  // True when the operator has explicitly set this leg below the
  // outstanding total — drives the "Still due after this method"
  // line and labels the partial state in the audit cash note.
  const isPartialPayment = chargeAmountPence > 0 && chargeAmountPence < outstandingPence;
  // Variable kept around for receipt copy (the "£X paid" headline).
  const total = chargeAmountPence;
  // The success-stage headline must report what the receipted payment
  // actually collected, read back from the captured payment row — not
  // the live chargeAmountPence. On a success stage restored from the
  // URL (refresh / back), chargeAmountPence has drifted to the current
  // outstanding and would mislabel the amount. Fall back to `total`
  // for the brief window before cartPayments has loaded the row.
  const receiptedPaymentPence =
    succeededPayments.find((p) => p.id === paymentId)?.amount_pence ?? total;

  // Keep ?stage=success&payment=<id> in the URL whenever we're on
  // the success stage. Clear it on any other stage. `replace: true`
  // so this doesn't pollute browser history with one entry per
  // micro-transition — refresh / back behave like a normal page.
  useEffect(() => {
    const want =
      stage === 'success' && paymentId
        ? { stage: 'success', payment: paymentId }
        : null;
    const haveStage = searchParams.get('stage');
    const havePayment = searchParams.get('payment');
    if (want) {
      if (haveStage !== want.stage || havePayment !== want.payment) {
        const next = new URLSearchParams(searchParams);
        next.set('stage', want.stage);
        next.set('payment', want.payment);
        setSearchParams(next, { replace: true });
      }
    } else if (haveStage || havePayment) {
      const next = new URLSearchParams(searchParams);
      next.delete('stage');
      next.delete('payment');
      setSearchParams(next, { replace: true });
    }
  }, [stage, paymentId, searchParams, setSearchParams]);

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
      const splitBit = isPartialPayment
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
        tookPaymentThisSessionRef.current = true;
        setStage('success');
      } else {
        setTendered('');
        // Clear the typed charge amount so the next leg defaults to
        // the new (smaller) outstanding. Staff can still type a
        // partial again from the choose stage if they want to break
        // the remainder up further.
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
          {fromQuickSale && patient?.email === COUNTER_SALE_EMAIL
            ? 'Walk-up sale'
            : patient
              ? patientFullName(patient)
              : fromQuickSale
                ? 'Retail sale'
                : 'Appointment'}{' '}
          · {formatPence(outstandingPence)}
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
        {(() => {
          // Per-source breakdown with refund netting. Each money
          // source gets ONE chip showing its NET-of-refunds value,
          // plus a sub-line below the chips listing the gross +
          // refund detail when a refund exists. Matches the cart
          // Totals card's per-source pattern so both surfaces tell
          // the same story.
          //
          // Sources:
          //   • Deposit / Paid-in-full (Stripe at booking)
          //   • Till (Klarna / cash / card terminal lng_payments)
          //   • Shopify pre-paid online order
          //
          // Gross till is back-calculated from amountPaidPence (the
          // canonical net-of-everything number from
          // lng_visit_paid_status) plus the refunds we just queried.
          // See refundedAgainstDepositPence / refundedAgainstTillPence
          // above.
          // Gross till = (net amount paid) + (all refunds) - (gross
          // deposit). Back-calculated from the canonical
          // lng_visit_paid_status view so the till and deposit chips
          // always sum to amount_paid_pence + refunds_total, which
          // is the true gross money-in for the visit.
          const tillGrossPence = Math.max(
            0,
            amountPaidPence +
              refundedAgainstDepositPence +
              refundedAgainstTillPence -
              depositPence,
          );
          const depositNetPence = Math.max(0, depositPence - refundedAgainstDepositPence);
          const tillNetPence = Math.max(0, tillGrossPence - refundedAgainstTillPence);
          const refundedAwayCopy = patientFirstName
            ? `refunded back to ${patientFirstName}`
            : 'refunded back to patient';
          const hasAnyChip =
            cartDiscount > 0 ||
            depositPence > 0 ||
            tillGrossPence > 0;
          if (!hasAnyChip) return null;

          return (
            <div
              style={{
                margin: `0 0 ${theme.space[3]}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[1],
              }}
            >
              <p
                style={{
                  margin: 0,
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
                      {deposit?.paidInFullAtBooking ? 'Paid in full' : 'Deposit'} −{formatPence(depositNetPence)}
                    </span>
                    <span style={{ color: theme.color.inkSubtle }}>
                      {' '}
                      ({formatDepositSourceSuffix(deposit)})
                    </span>
                  </>
                ) : null}
                {tillGrossPence > 0 ? (
                  <>
                    <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
                    <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
                      Collected −{formatPence(tillNetPence)}
                    </span>
                  </>
                ) : null}
              </p>
              {/* Audit sub-lines — only render when there's a refund
                  to disclose. Without these, the chip above looks
                  like a simple "we already collected £X" credit even
                  when the patient was refunded the lot. */}
              {depositPence > 0 && refundedAgainstDepositPence > 0 ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkSubtle,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {deposit?.paidInFullAtBooking ? 'Paid in full' : 'Deposit'}: {formatPence(depositPence)} paid ·{' '}
                  <strong style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
                    {formatPence(refundedAgainstDepositPence)} {refundedAwayCopy}
                  </strong>
                </p>
              ) : null}
              {tillGrossPence > 0 && refundedAgainstTillPence > 0 ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkSubtle,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  Collected at till: {formatPence(tillGrossPence)} paid ·{' '}
                  <strong style={{ color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
                    {formatPence(refundedAgainstTillPence)} {refundedAwayCopy}
                  </strong>
                </p>
              ) : null}
            </div>
          );
        })()}
        <p style={{ margin: `0 0 ${theme.space[6]}px`, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
          {stage === 'choose' &&
            (succeededPayments.length > 0
              ? 'Take the rest of the payment, or void a leg above to start over.'
              : 'Set how much to charge on this method, then pick how to take it.')}
          {stage === 'cash' && 'Tap what the customer hands you. Change is calculated for you.'}
          {stage === 'card' && 'Card terminal flow ships in slice 8.'}
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

            <ChargeAmountControl
              outstandingPence={outstandingPence}
              chargeAmountText={chargeAmountText}
              onChange={setChargeAmountText}
            />

            {/* Method picker. Each card's label reflects the live
                chargeAmountPence so the operator can see in plain
                text exactly what the next tap will charge. Cards
                are disabled if the operator has zeroed the amount
                so an accidental tap can't push something unexpected
                through. "Over the phone" sets the MOTO flag server
                side; every other method never does. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <MethodCard
                icon={<CreditCard size={20} />}
                title="Card"
                description={
                  !reader
                    ? 'No reader registered yet'
                    : `Charge ${formatPence(chargeAmountPence)} on ${reader.friendly_name}`
                }
                onClick={() => openTerminal('standard')}
                disabled={!reader || chargeAmountPence <= 0}
              />
              <MethodCard
                icon={<Phone size={20} />}
                title="Over the phone"
                description={`Key a card to charge ${formatPence(chargeAmountPence)} while the patient is on the phone`}
                onClick={() => setMotoOpen(true)}
                disabled={chargeAmountPence <= 0}
              />
              <MethodCard
                icon={<Banknote size={20} />}
                title="Cash"
                description={`Take ${formatPence(chargeAmountPence)} in cash, change calculated for you`}
                onClick={() => setStage('cash')}
                disabled={chargeAmountPence <= 0}
              />
              {/* Klarna and Clearpay sit as peers to Card and Cash
                  on the picker. Less drilling — staff picks the exact
                  provider in one tap instead of going via a generic
                  "Buy now, pay later" intermediate sheet. Offered on
                  every payment surface, including retail Quick Sale. */}
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Klarna"
                description={`Show ${formatPence(chargeAmountPence)} QR on this tablet. Customer pays in Klarna app.`}
                onClick={() => openBnpl('klarna')}
                disabled={chargeAmountPence <= 0}
              />
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Clearpay"
                description={
                  !reader
                    ? 'Needs a registered card reader. Customer taps phone on the reader.'
                    : `Charge ${formatPence(chargeAmountPence)} via Clearpay. Customer taps phone on ${reader.friendly_name}.`
                }
                onClick={() => openBnpl('clearpay')}
                disabled={!reader || chargeAmountPence <= 0}
              />
            </div>
          </div>
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
            <CustomTenderDisclosure
              chargeAmountPence={chargeAmountPence}
              tendered={tendered}
              onSelect={setTendered}
            />
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
              {formatPence(receiptedPaymentPence)} paid
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted }}>
              Receipt channel:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <ReceiptOption
                value="email"
                label="Email"
                hint="Sent from clinic@notifications.venneir.com, using the patient's email on file or one you enter below."
                selected={receiptChannel === 'email'}
                onClick={() => setReceiptChannel('email')}
              />
              <ReceiptOption
                value="sms"
                label="SMS"
                hint="Texted from Venneir, using the patient's number on file or one you enter below."
                selected={receiptChannel === 'sms'}
                onClick={() => setReceiptChannel('sms')}
              />
              <ReceiptOption
                value="none"
                label="No receipt"
                hint="Skip the receipt. The payment is still recorded on the visit."
                selected={receiptChannel === 'none'}
                onClick={() => setReceiptChannel('none')}
              />
            </div>

            {receiptChannel !== 'none' ? (
              <div style={{ marginTop: theme.space[4] }}>
                <Input
                  label={receiptChannel === 'email' ? 'Email address' : 'Phone number'}
                  placeholder={
                    receiptChannel === 'email'
                      ? // The anonymous Counter Sale patient holds a
                        // non-deliverable internal email; never prefill it.
                        (patient?.email && patient.email !== COUNTER_SALE_EMAIL
                          ? patient.email
                          : 'name@example.com')
                      : (patient?.phone ?? '+44...')
                  }
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
                tookPaymentThisSessionRef.current = true;
                setStage('success');
              } else {
                setChargeAmountText('');
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
                  tookPaymentThisSessionRef.current = true;
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
              tookPaymentThisSessionRef.current = true;
              setStage('success');
            } else {
              setChargeAmountText('');
              setStage('choose');
            }
          }}
        />
      ) : null}

      {/* MOTO (over the phone) modal. Rendered outside the reader
          guard because a card-not-present charge needs no S700; cart
          is still required for the visit linkage. */}
      {cart ? (
        <MotoPaymentModal
          open={motoOpen}
          onClose={() => setMotoOpen(false)}
          visitId={visit?.id ?? ''}
          amountPence={chargeAmountPence}
          onSucceeded={(pid) => {
            setPaymentId(pid);
            setMotoOpen(false);
            refreshPaid();
            if (willClearBill) {
              tookPaymentThisSessionRef.current = true;
              setStage('success');
            } else {
              setChargeAmountText('');
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

      {/* Void payment sheet. Required reason. Manager approval is
          asynchronous: the configured managers (Admin → Emails →
          Manager notifications) get an emailed record after the
          void succeeds. */}
      <BottomSheet
        open={voidOpen}
        onClose={() => !voidBusy && setVoidOpen(false)}
        dismissable={!voidBusy}
        title={voidTarget ? `Void ${formatPence(voidTarget.amount_pence)} payment` : 'Void payment'}
        description="The configured managers will be notified by email about this void."
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
          <ManagerNotificationNotice />
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
    // Entered from the retail Quick Sale flow: this is a sale, not a
    // clinical appointment, so the chain reads Quick sale › Sale › Take
    // payment with the middle crumb popping back to the sale receipt.
    if (e.from === 'quick_sale' && visitId) {
      return [
        { label: 'Quick sale', onClick: () => navigate('/quick-sale') },
        { label: 'Sale', onClick: () => navigate(`/sale/${visitId}`) },
        { label: 'Take payment' },
      ];
    }
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

// ChargeAmountControl — single, always-visible amount control for
// the choose-payment stage.
//
// Replaces the previous Pay-in-full / Split mode toggle plus
// SplitAmountPanel pair: the cashier no longer has to make a mode
// decision before thinking about the amount. There's one input
// pre-filled with the full outstanding; two quick chips below fill
// it with the full amount or half; and a "Still due after this
// method" row only appears when the typed amount is less than the
// outstanding. The method cards below this control re-label live
// to reflect chargeAmountPence so the next tap reads exactly what
// it will charge.
//
// Storage shape lives in the parent (chargeAmountText). Empty
// string == "use the full outstanding" — the most common path.
// That keeps the input from looking pre-touched on first paint
// and lets the parent default cleanly after a successful leg.
function ChargeAmountControl({
  outstandingPence,
  chargeAmountText,
  onChange,
}: {
  outstandingPence: number;
  chargeAmountText: string;
  onChange: (next: string) => void;
}) {
  // Parse the typed text into pence the same way the parent does
  // so the control's UI state (chip selected / still-due figure)
  // stays in lockstep with what the method cards will actually
  // charge.
  const trimmed = chargeAmountText.trim();
  const parsedPence = ((): number => {
    if (trimmed === '') return outstandingPence;
    const n = Number(trimmed.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n * 100), outstandingPence);
  })();
  const isFullSelected = trimmed === '' || parsedPence === outstandingPence;
  const halfPence = Math.round(outstandingPence / 2);
  const halfSelectable = halfPence >= 100 && halfPence < outstandingPence;
  const isHalfSelected = !isFullSelected && parsedPence === halfPence;
  const remainingPence = Math.max(0, outstandingPence - parsedPence);
  const showStillDue = parsedPence > 0 && parsedPence < outstandingPence;
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
          Charge on this method
        </h3>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          The full amount is set for you. Type a smaller number to take part of the bill now and
          finish the rest on a different method.
        </p>
      </div>
      <Input
        label="Amount (£)"
        numericFormat="currency"
        placeholder={(outstandingPence / 100).toFixed(2)}
        // Mirror the actual state — no forced fill. The previous
        // version painted the formatted outstanding into the box
        // whenever the typed text was empty, which made backspacing
        // visually "snap back" to the full amount: deleting the last
        // digit cleared chargeAmountText to '' and the value prop
        // immediately re-displayed the outstanding. The cashier
        // could not see "0" or an empty field to re-type from. The
        // placeholder now does the default-amount affordance, and
        // the value reflects only what's been typed.
        value={chargeAmountText}
        onChange={(e) => {
          // Treat the placeholder-equivalent value as "leave on
          // full" — clearing the input or typing the full amount
          // both map to the same canonical empty string so the
          // parent's chargeAmountPence stays at the outstanding.
          onChange(e.target.value);
        }}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: halfSelectable ? '1fr 1fr' : '1fr',
          gap: theme.space[2],
        }}
      >
        <ChargeChip
          selected={isFullSelected}
          label={`Full · ${formatPence(outstandingPence)}`}
          onClick={() => onChange('')}
        />
        {halfSelectable ? (
          <ChargeChip
            selected={isHalfSelected}
            label={`Half · ${formatPence(halfPence)}`}
            onClick={() => onChange((halfPence / 100).toFixed(2))}
          />
        ) : null}
      </div>
      {showStillDue ? (
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
            Still due after this method
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
      ) : null}
    </div>
  );
}

// Single chip used by ChargeAmountControl. Selected state mirrors
// the parent's parsed amount so the chip and the input agree at all
// times — tapping a chip simply pushes its value back through the
// shared onChange.
function ChargeChip({
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
      onClick={onClick}
      aria-pressed={selected}
      style={{
        appearance: 'none',
        border: `1.5px solid ${selected ? theme.color.ink : theme.color.border}`,
        background: selected ? 'rgba(14, 20, 20, 0.04)' : theme.color.bg,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
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
      {label}
    </button>
  );
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

// CustomTenderDisclosure — collapsed-by-default link that opens an
// inline numeric input for the rare case when the customer hands
// over a non-preset amount (e.g. a £100 note for a £45 bill).
//
// The quick-amount chip grid above already covers the four common
// denominations the algorithm derives from the charge (exact + the
// three next round-up steps). Most cash transactions end on a chip
// tap, so the input shouldn't sit visible at all — its presence
// just made every customer look like a "type the number" task.
// Hide it; reveal it only when staff explicitly asks for it.
//
// While open, the input lives inline with a calm change-due line
// next to it so the operator sees the same chip-style annotation
// they'd get from the preset cards. Closing the disclosure clears
// the tendered amount so a stale figure can't sneak into submit.
function CustomTenderDisclosure({
  chargeAmountPence,
  tendered,
  onSelect,
}: {
  chargeAmountPence: number;
  tendered: string;
  onSelect: (value: string) => void;
}) {
  // The disclosure stays open whenever the tendered amount doesn't
  // match any of the chip presets — that way refreshing the page
  // mid-typing or returning to the cash screen with a stored typed
  // amount doesn't silently hide the input. Pre-set values from
  // chips don't keep the disclosure open.
  const tenderedPence = Math.round(Number(tendered.replace(/[^\d.]/g, '')) * 100);
  const chipPences = new Set(quickAmounts(chargeAmountPence).map((c) => c.pence));
  const looksLikeChip = chipPences.has(tenderedPence);
  const hasTendered = tendered.trim() !== '';
  const [open, setOpen] = useState<boolean>(hasTendered && !looksLikeChip);
  const change = hasTendered && Number.isFinite(tenderedPence)
    ? tenderedPence - chargeAmountPence
    : null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          appearance: 'none',
          border: `1px dashed ${theme.color.border}`,
          background: 'transparent',
          borderRadius: theme.radius.input,
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          marginTop: theme.space[4],
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkMuted,
          cursor: 'pointer',
          alignSelf: 'flex-start',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = theme.color.ink;
          e.currentTarget.style.color = theme.color.ink;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = theme.color.border;
          e.currentTarget.style.color = theme.color.inkMuted;
        }}
      >
        + Enter a different amount
      </button>
    );
  }
  return (
    <div
      style={{
        marginTop: theme.space[4],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        padding: theme.space[4],
        background: theme.color.bg,
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <Input
        label="Amount handed over (£)"
        numericFormat="currency"
        placeholder={`min ${(chargeAmountPence / 100).toFixed(2)}`}
        value={tendered}
        onChange={(e) => onSelect(e.target.value)}
        autoFocus
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {change === null
            ? 'Type the amount the customer handed over'
            : change < 0
              ? 'Short of the amount due'
              : change === 0
                ? 'Exact, no change to give'
                : 'Change to give back'}
        </span>
        <span
          style={{
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: change !== null && change < 0 ? theme.color.alert : theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {change === null
            ? '—'
            : change < 0
              ? `${formatPence(Math.abs(change))} short`
              : formatPence(change)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          onSelect('');
          setOpen(false);
        }}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          cursor: 'pointer',
          alignSelf: 'flex-start',
        }}
      >
        Use a preset instead
      </button>
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
