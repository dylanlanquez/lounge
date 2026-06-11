import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, Receipt, RotateCcw, ShoppingBag } from 'lucide-react';
import {
  Avatar,
  Button,
  Card,
  ContinuousTimeline,
  EmptyState,
  Skeleton,
  StatusPill,
  type StatusTone,
} from '../components/index.ts';
import { CartLineItem } from '../components/CartLineItem/CartLineItem.tsx';
import { RefundSheet } from '../components/RefundSheet/RefundSheet.tsx';
import { SendReceiptSheet } from '../components/SendReceiptSheet/SendReceiptSheet.tsx';
import { TopBar } from '../components/TopBar/TopBar.tsx';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { useVisitDetail } from '../lib/queries/visits.ts';
import { useCart, formatPence } from '../lib/queries/carts.ts';
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
  const { cart, items, loading: cartLoading } = useCart(id);
  const { data: payments } = useCartPayments(cart?.id ?? null);
  const { data: paidStatus, refresh: refreshPaid } = useVisitPaidStatus(id);
  const { account: currentAccount } = useCurrentAccount();
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);

  const [refundOpen, setRefundOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const loading = visitLoading || cartLoading;

  const succeededPayments = (payments ?? []).filter((p) => p.status === 'succeeded');
  const totalPence = cart?.total_pence ?? 0;
  const amountPaidPence = paidStatus?.amount_paid_pence ?? 0;
  const paidState = paidStatus?.paid_status ?? null;
  const isPaid = paidState === 'paid' || paidState === 'owed';
  const outstandingPence = Math.max(0, totalPence - amountPaidPence);

  // The Counter Sale system patient is an anonymous walk-up; never show
  // its name or its sentinel email/phone (a receipt must never go to the
  // internal address).
  const isWalkUp = !patient || patient.email === COUNTER_SALE_EMAIL;
  const customerName = isWalkUp ? 'Walk-up sale' : patientFullName(patient as PatientRow);
  const receiptEmail = isWalkUp ? null : patient?.email ?? null;
  const receiptPhone = isWalkUp ? null : patient?.phone ?? null;

  const saleAt =
    succeededPayments[0]?.succeeded_at ?? cart?.closed_at ?? visit?.closed_at ?? visit?.opened_at ?? null;

  const status: { tone: StatusTone; label: string } = isPaid
    ? { tone: 'complete', label: 'Paid in full' }
    : paidState === 'partially_paid'
      ? { tone: 'pending', label: `Part paid · ${formatPence(outstandingPence)} due` }
      : { tone: 'pending', label: `${formatPence(outstandingPence)} due` };

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
                    onIncrement={() => {}}
                    onDecrement={() => {}}
                    onRemove={() => {}}
                    readOnly
                  />
                ))}
              </div>
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
                <SummaryRow
                  label={isPaid ? 'Paid' : 'Collected'}
                  valuePence={-amountPaidPence}
                  accent
                />
                {outstandingPence > 0 ? (
                  <SummaryRow label="Outstanding" valuePence={outstandingPence} emphasis />
                ) : null}
              </div>
            </Card>

            {/* Actions */}
            <div style={{ display: 'flex', gap: theme.space[3], flexWrap: 'wrap' }}>
              {amountPaidPence > 0 ? (
                <Button variant="secondary" onClick={() => setReceiptOpen(true)}>
                  <Receipt size={16} />
                  Send receipt
                </Button>
              ) : null}
              {amountPaidPence > 0 ? (
                <Button variant="secondary" onClick={() => setRefundOpen(true)}>
                  <RotateCcw size={16} />
                  Refund
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => navigate('/quick-sale')} showArrow>
                <Plus size={16} />
                New sale
              </Button>
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
