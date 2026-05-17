import { useEffect, useMemo, useState } from 'react';
import { Banknote, CreditCard, Globe } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { DropdownSelect } from '../DropdownSelect/DropdownSelect.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import {
  REFUND_REASON_CATEGORIES,
  approveAsManager,
  refundPartial,
  useRefundableSources,
  type RefundReasonCategory,
  type RefundableSourceRow,
} from '../../lib/queries/payments.ts';
import { listManagers, type ManagerRow } from '../../lib/queries/staff.ts';
import { formatPence } from '../../lib/queries/carts.ts';

// RefundSheet — staff-facing refund flow.
//
// Locked amount, single primary action. The trigger banner already
// computed what we owe; this sheet just makes the operator confirm
// the reason + the manager approving. No free-form amount entry,
// no per-row pickers — those just gave staff a way to type the
// wrong number.
//
// Allocation logic: the suggestedPence amount is auto-allocated
// across the patient's captured sources (deposit first, then till
// payments in capture order) up to the remaining refundable
// balance on each. Staff sees the breakdown as read-only chips so
// they know which money is going back through which channel.
//
// Submit: one refundPartial call per non-zero allocation, all
// approved with the same manager sign-off. Errors per allocation
// surface inline so a partial-success state is recoverable.

export interface RefundSheetProps {
  open: boolean;
  onClose: () => void;
  cartId: string | null;
  /** Required to surface the appointment's widget-paid deposit as
   *  a refundable source. Pass null only for walk-in visits with
   *  no linked appointment. */
  appointmentId: string | null;
  /** The amount we owe the patient. Locked. The trigger that
   *  opened this sheet (owed banner / cancellation banner) already
   *  did the math; we don't second-guess it. */
  suggestedPence: number;
  /** Pre-selected reason category. Staff can change it. */
  defaultCategory?: RefundReasonCategory;
  onCompleted?: () => void;
}

interface Allocation {
  source: RefundableSourceRow;
  pence: number;
}

export function RefundSheet({
  open,
  onClose,
  cartId,
  appointmentId,
  suggestedPence,
  defaultCategory = 'item_removed',
  onCompleted,
}: RefundSheetProps) {
  const {
    data: sources,
    loading: sourcesLoading,
    error: sourcesError,
    refresh,
  } = useRefundableSources({ cartId, appointmentId });

  const [reasonCategory, setReasonCategory] = useState<RefundReasonCategory>(defaultCategory);
  const [reasonNote, setReasonNote] = useState('');
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [managerAccountId, setManagerAccountId] = useState('');
  const [managerPassword, setManagerPassword] = useState('');
  const [managersError, setManagersError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [perRowErrors, setPerRowErrors] = useState<Record<string, string>>({});

  // Reset every open so a previous half-filled attempt can't leak in.
  useEffect(() => {
    if (!open) return;
    setReasonCategory(defaultCategory);
    setReasonNote('');
    setManagerAccountId('');
    setManagerPassword('');
    setSubmitError(null);
    setPerRowErrors({});
  }, [open, defaultCategory]);

  // Load managers (active is_manager) once per open. Same query the
  // discount + void approvers use.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setManagersError(null);
    listManagers()
      .then((list) => {
        if (cancelled) return;
        setManagers(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setManagersError(e instanceof Error ? e.message : 'Could not load managers');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Auto-allocate the suggested amount across sources. Greedy, in
  // display order (deposit first, then till payments oldest-first).
  // The result is read-only — staff can't tweak per-row, the input
  // we ask them for is the REASON, not the AMOUNT.
  const allocations = useMemo<Allocation[]>(() => {
    if (suggestedPence <= 0) return [];
    let remaining = suggestedPence;
    const out: Allocation[] = [];
    for (const s of sources) {
      if (remaining <= 0) break;
      const take = Math.min(s.refundable_pence, remaining);
      if (take > 0) {
        out.push({ source: s, pence: take });
        remaining -= take;
      }
    }
    return out;
  }, [sources, suggestedPence]);

  const totalAllocatedPence = allocations.reduce((acc, a) => acc + a.pence, 0);
  const allocationShortfallPence = Math.max(0, suggestedPence - totalAllocatedPence);

  const noteOk = reasonNote.trim().length > 0;
  const managerOk = managerAccountId.length > 0 && managerPassword.length > 0;
  const canSubmit =
    !submitting &&
    allocations.length > 0 &&
    allocationShortfallPence === 0 &&
    noteOk &&
    managerOk;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setPerRowErrors({});
    try {
      const manager = managers.find((m) => m.account_id === managerAccountId);
      if (!manager) {
        throw new Error('Pick an approving manager.');
      }
      const approverId = await approveAsManager(manager.login_email, managerPassword);
      const errors: Record<string, string> = {};
      let succeeded = 0;
      for (const alloc of allocations) {
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
        } catch (e) {
          errors[alloc.source.id] = e instanceof Error ? e.message : String(e);
        }
      }
      refresh();
      setPerRowErrors(errors);
      if (Object.keys(errors).length === 0 && succeeded > 0) {
        if (onCompleted) onCompleted();
        onClose();
        return;
      }
      if (succeeded === 0 && Object.keys(errors).length > 0) {
        setSubmitError(Object.values(errors)[0] ?? 'Refund failed');
      } else {
        if (onCompleted) onCompleted();
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not authorise the refund.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Issue refund"
      description={
        suggestedPence > 0
          ? `Refunding ${formatPence(suggestedPence)} to the patient. Locked to what's owed.`
          : 'Nothing to refund.'
      }
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
          >
            {submitting ? 'Refunding…' : `Refund ${formatPence(totalAllocatedPence)}`}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
        {/* ── Amount ────────────────────────────────────────────── */}
        <SheetSection title="Amount">
          {sourcesError ? (
            <ErrorLine message={sourcesError} />
          ) : sourcesLoading && allocations.length === 0 ? (
            <MutedLine>Loading payments…</MutedLine>
          ) : allocations.length === 0 ? (
            <MutedLine>
              No refundable payments on file. Stripe-handled refunds may already be in
              progress.
            </MutedLine>
          ) : (
            <>
              <div
                style={{
                  fontSize: theme.type.size.xxl,
                  fontWeight: theme.type.weight.bold,
                  letterSpacing: theme.type.tracking.tight,
                  color: theme.color.ink,
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.1,
                }}
              >
                {formatPence(totalAllocatedPence)}
              </div>
              {allocations.length > 1 || allocations[0]?.source.kind === 'deposit' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                  <span
                    style={{
                      fontSize: theme.type.size.xs,
                      fontWeight: theme.type.weight.semibold,
                      letterSpacing: theme.type.tracking.wide,
                      textTransform: 'uppercase',
                      color: theme.color.inkSubtle,
                    }}
                  >
                    Returning to
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                    {allocations.map((a) => (
                      <AllocationRow
                        key={a.source.id}
                        source={a.source}
                        pence={a.pence}
                        error={perRowErrors[a.source.id] ?? null}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {allocationShortfallPence > 0 ? (
                <ErrorLine
                  message={`Only ${formatPence(totalAllocatedPence)} of the ${formatPence(
                    suggestedPence,
                  )} owed can be refunded right now. The rest needs an admin to reconcile.`}
                />
              ) : null}
            </>
          )}
        </SheetSection>

        {/* ── Reason ────────────────────────────────────────────── */}
        <SheetSection title="Reason">
          <DropdownSelect<RefundReasonCategory>
            label="What's the reason?"
            required
            value={reasonCategory}
            options={REFUND_REASON_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
            onChange={(v) => setReasonCategory(v)}
          />
          <Input
            label="Specific reason"
            required
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            placeholder="What item, why, what was the patient told"
            helper="Goes on the patient timeline word for word."
            disabled={submitting}
          />
        </SheetSection>

        {/* ── Manager approval ──────────────────────────────────── */}
        <SheetSection title="Manager sign-off">
          {managersError ? <ErrorLine message={managersError} /> : null}
          <DropdownSelect<string>
            label="Approving manager"
            required
            value={managerAccountId}
            options={managers.map((m) => ({ value: m.account_id, label: m.name }))}
            onChange={(v) => setManagerAccountId(v)}
            placeholder={
              managers.length === 0
                ? 'No managers configured. Add one in Admin, Staff.'
                : 'Pick a manager'
            }
            disabled={managers.length === 0 || submitting}
          />
          <Input
            label="Manager password"
            type="password"
            // Manager re-enters their password live every time. Block
            // any cached / saved-password autofill so a second person
            // can't be approved by stale credentials.
            autoComplete="new-password"
            name="lng-refund-approver-password"
            data-lpignore="true"
            data-1p-ignore
            value={managerPassword}
            onChange={(e) => setManagerPassword(e.target.value)}
            disabled={submitting}
          />
        </SheetSection>

        {submitError ? <ErrorLine message={submitError} /> : null}
      </div>
    </BottomSheet>
  );
}

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
          color: theme.color.inkSubtle,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function AllocationRow({
  source,
  pence,
  error,
}: {
  source: RefundableSourceRow;
  pence: number;
  error: string | null;
}) {
  const Icon = source.kind === 'deposit' ? Globe : source.method === 'cash' ? Banknote : CreditCard;
  const label =
    source.kind === 'deposit'
      ? source.source_label ?? 'Paid online at booking'
      : source.method === 'cash'
        ? 'Cash at the till'
        : 'Card at the till';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        background: theme.color.surface,
        border: `1px solid ${error ? theme.color.alert : theme.color.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Icon size={14} aria-hidden />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </span>
          {error ? (
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.alert }}>
              {error}
            </span>
          ) : null}
        </div>
      </div>
      <span
        style={{
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {formatPence(pence)}
      </span>
    </div>
  );
}

function MutedLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
      }}
    >
      {children}
    </p>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p
      role="alert"
      style={{
        margin: 0,
        fontSize: theme.type.size.sm,
        color: theme.color.alert,
        fontWeight: theme.type.weight.medium,
      }}
    >
      {message}
    </p>
  );
}
