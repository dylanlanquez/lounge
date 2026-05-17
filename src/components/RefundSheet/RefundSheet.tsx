import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, Globe } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import {
  REFUND_REASON_CATEGORIES,
  approveAsManager,
  refundPartial,
  useRefundableSources,
  type RefundReasonCategory,
  type RefundableSourceRow,
} from '../../lib/queries/payments.ts';
import { formatPence } from '../../lib/queries/carts.ts';

// RefundSheet — staff-facing partial-refund flow.
//
// Layout
//
//   1. Suggested amount banner (when caller passes suggestedPence).
//      The owed-back banner on VisitDetail seeds this with the
//      overpaid figure so staff sees "We owe £X" prominently.
//   2. Payment list — every refundable lng_payments capture on the
//      cart, with method, taker, captured amount, already-refunded,
//      and the remaining refundable. Each row has an input where
//      staff types the amount to refund against THIS payment. The
//      sum across rows is the total refund.
//   3. Reason category dropdown + required free-text note.
//   4. Manager approval — email + password (approveAsManager flow,
//      same as the existing void path on Pay.tsx).
//
// Submit fires refundPartial once per row with a non-zero amount.
// Each call writes its own lng_payment_refunds row + patient_events
// 'refund_issued' entry. If any individual call fails the sheet
// surfaces the error but keeps the successes — the user can retry
// just the failed line without re-doing the whole flow.

export interface RefundSheetProps {
  open: boolean;
  onClose: () => void;
  cartId: string | null;
  /** Required to surface the appointment's widget-paid deposit as a
   *  refundable source. Pass null only for visits without a linked
   *  appointment (walk-ins) where deposit refunds are impossible. */
  appointmentId: string | null;
  /** Suggested total refund amount. The owed-back banner pre-fills
   *  this so the staff's typed allocations default to the obvious
   *  number (the amount the patient overpaid). Pass 0 / null when
   *  staff is refunding for a non-cart-edit reason. */
  suggestedPence?: number | null;
  /** Default category — VisitDetail's cart-edit banner passes
   *  'item_removed'; the visit-cancelled flow passes
   *  'visit_cancelled'; etc. Staff can still change it. */
  defaultCategory?: RefundReasonCategory;
  onCompleted?: () => void;
}

export function RefundSheet({
  open,
  onClose,
  cartId,
  appointmentId,
  suggestedPence = null,
  defaultCategory = 'item_removed',
  onCompleted,
}: RefundSheetProps) {
  const { data: sources, loading: paymentsLoading, error: paymentsError, refresh } =
    useRefundableSources({ cartId, appointmentId });

  // Per-source refund amount staff has typed. Keyed by source id
  // (payment id or appointment id). Stored as text so half-typed
  // entries like "12." are preserved; parsed to pence on submit.
  const [amountsBySource, setAmountsBySource] = useState<Record<string, string>>({});
  const [reasonCategory, setReasonCategory] =
    useState<RefundReasonCategory>(defaultCategory);
  const [reasonNote, setReasonNote] = useState('');
  const [approverEmail, setApproverEmail] = useState('');
  const [approverPassword, setApproverPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [perRowErrors, setPerRowErrors] = useState<Record<string, string>>({});
  const [completedCount, setCompletedCount] = useState(0);

  // Reset state every time the sheet opens — staff shouldn't see a
  // half-filled allocation from a prior open.
  useEffect(() => {
    if (!open) return;
    setAmountsBySource({});
    setReasonCategory(defaultCategory);
    setReasonNote('');
    setApproverEmail('');
    setApproverPassword('');
    setSubmitError(null);
    setPerRowErrors({});
    setCompletedCount(0);
  }, [open, defaultCategory]);

  // Seed the suggested amount across the sources in display order
  // (deposit first, then till payments). Staff can edit any row;
  // this is just a starting point.
  useEffect(() => {
    if (!open || paymentsLoading) return;
    if (!suggestedPence || suggestedPence <= 0) return;
    if (Object.keys(amountsBySource).length > 0) return;
    let remaining = suggestedPence;
    const seeded: Record<string, string> = {};
    for (const s of sources) {
      if (remaining <= 0) break;
      const allocate = Math.min(s.refundable_pence, remaining);
      if (allocate > 0) {
        seeded[s.id] = (allocate / 100).toFixed(2);
        remaining -= allocate;
      }
    }
    if (Object.keys(seeded).length > 0) {
      setAmountsBySource(seeded);
    }
  }, [open, paymentsLoading, sources, suggestedPence, amountsBySource]);

  const parsedAllocations = useMemo(() => {
    return sources.map((s) => {
      const text = amountsBySource[s.id] ?? '';
      const parsed = parsePoundsText(text);
      const pence = parsed == null ? 0 : Math.round(parsed * 100);
      return {
        source: s,
        text,
        pence,
        overLimit: pence > s.refundable_pence,
      };
    });
  }, [sources, amountsBySource]);

  const totalPence = parsedAllocations.reduce((acc, a) => acc + Math.max(0, a.pence), 0);
  const anyOverLimit = parsedAllocations.some((a) => a.overLimit);
  const noteOk = reasonNote.trim().length > 0;
  const canSubmit =
    !submitting &&
    totalPence > 0 &&
    !anyOverLimit &&
    noteOk &&
    approverEmail.trim().length > 0 &&
    approverPassword.length > 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setPerRowErrors({});
    try {
      const approverId = await approveAsManager(approverEmail.trim(), approverPassword);
      const errors: Record<string, string> = {};
      let succeeded = 0;
      for (const alloc of parsedAllocations) {
        if (alloc.pence <= 0) continue;
        try {
          if (alloc.source.kind === 'payment') {
            await refundPartial({
              paymentId: alloc.source.id,
              amountPence: alloc.pence,
              reasonCategory,
              reasonNote: reasonNote.trim(),
              approverAccountId: approverId,
            });
          } else {
            await refundPartial({
              depositAppointmentId: alloc.source.id,
              amountPence: alloc.pence,
              reasonCategory,
              reasonNote: reasonNote.trim(),
              approverAccountId: approverId,
            });
          }
          succeeded += 1;
          setAmountsBySource((prev) => {
            const next = { ...prev };
            delete next[alloc.source.id];
            return next;
          });
        } catch (e) {
          errors[alloc.source.id] = e instanceof Error ? e.message : String(e);
        }
      }
      refresh();
      setPerRowErrors(errors);
      setCompletedCount((c) => c + succeeded);
      if (Object.keys(errors).length === 0 && succeeded > 0) {
        // All allocations refunded cleanly — close the sheet and
        // let the parent re-pull the cart / paid status.
        if (onCompleted) onCompleted();
        onClose();
      } else if (succeeded === 0 && Object.keys(errors).length > 0) {
        // Nothing went through. Surface the first error at the top
        // alongside the per-row markers.
        setSubmitError(Object.values(errors)[0] ?? 'Refund failed');
      } else {
        // Partial success — keep the sheet open with the remaining
        // failed rows highlighted, but tell the parent to refresh.
        if (onCompleted) onCompleted();
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not authorise the refund');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Issue refund"
      description="Pick which payment(s) to refund against. Each line records its own audit row with the reason, manager sign-off, and the staff member who issued it."
      footer={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {totalPence > 0
              ? `Refunding ${formatPence(totalPence)}`
              : 'Allocate an amount to a payment'}
          </span>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
          >
            {submitting ? 'Refunding…' : `Refund ${formatPence(totalPence)}`}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        {suggestedPence && suggestedPence > 0 ? (
          <div
            style={{
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.input,
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.25)',
              color: '#991b1b',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
            }}
          >
            Patient is owed {formatPence(suggestedPence)}.{' '}
            <span style={{ fontWeight: theme.type.weight.medium }}>
              We&apos;ve pre-filled this amount across the refundable payment(s) below.
            </span>
          </div>
        ) : null}

        {paymentsError ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              background: 'rgba(220, 38, 38, 0.08)',
              color: '#991b1b',
              fontSize: theme.type.size.sm,
            }}
          >
            {paymentsError}
          </p>
        ) : null}

        {!paymentsError && paymentsLoading ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
            Loading payments…
          </p>
        ) : null}

        {!paymentsLoading && sources.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: theme.space[4],
              border: `1px dashed ${theme.color.border}`,
              borderRadius: theme.radius.input,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              textAlign: 'center',
            }}
          >
            No refundable payments yet. The Shopify-order credit (if any) is refunded on
            Shopify itself.
          </p>
        ) : null}

        {sources.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            {parsedAllocations.map(({ source, text, overLimit }) => (
              <SourceAllocationRow
                key={source.id}
                source={source}
                amountText={text}
                overLimit={overLimit}
                error={perRowErrors[source.id] ?? null}
                onChange={(value) =>
                  setAmountsBySource((prev) => ({ ...prev, [source.id]: value }))
                }
              />
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <label
            htmlFor="refund-reason-category"
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Reason
          </label>
          <select
            id="refund-reason-category"
            value={reasonCategory}
            onChange={(e) => setReasonCategory(e.target.value as RefundReasonCategory)}
            disabled={submitting}
            style={{
              padding: `${theme.space[3]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
            }}
          >
            {REFUND_REASON_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <label
            htmlFor="refund-reason-note"
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Specific reason
          </label>
          <textarea
            id="refund-reason-note"
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            disabled={submitting}
            placeholder="What item / why / what was the patient told"
            rows={3}
            style={{
              padding: `${theme.space[3]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              resize: 'vertical',
              minHeight: 72,
            }}
          />
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            Required. Logged verbatim to the patient timeline.
          </span>
        </div>

        <div
          style={{
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            background: 'rgba(8, 55, 88, 0.04)',
            border: `1px solid ${theme.color.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Manager approval
          </span>
          <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            A different staff member with manager rights signs off. Their credentials are
            checked but the session stays as yours.
          </span>
          <input
            type="email"
            value={approverEmail}
            onChange={(e) => setApproverEmail(e.target.value)}
            disabled={submitting}
            placeholder="Manager email"
            autoComplete="off"
            style={{
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
            }}
          />
          <input
            type="password"
            value={approverPassword}
            onChange={(e) => setApproverPassword(e.target.value)}
            disabled={submitting}
            placeholder="Manager password"
            autoComplete="off"
            style={{
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
            }}
          />
        </div>

        {submitError ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              background: 'rgba(220, 38, 38, 0.08)',
              border: '1px solid rgba(220, 38, 38, 0.25)',
              color: '#991b1b',
              fontSize: theme.type.size.sm,
            }}
          >
            {submitError}
          </p>
        ) : null}

        {completedCount > 0 && Object.keys(perRowErrors).length > 0 ? (
          <p
            style={{
              margin: 0,
              padding: theme.space[3],
              borderRadius: theme.radius.input,
              background: 'rgba(217, 119, 6, 0.08)',
              color: '#92400e',
              fontSize: theme.type.size.sm,
            }}
          >
            Partial success: {completedCount} refund(s) issued. Fix the highlighted lines and
            retry.
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function SourceAllocationRow({
  source,
  amountText,
  overLimit,
  error,
  onChange,
}: {
  source: RefundableSourceRow;
  amountText: string;
  overLimit: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const isDeposit = source.kind === 'deposit';
  const isCash = source.method === 'cash';
  const Icon = isDeposit ? Globe : isCash ? Banknote : CreditCard;
  const titleLabel = isDeposit
    ? source.source_label ?? 'Paid online at booking'
    : isCash
      ? 'Cash'
      : 'Card / contactless';
  const ariaLabel = isDeposit
    ? 'Refund amount for deposit'
    : isCash
      ? 'Refund amount for cash payment'
      : 'Refund amount for card payment';
  return (
    <div
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.input,
        border: `1px solid ${error || overLimit ? theme.color.alert : theme.color.border}`,
        background: theme.color.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Icon size={16} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {titleLabel}
            {source.taken_by_name ? (
              <span
                style={{
                  marginLeft: theme.space[2],
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.medium,
                  color: theme.color.inkSubtle,
                }}
              >
                by {source.taken_by_name}
              </span>
            ) : null}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Captured {formatPence(source.amount_pence)}
            {source.refunded_pence > 0
              ? ` · Already refunded ${formatPence(source.refunded_pence)}`
              : ''}
            {' · Remaining '}
            {formatPence(source.refundable_pence)}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[1] }}>
          <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>£</span>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0.00"
            aria-label={ariaLabel}
            style={{
              width: 96,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${overLimit ? theme.color.alert : theme.color.border}`,
              background: theme.color.surface,
              color: theme.color.ink,
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
            }}
          />
        </div>
      </div>
      {overLimit ? (
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.alert }}>
          Exceeds remaining refundable balance of {formatPence(source.refundable_pence)}.
        </span>
      ) : null}
      {error ? (
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.alert }}>{error}</span>
      ) : null}
    </div>
  );
}

function parsePoundsText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d*(\.\d{0,2})?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
