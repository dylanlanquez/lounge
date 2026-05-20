import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowDownToLine, ChevronRight, Download, FileSignature, Plus, Wallet } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  DropdownSelect,
  EmptyState,
  Input,
  Section,
  Skeleton,
  StatusPill,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type CashCountRow,
  type CashPosition,
  type CashPositionPaymentLine,
  type WithdrawalReason,
  WITHDRAWAL_REASONS,
  createCashCount,
  recordCashWithdrawal,
  signCashCount,
  updateCashCountActual,
  useAnomalyThresholds,
  useCashCounts,
  useCashCountStatement,
  useCashPosition,
  withdrawalReasonLabel,
} from '../lib/queries/cashCounts.ts';
import { formatNumber, formatPence } from '../lib/queries/carts.ts';
import { sendManagerNotification } from '../lib/queries/managerNotifications.ts';
import { listManagers, type ManagerRow } from '../lib/queries/staff.ts';
import { buildCashCountPdf, downloadCashCountPdf } from '../lib/cashCountPdf.ts';
import { logFailure } from '../lib/failureLog.ts';

// Cash counts — promoted to a top-level route from the old
// `Reports → Cash reconciliation` tab.
//
// The page that closes the till each shift. One headline answer
// ("£X is in the safe right now"), one primary action ("Count cash
// now"), and below it a clean roll of past counts. Anyone with
// `can_count_cash` reaches it from the kiosk top-nav icon; reading
// is also opened up to `can_view_financials` so finance admins
// don't lose visibility just because they don't run counts
// themselves.
//
// Design priorities:
//
//   • Big number, plain English. The "right now" card leads with the
//     amount in the safe, written as a sentence. No "Earliest in run"
//     / "Latest" jargon.
//   • One row per past count, scannable. The default case (count
//     matched expected, signed off cleanly) shows a single sentence.
//     Differences, notes, and "Open"/"Disputed" status only surface
//     when they're meaningful — "Signed" is the implied default.
//   • Match Lounge's existing language. "Cash count" (not
//     reconciliation), "Difference" (not variance), "Open" (not
//     pending). Same words the Pay flow and Admin → Staff already
//     use.

export function CashCounts() {
  const { user, loading: authLoading } = useAuth();
  const { account, loading: accountLoading } = useCurrentAccount();
  const isMobile = useIsMobile(640);
  const counts = useCashCounts();
  const position = useCashPosition();
  const thresholds = useAnomalyThresholds();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetKind, setSheetKind] = useState<'regular' | 'legacy_baseline'>('regular');
  const [statementCountId, setStatementCountId] = useState<string | null>(null);
  const [takeFromSafeOpen, setTakeFromSafeOpen] = useState(false);

  // Admin → Testing → "Start legacy cash count" navigates here with
  // location.state.kind = 'legacy_baseline'. Pick that up exactly
  // once, set the sheet to legacy mode, and consume the state so a
  // back-nav + forward-nav doesn't reopen the legacy sheet.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const incoming = (location.state as { kind?: 'regular' | 'legacy_baseline' } | null)?.kind;
    if (incoming === 'legacy_baseline') {
      setSheetKind('legacy_baseline');
      setSheetOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  if (authLoading || accountLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;
  // Either permission opens the door. Counting is gated by
  // can_count_cash separately at the CTA.
  if (!account || (!account.can_count_cash && !account.can_view_financials)) {
    return <Navigate to="/" replace />;
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${
          isMobile ? theme.space[4] : theme.space[6]
        }px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${
          isMobile ? theme.space[6] : theme.space[8]
        }px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div
        style={{
          maxWidth: theme.layout.pageMaxWidth,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[5],
        }}
      >
        <header>
          <h1
            style={{
              margin: 0,
              fontSize: isMobile ? theme.type.size.xl : theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Cash counts
          </h1>
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              maxWidth: 640,
              lineHeight: theme.type.leading.snug,
            }}
          >
            Counts every cash payment between sign-offs and double-checks the safe.
            One count per close, signed by a different manager.
          </p>
        </header>

        {counts.error || position.error ? (
          <Card padding="lg">
            <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
              Couldn't load cash counts: {counts.error ?? position.error}
            </p>
          </Card>
        ) : counts.loading || position.loading || !counts.data || !position.data ? (
          <>
            <Skeleton height={220} />
            <Skeleton height={320} />
          </>
        ) : (
          <>
            <RightNowCard
              position={position.data}
              canCountCash={!!account.can_count_cash}
              onStart={() => {
                setSheetKind('regular');
                setSheetOpen(true);
              }}
              onTakeFromSafe={() => setTakeFromSafeOpen(true)}
            />
            {position.data.lines.length > 0 ? (
              <RecentActivityCard
                lines={position.data.lines}
                baselinePence={position.data.baseline_pence}
              />
            ) : null}
            <HistoryCard
              counts={counts.data}
              onOpen={(id) => setStatementCountId(id)}
            />
          </>
        )}
      </div>

      {position.data ? (
        <NewCountSheet
          open={sheetOpen}
          onClose={() => {
            setSheetOpen(false);
            setSheetKind('regular');
          }}
          position={position.data}
          thresholds={thresholds.data}
          currentAccountId={account.account_id ?? null}
          kind={sheetKind}
          onSigned={() => {
            counts.refresh?.();
            position.refresh();
            setSheetOpen(false);
            setSheetKind('regular');
          }}
        />
      ) : null}

      <TakeFromSafeSheet
        open={takeFromSafeOpen}
        onClose={() => setTakeFromSafeOpen(false)}
        currentExpectedPence={position.data?.expected_in_safe_pence ?? 0}
        currentAccountId={account.account_id ?? null}
        onRecorded={() => {
          position.refresh();
          setTakeFromSafeOpen(false);
        }}
      />

      <CountDetailsSheet
        countId={statementCountId}
        onClose={() => setStatementCountId(null)}
      />
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-now card — the headline answer to "should I count tonight?"
// ─────────────────────────────────────────────────────────────────────────────

function RightNowCard({
  position,
  canCountCash,
  onStart,
  onTakeFromSafe,
}: {
  position: CashPosition;
  canCountCash: boolean;
  onStart: () => void;
  onTakeFromSafe: () => void;
}) {
  const last = position.last_signed_count;
  const hasActivity =
    position.payment_count > 0 || position.withdrawal_count > 0 || position.expected_in_safe_pence > 0;
  const hasCashInSafe = position.expected_in_safe_pence > 0;

  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          marginBottom: theme.space[3],
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            border: `1px solid ${theme.color.border}`,
            flexShrink: 0,
          }}
        >
          <Wallet size={16} aria-hidden />
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.inkMuted,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
          }}
        >
          Right now
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.display,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: theme.type.leading.tight,
        }}
      >
        {formatPence(position.expected_in_safe_pence)}
      </p>
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.md,
          color: theme.color.ink,
          maxWidth: 640,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {hasActivity ? (
          <>
            should be in the safe.{' '}
            <span style={{ color: theme.color.inkMuted }}>
              Opening {formatPence(position.baseline_pence)}
              {last ? ` from the count on ${formatLongDate(last.period_end)}` : ''}.
              {' '}Since: {formatNumber(position.payment_count)} payment{position.payment_count === 1 ? '' : 's'} in,
              {' '}{formatNumber(position.withdrawal_count)} withdrawal{position.withdrawal_count === 1 ? '' : 's'} out.
            </span>
          </>
        ) : (
          <span style={{ color: theme.color.inkMuted }}>
            {last
              ? `No cash activity since the last count on ${formatLongDate(last.period_end)}. Nothing to count yet.`
              : 'No cash activity yet. Cash counts kick in once the first cash payment is taken or you seed a starting balance.'}
          </span>
        )}
      </p>

      {last ? (
        <p
          style={{
            margin: `${theme.space[3]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <FileSignature size={12} aria-hidden />
          Last count {formatLongDate(last.period_end)}
          {last.actual_pence != null ? ` · ${formatPence(last.actual_pence)} counted` : ''}
        </p>
      ) : null}

      {canCountCash ? (
        <div
          style={{
            marginTop: theme.space[5],
            display: 'flex',
            gap: theme.space[3],
            flexWrap: 'wrap',
          }}
        >
          {hasActivity ? (
            <Button variant="primary" onClick={onStart}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <Plus size={14} aria-hidden />
                Count cash now
              </span>
            </Button>
          ) : null}
          {hasCashInSafe ? (
            <Button variant="secondary" onClick={onTakeFromSafe}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <ArrowDownToLine size={14} aria-hidden />
                Take from safe
              </span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contributing payments — table of every cash line since the last
// signed count, clickable through to the visit page. Renders only
// when at least one cash payment has landed since the anchor;
// otherwise the RightNowCard's empty-state copy carries the room
// alone.
// ─────────────────────────────────────────────────────────────────────────────

// Renamed from ContributingPaymentsCard. Now shows interleaved cash
// activity — payments add to the running balance, withdrawals
// subtract from it. Lines are pre-sorted newest-first by
// useCashPosition. Tap a payment row to open the visit; withdrawals
// have no click-through (no visit attached, just an audit row).
function RecentActivityCard({
  lines,
  baselinePence,
}: {
  lines: CashPosition['lines'];
  baselinePence: number;
}) {
  const navigate = useNavigate();
  const paymentTotal = useMemo(
    () => lines.reduce((sum, l) => (l.kind === 'payment' ? sum + l.amount_pence : sum), 0),
    [lines],
  );
  const withdrawalTotal = useMemo(
    () => lines.reduce((sum, l) => (l.kind === 'withdrawal' ? sum + l.amount_pence : sum), 0),
    [lines],
  );
  const handleOpenPayment = (line: CashPositionPaymentLine) => {
    if (!line.visit_id) return;
    navigate(`/visit/${line.visit_id}`);
  };
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          marginBottom: theme.space[4],
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Activity since last count
          </span>
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
            }}
          >
            Opening {formatPence(baselinePence)}. Every payment in and every withdrawal out since. Tap a payment row to open the visit.
          </span>
        </div>
      </div>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          overflow: 'hidden',
        }}
      >
        {lines.map((line, idx) => {
          const key = line.kind === 'payment' ? line.payment_id : line.withdrawal_id;
          const interactive = line.kind === 'payment' && !!line.visit_id;
          const isOut = line.kind === 'withdrawal';
          const amountColor = isOut ? theme.color.alert : theme.color.accent;
          const amountPrefix = isOut ? '−' : '+';
          // Mobile-first 2-line layout:
          //   Line 1 (top):    Label (left, semibold)     · Amount (right)
          //   Line 2 (bottom): Time + actor/ref (muted)   · Chevron
          // Stacks vertically on narrow screens without truncating the
          // actor column the way the old 5-column grid did.
          const middleLabel = isOut ? withdrawalReasonLabel(line.reason) : (line.patient_name || 'Unknown patient');
          const subParts: string[] = [formatDateTime(line.taken_at)];
          if (isOut) {
            if (line.taken_by_name) subParts.push(`by ${line.taken_by_name}`);
          } else {
            if (line.appointment_ref) subParts.push(line.appointment_ref);
          }
          return (
            <li
              key={key}
              style={{
                borderTop: idx === 0 ? 'none' : `1px solid ${theme.color.border}`,
              }}
            >
              <button
                type="button"
                onClick={() => line.kind === 'payment' && handleOpenPayment(line)}
                disabled={!interactive}
                style={{
                  appearance: 'none',
                  fontFamily: 'inherit',
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  textAlign: 'left',
                  cursor: interactive ? 'pointer' : 'default',
                  transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                }}
                onMouseEnter={(e) => {
                  if (interactive) e.currentTarget.style.background = theme.color.bg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {middleLabel}
                  </span>
                  <span
                    style={{
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: theme.type.leading.snug,
                      wordBreak: 'break-word',
                    }}
                  >
                    {subParts.join(' · ')}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: theme.type.size.base,
                    fontWeight: theme.type.weight.semibold,
                    color: amountColor,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {amountPrefix}{formatPence(line.amount_pence)}
                </span>
                <ChevronRight
                  size={14}
                  aria-hidden
                  style={{
                    color: interactive ? theme.color.inkSubtle : 'transparent',
                    flexShrink: 0,
                  }}
                />
              </button>
            </li>
          );
        })}
      </ul>

      {/* Footer — two neutral stats. Cash in and cash out shown side
          by side so daily banking doesn't render as one big red
          "deficit" headline. The Right-now card above already owns
          the running-balance number; this card is purely the
          breakdown that sums to it. */}
      <div
        style={{
          marginTop: theme.space[3],
          paddingTop: theme.space[3],
          borderTop: `1px solid ${theme.color.border}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Cash in
          </span>
          <span
            style={{
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatPence(paymentTotal)}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Cash out
          </span>
          <span
            style={{
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatPence(withdrawalTotal)}
          </span>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Take from safe — records a cash withdrawal (bank deposit, float
// top-up, petty cash, owner draw, other). Solo recording — the audit
// row + the manager-notification email substitute for a second
// signer. Amount, reason, optional note. Refuses an amount above the
// current expected balance — there's no scenario where staff legit-
// imately remove more cash than is recorded as being in the safe.
// ─────────────────────────────────────────────────────────────────────────────

function TakeFromSafeSheet({
  open,
  onClose,
  currentExpectedPence,
  currentAccountId,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  currentExpectedPence: number;
  /** accounts.id of the signed-in staff member. Passed through to
   *  sendManagerNotification as staff_account_id so the manager
   *  email renders {{takenByName}} correctly. Null only on the rare
   *  surface where the account hasn't resolved yet. */
  currentAccountId: string | null;
  onRecorded: () => void;
}) {
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState<WithdrawalReason>('bank_deposit');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmountText('');
    setReason('bank_deposit');
    setNote('');
    setError(null);
  }, [open]);

  const amountPence = useMemo(() => {
    const float = Number(amountText.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(float) || float <= 0) return null;
    return Math.round(float * 100);
  }, [amountText]);

  const submit = async () => {
    setError(null);
    if (amountPence === null) {
      setError('Enter the amount in pounds, e.g. 400.00.');
      return;
    }
    if (amountPence > currentExpectedPence) {
      setError(
        `That's more than the ${formatPence(currentExpectedPence)} the safe is recording. Count the safe first if the running balance is wrong.`,
      );
      return;
    }

    setBusy(true);
    try {
      const locationId = await resolveLocationId();
      const { withdrawal_id } = await recordCashWithdrawal({
        location_id: locationId,
        amount_pence: amountPence,
        reason,
        note,
      });
      // Manager-notification email is fire-and-forget; if it fails
      // the withdrawal row itself is already persisted, so the
      // running balance is still correct. The failure logs to
      // lng_system_failures inside sendManagerNotification.
      void sendManagerNotification({
        actionKind: 'cash_withdrawn',
        amountPence,
        reason,
        patientId: null,
        visitId: null,
        staffAccountId: currentAccountId,
        note,
        withdrawalId: withdrawal_id,
      });
      onRecorded();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      await logFailure({
        source: 'cash.withdrawal.write',
        severity: 'error',
        message,
        context: { amountPence, reason },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title="Take from safe"
      description="Record cash physically leaving the safe — bank deposit, float top-up, petty cash, owner draw, or another reason. The running balance drops by this amount and the configured managers get an email for their records."
      footer={
        <div
          style={{
            display: 'flex',
            gap: theme.space[3],
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Record withdrawal
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <div
          style={{
            padding: theme.space[5],
            borderRadius: theme.radius.input,
            background: theme.color.accentBg,
            border: `1px solid ${theme.color.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Currently in safe
          </span>
          <span
            style={{
              fontSize: theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
              lineHeight: theme.type.leading.tight,
            }}
          >
            {formatPence(currentExpectedPence)}
          </span>
        </div>

        <Input
          label="Amount taken (£)"
          numericFormat="currency"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="e.g. 400.00"
          autoFocus
        />

        <DropdownSelect
          label="Reason"
          value={reason}
          onChange={(v) => setReason(v as WithdrawalReason)}
          options={WITHDRAWAL_REASONS.map((r) => ({ value: r.value, label: r.label }))}
        />

        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Lloyds drop, slip #84."
        />

        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              background: '#FFEEEC',
              color: theme.color.alert,
              fontSize: theme.type.size.sm,
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History — one row per past count, single line where possible
// ─────────────────────────────────────────────────────────────────────────────

function HistoryCard({
  counts,
  onOpen,
}: {
  counts: CashCountRow[];
  onOpen: (id: string) => void;
}) {
  if (counts.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<FileSignature size={20} />}
          title="No counts yet"
          description="The first count creates the baseline. Anyone with cash-counting permission can run one — the Count cash now button appears above as soon as a cash payment is taken."
        />
      </Card>
    );
  }

  return (
    <Card padding="none">
      <header
        style={{
          padding: `${theme.space[5]}px ${theme.space[5]}px ${theme.space[3]}px`,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Past counts
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Newest first. Open a row to see the per-payment breakdown and download a PDF.
        </p>
      </header>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {counts.map((c, idx) => (
          <CountRow key={c.id} count={c} isFirst={idx === 0} onOpen={() => onOpen(c.id)} />
        ))}
      </ul>
    </Card>
  );
}

function CountRow({
  count,
  isFirst,
  onOpen,
}: {
  count: CashCountRow;
  isFirst: boolean;
  onOpen: () => void;
}) {
  const counted = count.actual_pence;
  const expected = count.expected_pence;
  const diff = count.variance_pence;
  const matched = counted !== null && diff === 0;
  const showStatus = count.status !== 'signed';
  const isLegacy = count.kind === 'legacy_baseline';

  // Headline sentence — varies by whether the count matched.
  // Legacy baseline reads as a seed event, not a reconciliation, so
  // it skips the "expected vs counted" framing entirely (expected is
  // 0 by construction; the variance pill would be misleading).
  const summary = isLegacy ? (
    <>Starting balance {formatPence(counted ?? 0)}</>
  ) : counted === null ? (
    <>Not yet counted · expected {formatPence(expected)}</>
  ) : matched ? (
    <>{formatPence(counted)} counted · matched expected</>
  ) : (
    <>{formatPence(counted)} counted · expected {formatPence(expected)}</>
  );

  return (
    <li
      style={{
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        display: 'flex',
        gap: theme.space[4],
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatLongDate(count.period_end)}
          </span>
          {isLegacy ? (
            <span
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                background: theme.color.bg,
                padding: `2px ${theme.space[2]}px`,
                borderRadius: theme.radius.pill,
              }}
            >
              Starting balance
            </span>
          ) : null}
          {showStatus ? <CountStatus status={count.status} /> : null}
          {!isLegacy && !matched && counted !== null ? (
            <span
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: diff < 0 ? theme.color.alert : theme.color.warn,
                background: diff < 0 ? '#FFEEEC' : '#FFF6E5',
                padding: `2px ${theme.space[2]}px`,
                borderRadius: theme.radius.pill,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {diff > 0 ? '+' : '−'}
              {formatPence(Math.abs(diff))} {diff < 0 ? 'short' : 'over'}
            </span>
          ) : null}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {summary}
        </p>
        <p
          style={{
            margin: `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
          }}
        >
          Counted by <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>{count.counted_by_name}</span>
          {count.signed_off_by_name ? (
            <>
              {' · '}
              Signed by <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>{count.signed_off_by_name}</span>
            </>
          ) : null}
        </p>
        {count.notes ? (
          <p
            style={{
              margin: `${theme.space[2]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              fontStyle: 'italic',
              lineHeight: theme.type.leading.snug,
            }}
          >
            "{count.notes}"
          </p>
        ) : null}
      </div>
      <Button variant="tertiary" size="sm" onClick={onOpen}>
        Open
      </Button>
    </li>
  );
}

function CountStatus({ status }: { status: 'pending' | 'signed' | 'disputed' }) {
  // "Signed" is the default — never shown. Only surface when the
  // count is open (counted but not signed) or disputed.
  if (status === 'pending') {
    return (
      <StatusPill tone="pending" size="sm">
        Open
      </StatusPill>
    );
  }
  if (status === 'disputed') {
    return (
      <StatusPill tone="no_show" size="sm">
        Disputed
      </StatusPill>
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// New-count sheet — the closing-up form
// ─────────────────────────────────────────────────────────────────────────────

function NewCountSheet({
  open,
  onClose,
  position,
  thresholds,
  currentAccountId,
  onSigned,
  kind = 'regular',
}: {
  open: boolean;
  onClose: () => void;
  position: CashPosition;
  thresholds: {
    discount_pct: number;
    void_window_minutes: number;
    cash_variance_pence: number;
    cash_count_overdue_days: number;
  } | null;
  currentAccountId: string | null;
  onSigned: () => void;
  // 'legacy_baseline' is the explicit launch / re-launch reset path
  // triggered from Admin → Testing → Legacy cash count. Functionally
  // identical to a regular count, but the sheet copy reads "Start fresh"
  // and the row's `kind` column lets the history list label the row as
  // a baseline reset rather than a routine reconciliation.
  kind?: 'regular' | 'legacy_baseline';
}) {
  const [actualText, setActualText] = useState('');
  const [notes, setNotes] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Legacy-baseline only: optional inline withdrawal recorded
  // immediately AFTER the count is signed. Lets the operator seed
  // the safe and log "some of this isn't really staying in the
  // safe, banking £400 today" in one submit instead of two.
  const [inlineWithdrawalOpen, setInlineWithdrawalOpen] = useState(false);
  const [inlineWithdrawalAmountText, setInlineWithdrawalAmountText] = useState('');
  const [inlineWithdrawalReason, setInlineWithdrawalReason] = useState<WithdrawalReason>('bank_deposit');
  const [inlineWithdrawalNote, setInlineWithdrawalNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setActualText('');
    setNotes('');
    setManagerId('');
    setError(null);
    setInlineWithdrawalOpen(false);
    setInlineWithdrawalAmountText('');
    setInlineWithdrawalReason('bank_deposit');
    setInlineWithdrawalNote('');
    // Show every active manager including the current account.
    // Self-sign-off is permitted — the signer's name lands on the
    // audit row regardless of who's logged in.
    listManagers()
      .then((rows) => setManagers(rows))
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Could not load managers: ${message}`);
      });
  }, [open, currentAccountId]);

  const periodStart = useMemo(() => {
    if (position.last_signed_count) return position.last_signed_count.period_end;
    if (position.earliest_payment_at) return position.earliest_payment_at;
    return new Date(0).toISOString();
  }, [position]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const periodEnd = useMemo(() => new Date().toISOString(), [open]);

  const actualPence = useMemo(() => {
    const float = Number(actualText.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(float)) return null;
    return Math.round(float * 100);
  }, [actualText]);

  const isLegacyBaseline = kind === 'legacy_baseline';
  const inlineWithdrawalPence = useMemo(() => {
    if (!isLegacyBaseline || !inlineWithdrawalOpen) return null;
    const float = Number(inlineWithdrawalAmountText.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(float) || float <= 0) return null;
    return Math.round(float * 100);
  }, [isLegacyBaseline, inlineWithdrawalOpen, inlineWithdrawalAmountText]);
  const diff = actualPence === null ? null : actualPence - position.expected_in_safe_pence;
  // Variance against expected is meaningless for a baseline — the
  // whole point of a legacy_baseline count is to seed the safe with
  // whatever is physically there, regardless of what Lounge has
  // recorded (which is normally £0 because no payments have been
  // processed yet at launch). Skip the over-threshold note gate.
  const diffNeedsNote =
    !isLegacyBaseline
    && thresholds !== null
    && diff !== null
    && Math.abs(diff) >= thresholds.cash_variance_pence;

  const submit = async () => {
    setError(null);
    if (actualPence === null || actualPence < 0) {
      setError('Enter the amount in pounds, e.g. 405.00.');
      return;
    }
    if (diffNeedsNote && notes.trim().length === 0) {
      setError(
        `That's over the ${formatPence(thresholds!.cash_variance_pence)} threshold for unexplained differences. Add a quick note about what happened.`,
      );
      return;
    }
    if (!managerId) {
      setError('Pick the manager signing off this count.');
      return;
    }
    // Skip the activity gate for the legacy_baseline path — that's
    // explicitly the "we just launched and the safe already has cash
    // from work that was processed outside Lounge" entry point. For
    // routine counts, refusing on no activity stays correct.
    if (!isLegacyBaseline && !position.last_signed_count && !position.earliest_payment_at) {
      setError('No cash activity yet — there is nothing to count.');
      return;
    }
    // Inline-withdrawal validation (legacy_baseline only).
    if (isLegacyBaseline && inlineWithdrawalOpen) {
      if (inlineWithdrawalPence === null) {
        setError('Enter the withdrawal amount in pounds, e.g. 400.00.');
        return;
      }
      if (inlineWithdrawalPence > actualPence) {
        setError(
          `Withdrawal can't exceed the starting balance (${formatPence(actualPence)}).`,
        );
        return;
      }
    }

    setBusy(true);
    // Tracked so the catch block can roll back a half-created count
    // — without this, a failed sign (constraint violation, network
    // blip, RLS rejection) leaves a pending row in the safe history
    // alongside any successful retry.
    let pendingCountId: string | null = null;
    try {
      const locationId = await resolveLocationId();
      const created = await createCashCount({
        location_id: locationId,
        period_start: periodStart,
        period_end: periodEnd,
        kind,
      });
      pendingCountId = created.count_id;
      await updateCashCountActual(created.count_id, actualPence, notes);
      await signCashCount({
        count_id: created.count_id,
        signer_account_id: managerId,
      });
      pendingCountId = null;
      // Inline withdrawal records AFTER the count is signed, so the
      // withdrawal's taken_at falls AFTER the count's period_end and
      // flows into the next count's running-balance maths (rather
      // than this one's snapshot). Manager email is fire-and-forget.
      if (isLegacyBaseline && inlineWithdrawalOpen && inlineWithdrawalPence !== null) {
        const { withdrawal_id } = await recordCashWithdrawal({
          location_id: locationId,
          amount_pence: inlineWithdrawalPence,
          reason: inlineWithdrawalReason,
          note: inlineWithdrawalNote,
        });
        void sendManagerNotification({
          actionKind: 'cash_withdrawn',
          amountPence: inlineWithdrawalPence,
          reason: inlineWithdrawalReason,
          patientId: null,
          visitId: null,
          staffAccountId: currentAccountId,
          note: inlineWithdrawalNote,
          withdrawalId: withdrawal_id,
        });
      }
      onSigned();
    } catch (e) {
      // Roll back a pending count so the next retry isn't blocked
      // by orphan history. Best-effort; if the delete fails too
      // (RLS, network) we still surface the original error.
      if (pendingCountId) {
        const { supabase } = await import('../lib/supabase.ts');
        await supabase
          .from('lng_cash_counts')
          .delete()
          .eq('id', pendingCountId)
          .eq('status', 'pending');
      }
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      await logFailure({
        source: 'cash.count.write',
        severity: 'error',
        message,
        context: { actualPence, periodStart, periodEnd },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title={kind === 'legacy_baseline' ? 'Legacy cash count — start fresh' : 'Count cash'}
      description={
        kind === 'legacy_baseline'
          ? 'Count what is physically in the safe right now and have a manager sign off. This becomes the baseline — every count after this starts from this point.'
          : 'Count the cash in the safe and have a different manager sign off. Differences get flagged automatically.'
      }
      footer={
        <div
          style={{
            display: 'flex',
            gap: theme.space[3],
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Sign and save
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <div
          style={{
            padding: theme.space[5],
            borderRadius: theme.radius.input,
            background: theme.color.accentBg,
            border: `1px solid ${theme.color.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {isLegacyBaseline ? 'Starting balance' : 'Expected in safe'}
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
              lineHeight: theme.type.leading.tight,
            }}
          >
            {isLegacyBaseline ? '—' : formatPence(position.expected_in_safe_pence)}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.normal,
            }}
          >
            {isLegacyBaseline
              ? 'Enter what is physically in the safe right now, including any cash from work processed outside Lounge. This becomes the starting point.'
              : position.last_signed_count
                ? `Cash since the last count on ${formatLongDate(position.last_signed_count.period_end)}`
                : position.earliest_payment_at
                  ? `Cash since the first cash payment on ${formatLongDate(position.earliest_payment_at)}`
                  : 'No cash activity yet.'}
          </p>
        </div>

        <Input
          label="Counted in safe (£)"
          numericFormat="currency"
          value={actualText}
          onChange={(e) => setActualText(e.target.value)}
          placeholder="e.g. 405.00"
          autoFocus
        />

        {!isLegacyBaseline && diff !== null ? (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              background:
                diff < 0 ? '#FFEEEC' : diff > 0 ? '#FFF6E5' : theme.color.accentBg,
              alignSelf: 'flex-start',
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                color:
                  diff < 0
                    ? theme.color.alert
                    : diff > 0
                      ? theme.color.warn
                      : theme.color.accent,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {diff === 0
                ? 'Matches expected'
                : `Difference: ${diff > 0 ? '+' : '−'}${formatPence(Math.abs(diff))} ${diff < 0 ? 'short' : 'over'}`}
            </span>
            {diffNeedsNote ? (
              <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                — note required
              </span>
            ) : null}
          </div>
        ) : null}

        <Input
          label={diffNeedsNote ? 'Note (required)' : 'Note (optional)'}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            isLegacyBaseline
              ? 'Optional context, e.g. cash collected pre-launch.'
              : 'What explains the difference, if anything?'
          }
        />

        {isLegacyBaseline ? (
          <div
            style={{
              padding: theme.space[5],
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              background: theme.color.bg,
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[4],
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space[3] }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                <h3
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.md,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    letterSpacing: theme.type.tracking.tight,
                  }}
                >
                  Also record a withdrawal
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: theme.type.size.sm,
                    color: theme.color.inkMuted,
                    lineHeight: theme.type.leading.normal,
                  }}
                >
                  Optional. If part of the starting balance is about to leave the safe (banking, float top-up, etc.), log it here in the same step. It drops off the running balance the moment this is signed.
                </p>
              </div>
              <Button
                variant={inlineWithdrawalOpen ? 'tertiary' : 'secondary'}
                size="sm"
                onClick={() => setInlineWithdrawalOpen((v) => !v)}
              >
                {inlineWithdrawalOpen ? 'Not now' : 'Add'}
              </Button>
            </div>
            {inlineWithdrawalOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
                <Input
                  label="Amount taken (£)"
                  numericFormat="currency"
                  value={inlineWithdrawalAmountText}
                  onChange={(e) => setInlineWithdrawalAmountText(e.target.value)}
                  placeholder="e.g. 400.00"
                />
                <DropdownSelect
                  label="Reason"
                  value={inlineWithdrawalReason}
                  onChange={(v) => setInlineWithdrawalReason(v as WithdrawalReason)}
                  options={WITHDRAWAL_REASONS.map((r) => ({ value: r.value, label: r.label }))}
                />
                <Input
                  label="Note (optional)"
                  value={inlineWithdrawalNote}
                  onChange={(e) => setInlineWithdrawalNote(e.target.value)}
                  placeholder="e.g. Lloyds drop, slip #84."
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            padding: theme.space[5],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.bg,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[4],
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
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.normal,
              }}
            >
              Pick the manager signing off this count. Their email lands on the audit row.
            </p>
          </div>
          <ManagerPicker
            managers={managers}
            value={managerId}
            onChange={(id) => {
              setManagerId(id);
            }}
          />
        </div>

        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.input,
              background: '#FFEEEC',
              color: theme.color.alert,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

function ManagerPicker({
  managers,
  value,
  onChange,
}: {
  managers: ManagerRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (managers.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.warn }}>
        No managers configured. Add a Manager-flagged staff member in Admin, Staff first.
      </p>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => {
        const m = managers.find((mgr) => mgr.account_id === e.target.value);
        if (m) onChange(m.account_id);
      }}
      style={{
        appearance: 'none',
        height: theme.layout.inputHeight,
        background: theme.color.surface,
        borderRadius: theme.radius.input,
        border: `1px solid ${theme.color.border}`,
        padding: `0 ${theme.space[4]}px`,
        fontFamily: 'inherit',
        fontSize: theme.type.size.base,
        color: theme.color.ink,
      }}
    >
      <option value="" disabled>
        Pick a manager
      </option>
      {managers.map((m) => (
        <option key={m.account_id} value={m.account_id}>
          {m.name} ({m.login_email})
        </option>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Count details sheet — per-payment breakdown for a past count
// ─────────────────────────────────────────────────────────────────────────────

function CountDetailsSheet({
  countId,
  onClose,
}: {
  countId: string | null;
  onClose: () => void;
}) {
  const { data, loading, error } = useCashCountStatement(countId);
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      const blob = await buildCashCountPdf(data, { name: 'Venneir', addressLine: null });
      downloadCashCountPdf(blob, `cash_count_${data.count.period_end.slice(0, 10)}.pdf`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await logFailure({
        source: 'cash.statement.pdf',
        severity: 'error',
        message,
        context: { countId },
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <BottomSheet
      open={countId !== null}
      onClose={onClose}
      title={data ? `Count from ${formatLongDate(data.count.period_end)}` : 'Count details'}
      description={
        data
          ? `${formatLongDate(data.count.period_start)} to ${formatLongDate(data.count.period_end)}`
          : ''
      }
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
          <Button variant="tertiary" onClick={onClose}>
            Close
          </Button>
          {data ? (
            <Button variant="primary" onClick={onDownload} loading={downloading}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <Download size={14} aria-hidden /> Download PDF
              </span>
            </Button>
          ) : null}
        </div>
      }
    >
      {error ? (
        <p style={{ margin: 0, color: theme.color.alert }}>Could not load count: {error}</p>
      ) : loading || !data ? (
        <Skeleton height={120} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: theme.space[3],
            }}
          >
            <Stat label="Expected" value={formatPence(data.count.expected_pence)} />
            <Stat
              label="Counted"
              value={data.count.actual_pence === null ? '—' : formatPence(data.count.actual_pence)}
            />
            <Stat
              label="Difference"
              value={
                data.count.actual_pence === null
                  ? '—'
                  : data.count.variance_pence === 0
                    ? 'Matched'
                    : `${data.count.variance_pence > 0 ? '+' : '−'}${formatPence(Math.abs(data.count.variance_pence))}`
              }
              tone={
                data.count.variance_pence < 0
                  ? 'alert'
                  : data.count.variance_pence > 0
                    ? 'warn'
                    : 'normal'
              }
            />
          </div>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            Counted by{' '}
            <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
              {data.count.counted_by_name}
            </span>
            {data.count.signed_off_by_name ? (
              <>
                {' · '}
                Signed by{' '}
                <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
                  {data.count.signed_off_by_name}
                </span>
              </>
            ) : null}
          </p>
          {data.count.notes ? (
            <p
              style={{
                margin: 0,
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                background: theme.color.bg,
                fontSize: theme.type.size.sm,
                fontStyle: 'italic',
                color: theme.color.ink,
                lineHeight: theme.type.leading.snug,
              }}
            >
              "{data.count.notes}"
            </p>
          ) : null}
          <hr
            style={{
              border: 'none',
              borderTop: `1px solid ${theme.color.border}`,
              margin: 0,
            }}
          />
          <Section title={`Cash payments in this count (${formatNumber(data.lines.length)})`}>
            {data.lines.length === 0 ? (
              <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                No cash payments in this period.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.space[2],
                }}
              >
                {data.lines.map((l) => (
                  <li
                    key={l.payment_id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: theme.space[3],
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      borderRadius: theme.radius.input,
                      background: theme.color.bg,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.sm,
                          fontWeight: theme.type.weight.semibold,
                        }}
                      >
                        {l.patient_name}
                      </p>
                      <p
                        style={{
                          margin: `${theme.space[1]}px 0 0`,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkMuted,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatDateTime(l.taken_at)}
                        {l.appointment_ref ? ` · ${l.appointment_ref}` : ''}
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.semibold,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatPence(l.amount_pence)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {data.withdrawals.length > 0 ? (
            <Section title={`Cash taken from the safe in this period (${formatNumber(data.withdrawals.length)})`}>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: theme.space[2],
                }}
              >
                {data.withdrawals.map((w) => (
                  <li
                    key={w.withdrawal_id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: theme.space[3],
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      borderRadius: theme.radius.input,
                      background: theme.color.bg,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: theme.type.size.sm,
                          fontWeight: theme.type.weight.semibold,
                        }}
                      >
                        {withdrawalReasonLabel(w.reason)}
                        {w.taken_by_name ? <span style={{ color: theme.color.inkMuted, fontWeight: theme.type.weight.medium }}> · by {w.taken_by_name}</span> : null}
                      </p>
                      <p
                        style={{
                          margin: `${theme.space[1]}px 0 0`,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkMuted,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatDateTime(w.taken_at)}
                        {w.note ? ` · ${w.note}` : ''}
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.semibold,
                        color: theme.color.alert,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      −{formatPence(w.amount_pence)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveLocationId(): Promise<string> {
  // Single-location footprint: the cash count belongs to the
  // counter's location. If the accounts row has no location set, we
  // surface that as a loud error rather than guess.
  const { supabase } = await import('../lib/supabase.ts');
  const { data: me, error: meErr } = await supabase.rpc('auth_account_id');
  if (meErr) throw new Error(meErr.message);
  if (!me) throw new Error('Could not resolve current account.');
  const accRes = await supabase
    .from('accounts')
    .select('location_id')
    .eq('id', me as string)
    .maybeSingle();
  if (accRes.error) throw new Error(accRes.error.message);
  const loc = (accRes.data as { location_id: string | null } | null)?.location_id;
  if (!loc) {
    throw new Error("This account has no location set. Set the location on the staff member's record first.");
  }
  return loc;
}

function Stat({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warn' | 'alert';
}) {
  const colour =
    tone === 'alert' ? theme.color.alert : tone === 'warn' ? theme.color.warn : theme.color.ink;
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: 11,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: `${theme.space[1]}px 0 0`,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: colour,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </p>
    </div>
  );
}

function formatLongDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

