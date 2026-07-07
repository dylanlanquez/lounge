import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { CreditCard, Mail, Plus, RotateCcw, ShoppingBag, Trash2, UserRound } from 'lucide-react';
import {
  Avatar,
  Button,
  Card,
  ContinuousTimeline,
  EmptyState,
  Skeleton,
  StatusPill,
  Toast,
  type StatusTone,
} from '../components/index.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { CataloguePicker } from '../components/CataloguePicker/CataloguePicker.tsx';
import { RefundSheet } from '../components/RefundSheet/RefundSheet.tsx';
import { SendReceiptSheet } from '../components/SendReceiptSheet/SendReceiptSheet.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { endVisitEarly, useVisitDetail } from '../lib/queries/visits.ts';
import {
  useCart,
  formatPence,
  computeCartSubtotal,
  removeCartLine,
  updateCartItemQuantity,
} from '../lib/queries/carts.ts';
import {
  useCartPayments,
  useVisitPaidStatus,
  type CartPaymentRow,
} from '../lib/queries/payments.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { COUNTER_SALE_EMAIL, patientFullName, type PatientRow } from '../lib/queries/patients.ts';

// SaleDetail — the read view for a completed retail Quick Sale. It is a
// point-of-sale receipt, NOT a clinical visit: customer (or walk-up),
// the products, what was paid and how, and refund / receipt actions.
// /visit/:id redirects here for retail sales so no clinical chrome ever
// mounts. The visit id is the route param (retail sales reuse the
// visit/cart/payment substrate under the hood).

// Button label + leading icon need their own gap: the Button component
// wraps all children in a single span, so the leading icon must sit in
// an inline-flex wrapper to space off the label (matches every other
// icon button in the app, e.g. "Add tech note", "Print LWO").
const btnInner = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: theme.space[2],
} as const;

// Compact, retail-friendly payment-method copy.
function methodLabel(method: CartPaymentRow['method']): string {
  switch (method) {
    case 'cash':
      return 'cash';
    case 'card_terminal':
      return 'card';
    case 'gift_card':
      return 'gift card';
    case 'account_credit':
      return 'account credit';
    default:
      return 'card';
  }
}

function methodSummary(payments: CartPaymentRow[]): string {
  if (payments.length === 0) return '';
  if (payments.length === 1) return `Paid by ${methodLabel(payments[0]!.method)}`;
  const methods = Array.from(new Set(payments.map((p) => methodLabel(p.method))));
  return `Paid by ${methods.join(' + ')}`;
}

function formatSaleDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatSaleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function SaleDetail() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const { visit, patient, loading: visitLoading } = useVisitDetail(id);
  const { cart, items, loading: cartLoading, refresh: refreshCart } = useCart(id);
  const { data: payments } = useCartPayments(cart?.id ?? null);
  const { data: paidStatus, refresh: refreshPaid } = useVisitPaidStatus(id);
  const { account: currentAccount } = useCurrentAccount();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);

  const [refundOpen, setRefundOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const loading = visitLoading || cartLoading;

  const succeededPayments = (payments ?? []).filter((p) => p.status === 'succeeded');
  // Derive the total from the live (non-removed) lines so it tracks edits
  // immediately, rather than the cart's stored total which lags a soft
  // delete until the subtotal trigger fires.
  const totalPence = computeCartSubtotal(items, cart?.discount_pence ?? 0);
  const amountPaidPence = paidStatus?.amount_paid_pence ?? 0;
  const paidState = paidStatus?.paid_status ?? null;
  // Only 'paid' is fully settled. 'owed' is overpaid (refund due),
  // 'partially_paid'/'free_visit'/null is not a completed sale.
  const isPaid = paidState === 'paid';
  // A written-off sale had its remaining balance forgiven: the money
  // already collected stays real, but nothing further is owed. It is
  // settled for workflow purposes, so we never prompt to take payment
  // and never surface an outstanding balance.
  const isWrittenOff = paidState === 'written_off';
  const isSettled = isPaid || isWrittenOff;
  const outstandingPence = Math.max(0, totalPence - amountPaidPence);
  const hasPayments = amountPaidPence > 0;

  // The Counter Sale system patient is an anonymous walk-up; never show
  // its name or its sentinel email/phone (a receipt must never go to the
  // internal address).
  const isWalkUp = !patient || patient.email === COUNTER_SALE_EMAIL;
  const customerName = isWalkUp ? 'Walk-up sale' : patientFullName(patient as PatientRow);
  const receiptEmail = isWalkUp ? null : patient?.email ?? null;
  const receiptPhone = isWalkUp ? null : patient?.phone ?? null;

  const saleAt =
    succeededPayments[0]?.succeeded_at ?? cart?.closed_at ?? visit?.closed_at ?? visit?.opened_at ?? null;

  const status: { tone: StatusTone; label: string } = isWrittenOff
    ? { tone: 'pending', label: 'Written off' }
    : isPaid
      ? { tone: 'complete', label: 'Paid in full' }
      : hasPayments
        ? { tone: 'pending', label: `Part paid · ${formatPence(outstandingPence)} due` }
        : { tone: 'neutral', label: 'Draft' };

  // Discard an open, unpaid sale (rang up but never paid). endVisitEarly
  // soft-deletes the cart lines and flips the visit to 'ended_early', so
  // it drops out of the Ledger's completed sales rather than lingering.
  const onDiscard = async () => {
    if (!visit || !patient) return;
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await endVisitEarly({
        patient_id: patient.id,
        visit_id: visit.id,
        reason: 'other',
        note: 'Retail sale discarded before payment',
      });
      navigate('/quick-sale');
    } catch (e: unknown) {
      setDiscardError(e instanceof Error ? e.message : 'Could not discard the sale.');
      setDiscardBusy(false);
    }
  };

  // While the sale is an unpaid draft (open visit, nothing collected) the
  // basket is editable — add more products, change a quantity, or remove
  // a line. Once any payment lands or the visit is finalised, the lines
  // are frozen (refund instead). Reuses the clinical visit page's cart
  // helpers.
  const editable = !!cart && !loading && !hasPayments && visit?.status === 'arrived';
  const incLine = async (lineId: string, qty: number) => {
    setBusyItem(lineId);
    try {
      await updateCartItemQuantity(lineId, qty + 1);
      refreshCart();
      refreshPaid();
    } finally {
      setBusyItem(null);
    }
  };
  const decLine = async (lineId: string, qty: number) => {
    setBusyItem(lineId);
    try {
      if (qty > 1) await updateCartItemQuantity(lineId, qty - 1);
      else await removeCartLine({ itemId: lineId, reason: 'mistake' });
      refreshCart();
      refreshPaid();
    } finally {
      setBusyItem(null);
    }
  };
  const removeLine = async (lineId: string) => {
    setBusyItem(lineId);
    try {
      await removeCartLine({ itemId: lineId, reason: 'mistake' });
      refreshCart();
      refreshPaid();
    } finally {
      setBusyItem(null);
    }
  };

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
        <TopBar variant="subpage" backTo="/ledger" />

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <Skeleton height={150} radius={18} />
            <Skeleton height={220} radius={18} />
          </div>
        ) : !visit || !cart ? (
          <EmptyState
            icon={<ShoppingBag size={26} />}
            title="Sale not found"
            description="That sale no longer exists or you do not have access."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            {/* Hero — who, what, when, and the headline total. */}
            <Card padding="none" elevation="raised" style={{ overflow: 'hidden' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[4],
                  padding: isMobile ? theme.space[5] : theme.space[6],
                }}
              >
                {isWalkUp ? (
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: isMobile ? 48 : 56,
                      height: isMobile ? 48 : 56,
                      borderRadius: theme.radius.pill,
                      background: theme.color.accentBg,
                      color: theme.color.accent,
                      flexShrink: 0,
                    }}
                  >
                    <ShoppingBag size={26} />
                  </span>
                ) : (
                  <Avatar
                    name={customerName}
                    src={(patient as { avatar_data?: string | null } | null)?.avatar_data ?? null}
                    size={isMobile ? 'md' : 'lg'}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1
                    style={{
                      margin: 0,
                      fontSize: isMobile ? theme.type.size.lg : theme.type.size.xl,
                      fontWeight: theme.type.weight.semibold,
                      letterSpacing: theme.type.tracking.tight,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {customerName}
                  </h1>
                  <p
                    style={{
                      margin: `2px 0 0`,
                      fontSize: theme.type.size.sm,
                      color: theme.color.inkMuted,
                    }}
                  >
                    Retail sale
                  </p>
                </div>
                <StatusPill tone={status.tone}>{status.label}</StatusPill>
              </div>

              {/* Ribbon — total + when, tinted by paid state. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.space[3],
                  flexWrap: 'wrap',
                  padding: `${theme.space[4]}px ${isMobile ? theme.space[5] : theme.space[6]}px`,
                  background: isPaid ? theme.color.accentBg : theme.color.bg,
                  borderTop: `1px solid ${theme.color.border}`,
                }}
              >
                <span
                  style={{
                    fontSize: theme.type.size.xxl,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    letterSpacing: theme.type.tracking.tight,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatPence(totalPence)}
                </span>
                {saleAt ? (
                  <span style={{ textAlign: 'right' }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.medium,
                        color: theme.color.ink,
                      }}
                    >
                      {formatSaleDate(saleAt)}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: theme.type.size.sm,
                        color: theme.color.inkMuted,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {succeededPayments.length > 0 ? `${methodSummary(succeededPayments)} · ` : ''}
                      {formatSaleTime(saleAt)}
                    </span>
                  </span>
                ) : null}
              </div>
            </Card>

            {/* Items */}
            <Card padding="lg" elevation="raised">
              <h2
                style={{
                  margin: `0 0 ${theme.space[4]}px`,
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.semibold,
                  letterSpacing: theme.type.tracking.tight,
                  color: theme.color.ink,
                }}
              >
                Items
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
                {items.map((it) => (
                  <CartLineItem
                    key={it.id}
                    name={it.name}
                    description={it.description}
                    quantity={it.quantity}
                    quantityEnabled={it.quantity_enabled}
                    unitPricePence={it.unit_price_pence}
                    lineTotalPence={it.line_total_pence}
                    thumbnailUrl={it.image_url}
                    disabled={busyItem === it.id}
                    onIncrement={() => incLine(it.id, it.quantity)}
                    onDecrement={() => decLine(it.id, it.quantity)}
                    onRemove={() => removeLine(it.id)}
                    readOnly={!editable}
                  />
                ))}
              </div>
              {editable ? (
                <div style={{ marginTop: theme.space[4] }}>
                  <Button variant="secondary" onClick={() => setPickerOpen(true)}>
                    <span style={btnInner}>
                      <Plus size={18} aria-hidden />
                      Add products
                    </span>
                  </Button>
                </div>
              ) : null}
              <div
                style={{
                  marginTop: theme.space[5],
                  paddingTop: theme.space[4],
                  borderTop: `1px solid ${theme.color.border}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.space[2],
                }}
              >
                <SummaryRow label="Subtotal" valuePence={totalPence} />
                {hasPayments ? (
                  <SummaryRow label="Paid" valuePence={-amountPaidPence} accent />
                ) : null}
                {outstandingPence > 0 && !isWrittenOff ? (
                  <SummaryRow label="Outstanding" valuePence={outstandingPence} emphasis />
                ) : null}
              </div>
            </Card>

            {/* Actions */}
            <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap' }}>
              {/* A walk-up sale has no real customer record; only offer
                  the profile link when a customer is attached. */}
              {!isWalkUp && patient ? (
                <Button variant="secondary" onClick={() => navigate(`/patient/${patient.id}`)}>
                  <span style={btnInner}>
                    <UserRound size={16} aria-hidden />
                    View profile
                  </span>
                </Button>
              ) : null}

              {isSettled ? (
                <>
                  <Button variant="secondary" onClick={() => setReceiptOpen(true)}>
                    <span style={btnInner}>
                      <Mail size={16} aria-hidden />
                      Send receipt
                    </span>
                  </Button>
                  <Button variant="secondary" onClick={() => setRefundOpen(true)}>
                    <span style={btnInner}>
                      <RotateCcw size={16} aria-hidden />
                      Refund
                    </span>
                  </Button>
                  <Button variant="primary" onClick={() => navigate('/quick-sale')} showArrow>
                    <span style={btnInner}>
                      <Plus size={16} aria-hidden />
                      New sale
                    </span>
                  </Button>
                </>
              ) : (
                <>
                  {/* Open sale — resume payment, or discard it (only while
                      nothing has been collected). */}
                  {!hasPayments ? (
                    <Button variant="secondary" onClick={onDiscard} loading={discardBusy}>
                      <span style={btnInner}>
                        <Trash2 size={16} aria-hidden />
                        Discard sale
                      </span>
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    showArrow
                    onClick={() =>
                      navigate(`/visit/${visit.id}/pay`, { state: { from: 'quick_sale' } })
                    }
                  >
                    <span style={btnInner}>
                      <CreditCard size={16} aria-hidden />
                      Take payment
                    </span>
                  </Button>
                </>
              )}
            </div>

            <ContinuousTimeline appointmentId={null} visitId={visit.id} />
          </div>
        )}
      </div>

      <RefundSheet
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        cartId={cart?.id ?? null}
        appointmentId={null}
        suggestedPence={amountPaidPence}
        patientId={patient?.id ?? null}
        visitId={visit?.id ?? null}
        staffAccountId={currentAccount?.account_id ?? null}
        onCompleted={refreshPaid}
      />
      <SendReceiptSheet
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        paymentId={succeededPayments[0]?.id ?? null}
        patientEmail={receiptEmail}
        patientPhone={receiptPhone}
      />

      {cart ? (
        <CataloguePicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          productsOnly
          cartId={cart.id}
          cartCatalogueIds={items
            .map((it) => it.catalogue_id)
            .filter((cid): cid is string => cid != null)}
          onItemAdded={() => {
            refreshCart();
            refreshPaid();
          }}
        />
      ) : null}

      {discardError ? (
        <div
          style={{
            position: 'fixed',
            bottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${theme.space[4]}px + env(safe-area-inset-bottom, 0px))`,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1100,
          }}
        >
          <Toast
            tone="error"
            title="Could not discard the sale"
            description={discardError}
            duration={6000}
            onDismiss={() => setDiscardError(null)}
          />
        </div>
      ) : null}
    </main>
  );
}

function SummaryRow({
  label,
  valuePence,
  accent = false,
  emphasis = false,
}: {
  label: string;
  valuePence: number;
  accent?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.space[3] }}>
      <span
        style={{
          fontSize: emphasis ? theme.type.size.base : theme.type.size.sm,
          fontWeight: emphasis ? theme.type.weight.semibold : theme.type.weight.medium,
          color: emphasis ? theme.color.ink : theme.color.inkMuted,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: emphasis ? theme.type.size.md : theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: accent ? theme.color.accent : theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {valuePence < 0 ? `-${formatPence(-valuePence)}` : formatPence(valuePence)}
      </span>
    </div>
  );
}
