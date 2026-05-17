import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CreditCard, Globe, Pencil } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { DropdownSelect } from '../DropdownSelect/DropdownSelect.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import {
  REFUND_REASON_CATEGORIES,
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
  const [managersError, setManagersError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [perRowErrors, setPerRowErrors] = useState<Record<string, string>>({});
  // Free-form refund amount as the operator typed it (in pounds with
  // an optional decimal). Initialised on open from suggestedPence so
  // the default keeps the "refund what we owe" behaviour. Staff can
  // type any value from 0.01 up to the refundable ceiling — useful
  // for goodwill-only partials ("only refund half, the rest is
  // re-use credit"). We hold the raw string so the caret behaves
  // naturally while typing.
  const [amountInput, setAmountInput] = useState<string>('');

  // Reset every open so a previous half-filled attempt can't leak in.
  useEffect(() => {
    if (!open) return;
    setReasonCategory(defaultCategory);
    setReasonNote('');
    setManagerAccountId('');
    setSubmitError(null);
    setPerRowErrors({});
    setAmountInput((suggestedPence / 100).toFixed(2));
  }, [open, defaultCategory, suggestedPence]);

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

  // Refundable ceiling — the most we can possibly hand back across
  // all sources. Used to clamp the amount input + drive the "max"
  // helper. Sum of every source's remaining refundable balance.
  const refundableCeilingPence = useMemo(
    () => sources.reduce((acc, s) => acc + s.refundable_pence, 0),
    [sources],
  );

  // Parse the typed amount into pence. Tolerates trailing junk and
  // empty input — both yield 0, which fails the submit gate so the
  // operator sees the Refund button disabled instead of a confusing
  // amount mismatch later.
  const requestedPence = useMemo(() => {
    const n = Number.parseFloat(amountInput.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  }, [amountInput]);

  // Auto-allocate the requested amount across sources. Greedy, in
  // display order (deposit first, then till payments oldest-first).
  // Per-row tweaks aren't exposed — the operator picks the TOTAL,
  // the breakdown follows.
  const allocations = useMemo<Allocation[]>(() => {
    if (requestedPence <= 0) return [];
    let remaining = requestedPence;
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
  }, [sources, requestedPence]);

  const totalAllocatedPence = allocations.reduce((acc, a) => acc + a.pence, 0);
  const allocationShortfallPence = Math.max(0, requestedPence - totalAllocatedPence);
  const overCeiling = requestedPence > refundableCeilingPence;

  const noteOk = reasonNote.trim().length > 0;
  const managerOk = managerAccountId.length > 0;
  const amountOk = requestedPence > 0 && !overCeiling;
  const canSubmit =
    !submitting &&
    amountOk &&
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
      // Approver id is taken straight from the dropdown — no
      // password verification step. The manager's email +
      // account id are stamped on every audit row downstream so
      // the timeline still records who signed off.
      const approverId = manager.account_id;
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
      title="Issue a refund"
      description={
        refundableCeilingPence <= 0
          ? 'Nothing to refund right now.'
          : suggestedPence > 0 && suggestedPence === requestedPence
            ? `Returning ${formatPence(suggestedPence)} on the same cards or cash that paid. Type a smaller amount if you only want to refund part of it.`
            : 'Returning the amount below on the same cards or cash the patient paid with.'
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[8] }}>
        {/* Section 1 — amount + where it's going. No SheetSection
            wrapper here: the sheet title + description already say
            "Returning £60.00 to the patient on the same cards or cash
            that paid for the visit", so a second "Refund amount"
            heading would just be that twice. The £60.00 hero is the
            section header on this surface. */}
        {sourcesError ? (
          <ErrorLine message={sourcesError} />
        ) : sourcesLoading && sources.length === 0 ? (
          <MutedLine>Loading payments…</MutedLine>
        ) : refundableCeilingPence <= 0 ? (
          <MutedLine>
            No refundable payments on file for this visit. If they paid online, the
            refund may already be processing on Stripe.
          </MutedLine>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
            <AmountInput
              value={amountInput}
              onChange={setAmountInput}
              ceilingPence={refundableCeilingPence}
              suggestedPence={suggestedPence}
              overCeiling={overCeiling}
              disabled={submitting}
            />
            {allocations.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                <SubLabel>Going back to</SubLabel>
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
            {overCeiling ? (
              <ErrorLine
                message={`The most you can refund right now is ${formatPence(refundableCeilingPence)}. Lower the amount, or ask an admin to reconcile the rest.`}
              />
            ) : null}
          </div>
        )}

        {/* Section 2 — reason */}
        <SheetSection
          title="Why are we refunding?"
          subtitle={
            suggestedPence > 0 && requestedPence > 0 && requestedPence < suggestedPence
              ? `Pick the closest match, then explain why only ${formatPence(requestedPence)} of the ${formatPence(suggestedPence)} owed is being refunded. The note goes on the patient timeline word for word.`
              : 'Pick the closest match, then add a short note. The note goes on the patient timeline word for word.'
          }
        >
          <DropdownSelect<RefundReasonCategory>
            label="Reason"
            required
            value={reasonCategory}
            options={REFUND_REASON_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))}
            onChange={(v) => setReasonCategory(v)}
          />
          <Input
            label="Note for the timeline"
            required
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            placeholder="What item, why, what was the patient told"
            disabled={submitting}
          />
        </SheetSection>

        {/* Section 3 — manager approval */}
        <SheetSection
          title="Manager approval"
          subtitle="Refunds always need a manager. Pick the one who said yes."
        >
          {managersError ? <ErrorLine message={managersError} /> : null}
          <DropdownSelect<string>
            label="Approving manager"
            required
            value={managerAccountId}
            options={managers.map((m) => ({
              value: m.account_id,
              label: `${m.name} (${m.login_email})`,
            }))}
            onChange={(v) => setManagerAccountId(v)}
            placeholder={
              managers.length === 0
                ? 'No managers configured. Add one in Admin, Staff.'
                : 'Pick the manager who approved this refund'
            }
            disabled={managers.length === 0 || submitting}
          />
        </SheetSection>

        {submitError ? <ErrorLine message={submitError} /> : null}
      </div>
    </BottomSheet>
  );
}

// SheetSection — the May 2026 sheet section pattern. Black, bold,
// sentence-case title (size.md / weight.bold) over a smaller muted
// subtitle that explains the section in plain English. No uppercase
// eyebrows. The pattern reads like a short doc heading, not a form
// label, so a first-time user can scan top-to-bottom and know what
// each section is for without prior context.
function SheetSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.bold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {title}
        </h3>
        {subtitle ? (
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.normal,
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>{children}</div>
    </section>
  );
}

// AmountInput — the headline figure that owns the top of the sheet,
// and the field the operator types into for partial refunds.
//
// Read like an input first, hero second:
//   • Visible "Edit" Pencil icon on the right so the editability
//     is unmistakable. The previous design rendered the same £60.00
//     hero on every visit and operators thought it was static.
//   • Hover lifts the border to ink so it scans as interactive.
//   • Focus snaps to the accent border + selects the whole value so
//     typing immediately replaces.
//   • Quick chips below the field: All, Half, Custom. The chip-row
//     makes the partial-refund path one tap instead of "guess that
//     this looking-like-a-display thing accepts keystrokes".
function AmountInput({
  value,
  onChange,
  ceilingPence,
  suggestedPence,
  overCeiling,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  ceilingPence: number;
  suggestedPence: number;
  overCeiling: boolean;
  disabled: boolean;
}) {
  const ceilingFmt = formatPence(ceilingPence);
  const suggestedFmt = suggestedPence > 0 ? formatPence(suggestedPence) : null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Only allow digits + one decimal. Anything else gets stripped so
  // a paste of "£60.00" still produces a valid "60.00".
  const sanitise = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, '');
    const firstDot = cleaned.indexOf('.');
    if (firstDot === -1) return cleaned;
    return (
      cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
    );
  };

  // Quick chips. "All" = the suggested owed (or the ceiling when
  // there's no specific owed amount). "Half" = round down to the
  // nearest penny of half the owed/ceiling so a £60 owed turns into
  // a £30 chip. "Custom" focuses the input and selects-all so the
  // operator can just start typing.
  const targetPence = suggestedPence > 0 ? suggestedPence : ceilingPence;
  const targetStr = (targetPence / 100).toFixed(2);
  const halfPence = Math.floor(targetPence / 2);
  const halfStr = (halfPence / 100).toFixed(2);
  const isAll = value === targetStr;
  const isHalf = value === halfStr && halfPence > 0;

  const borderColor = overCeiling
    ? theme.color.alert
    : focused
      ? theme.color.accent
      : hovered
        ? theme.color.ink
        : theme.color.border;
  const borderWidth = focused || overCeiling ? 2 : 1;

  const focusAndSelect = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <label
        htmlFor="refund-amount-input"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          // Compensate the padding so the field doesn't jump 1px when
          // the focus state thickens the border.
          padding: focused || overCeiling
            ? `${theme.space[3] - 1}px ${theme.space[4] - 1}px`
            : `${theme.space[3]}px ${theme.space[4]}px`,
          borderRadius: theme.radius.input,
          background: theme.color.surface,
          border: `${borderWidth}px solid ${borderColor}`,
          cursor: disabled ? 'not-allowed' : 'text',
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <span
          aria-hidden
          style={{
            fontSize: theme.type.size.display,
            fontWeight: theme.type.weight.bold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            lineHeight: 1,
          }}
        >
          £
        </span>
        <input
          ref={inputRef}
          id="refund-amount-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(sanitise(e.target.value))}
          onFocus={(e) => {
            setFocused(true);
            // Select-all on focus so the operator can replace the
            // whole value with a single keystroke. Without this they
            // have to backspace 5 chars before they can type £30.
            e.currentTarget.select();
          }}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          aria-invalid={overCeiling}
          aria-describedby="refund-amount-helper"
          style={{
            flex: 1,
            minWidth: 0,
            appearance: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: theme.type.size.display,
            fontWeight: theme.type.weight.bold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
            padding: 0,
          }}
        />
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: theme.radius.pill,
            background: focused ? theme.color.accentBg : 'rgba(14,20,20,0.06)',
            color: focused ? theme.color.accent : theme.color.inkMuted,
            flexShrink: 0,
            transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
        >
          <Pencil size={14} aria-hidden />
        </span>
      </label>

      {/* Quick chips. Make the partial path obvious: one tap = half
          the owed amount. Custom focuses the input + selects all. */}
      {targetPence > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: theme.space[2],
          }}
        >
          <AmountChip
            label={`Refund all ${formatPence(targetPence)}`}
            active={isAll}
            disabled={disabled}
            onClick={() => onChange(targetStr)}
          />
          {halfPence > 0 ? (
            <AmountChip
              label={`Refund half ${formatPence(halfPence)}`}
              active={isHalf}
              disabled={disabled}
              onClick={() => onChange(halfStr)}
            />
          ) : null}
          <AmountChip
            label="Refund a custom amount"
            active={!isAll && !isHalf}
            disabled={disabled}
            onClick={focusAndSelect}
          />
        </div>
      ) : null}

      <p
        id="refund-amount-helper"
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          lineHeight: theme.type.leading.normal,
        }}
      >
        {suggestedFmt && suggestedPence > 0 ? (
          <>
            The patient is owed {suggestedFmt}. Tap a quick option above, or tap the
            amount and type any value up to {ceilingFmt}.
          </>
        ) : (
          <>You can refund any amount up to {ceilingFmt}.</>
        )}
      </p>
    </div>
  );
}

// AmountChip — tappable chip below the amount input. Active state
// fills with accent; inactive sits quietly on the surface. Used for
// "Refund all / Refund half / Refund custom" so the partial-refund
// path is one tap, not "discover that the £60.00 is editable".
function AmountChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        appearance: 'none',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.pill,
        background: active ? theme.color.accent : theme.color.surface,
        color: active ? '#fff' : theme.color.ink,
        border: `1px solid ${active ? theme.color.accent : theme.color.border}`,
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        lineHeight: 1.2,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {label}
    </button>
  );
}

// SubLabel — quiet, sentence-case subtitle used inside a section
// (e.g. "Going back to"). Replaces the old uppercase eyebrow.
function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
      }}
    >
      {children}
    </span>
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
  const { title, sub } = describeSource(source);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
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
            {title}
          </span>
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: error ? theme.color.alert : theme.color.inkMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {error ?? sub}
          </span>
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

// describeSource — single source of truth for the "Going back to" row
// copy. Renders a specific card title when card_brand + card_last4 are
// available (e.g. "Visa ending in 4242"), otherwise a plain-English
// fallback that still tells staff WHICH till channel the money's
// returning through.
function describeSource(source: RefundableSourceRow): { title: string; sub: string } {
  const brand = formatCardBrand(source.card_brand);
  const last4 = source.card_last4;
  if (source.kind === 'deposit') {
    if (brand && last4) {
      return {
        title: `${brand} ending in ${last4}`,
        sub: 'The card they paid the deposit with online.',
      };
    }
    return {
      title: 'Card used at booking',
      sub: 'The card they paid the deposit with online.',
    };
  }
  if (source.method === 'cash') {
    return { title: 'Cash drawer', sub: 'Hand the cash back at the till.' };
  }
  if (brand && last4) {
    return {
      title: `${brand} ending in ${last4}`,
      sub: 'The card they tapped at the till.',
    };
  }
  return {
    title: 'Card used at the till',
    sub: 'Goes back to the same card automatically.',
  };
}

// Pretty-printed Stripe card brand. Stripe returns "visa", "amex" etc;
// we display them with the casing customers recognise.
function formatCardBrand(brand: string | null): string | null {
  if (!brand) return null;
  const map: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    diners: 'Diners Club',
    jcb: 'JCB',
    unionpay: 'UnionPay',
    eftpos_au: 'eftpos',
    interac: 'Interac',
  };
  return map[brand.toLowerCase()] ?? brand;
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
