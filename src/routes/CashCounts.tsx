import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Info,
  ListChecks,
  Mail,
  Plus,
  Search,
  SearchCheck,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  Checkbox,
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
import { fmtTzAbbr } from '../lib/dateFormat.ts';
import {
  type CashCountRow,
  type CashPosition,
  type CashPositionPaymentLine,
  type UnrecordedEnvelopeInput,
  type WithdrawalReason,
  WITHDRAWAL_REASONS,
  createCashCount,
  recordCashWithdrawal,
  saveCashCountUnrecorded,
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
import { listActiveStaffNames, listSafeWitnesses, type SafeWitnessRow, type StaffNameRow } from '../lib/queries/staff.ts';
import { buildCashActivityPdf, buildCashCountPdf, downloadCashCountPdf } from '../lib/cashCountPdf.ts';
import {
  type CashClue,
  buildCashActivityCsv,
  buildEnvelopeListCsv,
  downloadTextFile,
  envelopeListSince,
  findDifferenceClues,
} from '../lib/cashReconcile.ts';
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
  // Two-person rule: the safe witnesses on record. Loaded once for the
  // page and shared by the Right-now card (so the rule is visible before
  // anyone opens the safe) and both sheets (which refuse to submit
  // without one picked). Null until loaded; an error is loud.
  const [witnesses, setWitnesses] = useState<SafeWitnessRow[] | null>(null);
  const [witnessesError, setWitnessesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listSafeWitnesses()
      .then((rows) => {
        if (!cancelled) setWitnesses(rows);
      })
      .catch(async (e) => {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled) setWitnessesError(message);
        await logFailure({ source: 'cash.witnesses', severity: 'error', message, context: {} });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // Safe holders and safe viewers only. Counting and taking are gated
  // by can_count_cash separately at the CTA.
  if (!account || (!account.can_count_cash && !account.can_view_safe)) {
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
            Every cash payment goes into the safe in an envelope. A count checks the safe
            against Lounge's records. Two people, on camera, every time.
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
              witnesses={witnesses}
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
                onExportCsv={() => exportActivityCsv(position.data!)}
                onExportPdf={() => void exportActivityPdf(position.data!)}
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
          witnesses={witnesses}
          witnessesError={witnessesError}
          kind={sheetKind}
          onExportCsv={() => exportActivityCsv(position.data!)}
          onExportPdf={() => void exportActivityPdf(position.data!)}
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
        witnesses={witnesses}
        witnessesError={witnessesError}
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
  witnesses,
  onStart,
  onTakeFromSafe,
}: {
  position: CashPosition;
  canCountCash: boolean;
  witnesses: SafeWitnessRow[] | null;
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
              {' '}{formatNumber(position.withdrawal_count)} withdrawal{position.withdrawal_count === 1 ? '' : 's'} out
              {position.refund_count > 0
                ? `, ${formatNumber(position.refund_count)} refund${position.refund_count === 1 ? '' : 's'} out`
                : ''}
              .
              {position.refunded_sale_count > 0
                ? ` ${formatNumber(position.refunded_sale_count)} refunded sale${position.refunded_sale_count === 1 ? '' : 's'} cancelled out and left the safe unchanged.`
                : ''}
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
          {last.witness_name ? ` · witnessed by ${last.witness_name}` : ''}
        </p>
      ) : null}

      {/* The two-person rule, stated before anyone reaches for the
          safe. Names the witness on record so there is no ambiguity
          about who has to be in the room. */}
      <p
        style={{
          margin: `${theme.space[2]}px 0 0`,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <ShieldCheck size={12} aria-hidden style={{ flexShrink: 0 }} />
        {witnesses === null
          ? 'Two people, on camera: a safe holder acts, the safe witness is present.'
          : witnesses.length === 0
            ? 'Two people, on camera: no safe witness is set up yet. Add one in Admin, Staff.'
            : `Two people, on camera: a safe holder acts, with ${joinNames(witnesses.map((w) => w.name))} present.`}
      </p>

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
  onExportCsv,
  onExportPdf,
}: {
  lines: CashPosition['lines'];
  baselinePence: number;
  onExportCsv: () => void;
  onExportPdf: () => void;
}) {
  const navigate = useNavigate();
  // Cash in = sales that kept their money. Cash out = withdrawals plus
  // real refunds (partial clawbacks / older-sale refunds). Refunded sales
  // net to zero and sit in neither total.
  const paymentTotal = useMemo(
    () => lines.reduce((sum, l) => (l.kind === 'payment' ? sum + l.amount_pence : sum), 0),
    [lines],
  );
  const cashOutTotal = useMemo(
    () => lines.reduce((sum, l) => (l.kind === 'withdrawal' || l.kind === 'refund' ? sum + l.amount_pence : sum), 0),
    [lines],
  );
  const refundedSaleCount = useMemo(
    () => lines.reduce((n, l) => (l.kind === 'refunded_sale' ? n + 1 : n), 0),
    [lines],
  );
  const openVisit = (visitId: string | null) => {
    if (!visitId) return;
    navigate(`/visit/${visitId}`);
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1], flex: '1 1 320px', minWidth: 0, maxWidth: 560 }}>
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
            Opening {formatPence(baselinePence)}. Every payment in and every withdrawal out since.
            {refundedSaleCount > 0
              ? ` A refunded sale came in and went straight back out, so it doesn't change the safe.`
              : ' Tap a payment row to open the visit.'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap', flexShrink: 0, alignSelf: 'flex-start' }}>
          <Button variant="tertiary" size="sm" onClick={onExportCsv}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <FileSpreadsheet size={14} aria-hidden /> Download CSV
            </span>
          </Button>
          <Button variant="tertiary" size="sm" onClick={onExportPdf}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <FileText size={14} aria-hidden /> Download PDF
            </span>
          </Button>
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
          const key =
            line.kind === 'payment' || line.kind === 'refunded_sale'
              ? line.payment_id
              : line.kind === 'refund'
                ? line.refund_id
                : line.withdrawal_id;
          const visitLink = line.kind === 'payment' || line.kind === 'refunded_sale' ? line.visit_id : null;
          const interactive = !!visitLink;
          // Three visual variants: money in (green +), money out (red −,
          // covers withdrawals and real refunds), and a refunded sale
          // (neutral, struck-through, tagged — it nets to nothing).
          const variant: 'in' | 'out' | 'refunded' =
            line.kind === 'payment' ? 'in' : line.kind === 'refunded_sale' ? 'refunded' : 'out';
          // Mobile-first 2-line layout:
          //   Line 1 (top):    Label + tag (left)     · Amount (right)
          //   Line 2 (bottom): Time + context (muted) · Chevron
          const middleLabel =
            line.kind === 'withdrawal'
              ? withdrawalReasonLabel(line.reason)
              : line.kind === 'refund'
                ? 'Cash refund'
                : (line.patient_name || 'Unknown patient');
          const subParts: string[] = [formatDateTime(line.taken_at)];
          if (line.kind === 'withdrawal') {
            if (line.taken_by_name) subParts.push(`by ${line.taken_by_name}`);
            if (line.witness_name) subParts.push(`witnessed by ${line.witness_name}`);
          } else if (line.kind === 'payment') {
            if (line.appointment_ref) subParts.push(line.appointment_ref);
            subParts.push(`by ${line.taken_by_name}`);
          } else if (line.kind === 'refunded_sale') {
            subParts.push('In and refunded');
          } else if (line.kind === 'refund') {
            if (line.patient_name) subParts.push(line.patient_name);
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
                onClick={() => openVisit(visitLink)}
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
                      display: 'flex',
                      alignItems: 'center',
                      gap: theme.space[2],
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.semibold,
                        color: variant === 'refunded' ? theme.color.inkMuted : theme.color.ink,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {middleLabel}
                    </span>
                    {variant === 'refunded' ? (
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: theme.type.size.xs,
                          fontWeight: theme.type.weight.semibold,
                          color: theme.color.inkMuted,
                          background: theme.color.bg,
                          padding: `2px ${theme.space[2]}px`,
                          borderRadius: theme.radius.pill,
                        }}
                      >
                        Refunded
                      </span>
                    ) : null}
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
                    color:
                      variant === 'in'
                        ? theme.color.accent
                        : variant === 'out'
                          ? theme.color.alert
                          : theme.color.inkSubtle,
                    textDecoration: variant === 'refunded' ? 'line-through' : 'none',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {variant === 'in' ? '+' : variant === 'out' ? '−' : ''}
                  {formatPence(line.amount_pence)}
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
            {formatPence(cashOutTotal)}
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
  witnesses,
  witnessesError,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  currentExpectedPence: number;
  witnesses: SafeWitnessRow[] | null;
  witnessesError: string | null;
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
  const twoPerson = useTwoPersonState(open, witnesses, currentAccountId);

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
    const rule = twoPerson.validate();
    if (rule) {
      setError(rule);
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
        witness_id: twoPerson.witnessId!,
        on_camera: true,
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
        witnessName: twoPerson.witnessName,
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
      description="Record cash physically leaving the safe: bank deposit, float top-up, petty cash, owner draw, or another reason. Two people, on camera. The running balance drops by this amount and the configured managers get an email for their records."
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

        <TwoPersonBlock state={twoPerson} witnessesError={witnessesError} action="withdrawal" />

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
// Two-person rule — shared by Count cash and Take from safe
//
// The safe is only ever opened by a safe holder, in front of the camera,
// with the safe witness physically present. No codes: the record is who
// acted, who was present, and that the camera was on. Both sheets refuse
// to submit until the witness is picked and both confirmations are
// ticked, and the database refuses the row regardless (migration
// 20260907000012), so the rule holds even if the UI is bypassed.
// ─────────────────────────────────────────────────────────────────────────────

interface TwoPersonState {
  candidates: SafeWitnessRow[];
  loaded: boolean;
  witnessId: string | null;
  witnessName: string | null;
  setWitnessId: (id: string) => void;
  present: boolean;
  setPresent: (v: boolean) => void;
  onCamera: boolean;
  setOnCamera: (v: boolean) => void;
  /** Plain-English reason the rule is not yet satisfied, or null. */
  validate: () => string | null;
}

function useTwoPersonState(
  open: boolean,
  witnesses: SafeWitnessRow[] | null,
  currentAccountId: string | null,
): TwoPersonState {
  // The actor can never witness their own action.
  const candidates = useMemo(
    () => (witnesses ?? []).filter((w) => w.account_id !== currentAccountId),
    [witnesses, currentAccountId],
  );
  const [witnessId, setWitnessId] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [onCamera, setOnCamera] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPresent(false);
    setOnCamera(false);
    // One witness on record: pre-select, nothing to choose. More than
    // one: the sheet asks.
    setWitnessId(candidates.length === 1 ? candidates[0]!.account_id : null);
  }, [open, candidates]);
  const witnessName = candidates.find((w) => w.account_id === witnessId)?.name ?? null;
  const validate = () => {
    if (witnesses === null) return 'Still loading the safe witnesses. Try again in a moment.';
    if (candidates.length === 0) {
      return 'No safe witness is set up, so the safe cannot be opened. Ask the super admin to flag the witness in Admin, Staff.';
    }
    if (!witnessId) return 'Pick the safe witness who is in the room.';
    if (!present) return `Confirm that ${witnessName ?? 'the safe witness'} is here, watching the safe.`;
    if (!onCamera) return 'Confirm the camera is on and pointed at the safe.';
    return null;
  };
  return {
    candidates,
    loaded: witnesses !== null,
    witnessId,
    witnessName,
    setWitnessId,
    present,
    setPresent,
    onCamera,
    setOnCamera,
    validate,
  };
}

function TwoPersonBlock({
  state,
  witnessesError,
  action,
}: {
  state: TwoPersonState;
  witnessesError: string | null;
  action: 'count' | 'withdrawal';
}) {
  const noun = action === 'count' ? 'count' : 'withdrawal';
  return (
    <SheetBlock
      title="Two people, on camera"
      sub={`The safe is only opened with the safe witness physically present and the camera on. Both are recorded on this ${noun}.`}
      icon={<ShieldCheck size={16} aria-hidden />}
    >
      {witnessesError ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
          Could not load the safe witnesses: {witnessesError}
        </p>
      ) : !state.loaded ? (
        <Skeleton height={56} />
      ) : state.candidates.length === 0 ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.warn }}>
          No safe witness is set up, so the safe cannot be opened. Ask the super admin to flag the witness in Admin, Staff.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {state.candidates.length > 1 ? (
            <DropdownSelect
              label="Who is the witness?"
              value={state.witnessId ?? ''}
              onChange={(v) => state.setWitnessId(v)}
              options={state.candidates.map((w) => ({ value: w.account_id, label: w.name }))}
            />
          ) : null}
          <ConfirmRow
            checked={state.present}
            onChange={state.setPresent}
            disabled={!state.witnessId}
            label={`${state.witnessName ?? 'The safe witness'} is here, watching the safe`}
            sub="Physically present in the room for the whole time the safe is open."
          />
          <ConfirmRow
            checked={state.onCamera}
            onChange={state.setOnCamera}
            label="The camera is on and pointed at the safe"
            sub="Recorded on this action so it can be matched to the footage."
          />
        </div>
      )}
    </SheetBlock>
  );
}

// A full-width, touch-sized confirmation row: checkbox, statement, and
// a quieter line underneath. Reads as a declaration, not a form field.
function ConfirmRow({
  checked,
  onChange,
  label,
  sub,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      style={{
        appearance: 'none',
        fontFamily: 'inherit',
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        minHeight: theme.layout.minTouchTarget + 8,
        borderRadius: theme.radius.input,
        background: checked ? theme.color.accentBg : theme.color.surface,
        border: `1px solid ${checked ? theme.color.accent : theme.color.border}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span style={{ pointerEvents: 'none', display: 'inline-flex' }}>
        <Checkbox checked={checked} onChange={() => undefined} ariaLabel={label} size={24} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.snug }}>
          {sub}
        </span>
      </span>
    </button>
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
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
          {count.signed_off_by_name && count.signed_off_by_name !== count.witness_name ? (
            <>
              {' · '}
              Signed by <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>{count.signed_off_by_name}</span>
            </>
          ) : null}
          {count.witness_name ? (
            <>
              {' · '}
              Witnessed by <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>{count.witness_name}</span>
              {count.on_camera ? ', on camera' : ''}
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
//
// Deliberately short. Top to bottom:
//
//   1. Expected in safe — what Lounge has recorded.
//   2. Counted in safe — one total, typed.
//   3. The difference, in plain English.
//      More than expected: every cash payment went into the safe in an
//      envelope marked with the order number and the customer's name, so
//      the counter downloads the envelope list, matches each envelope,
//      and logs the leftovers (order number, customer, amount, who
//      processed it) on this count for Dylan to review.
//      Less than expected: the recorded evidence that could explain it
//      (see cashReconcile.ts) and the same envelope list to tick off.
//   4. Note — required above the variance threshold unless the logged
//      envelopes explain the whole difference.
//   5. Two people, on camera — the safe witness is the second person and
//      signs the count. There is no separate manager step.
// ─────────────────────────────────────────────────────────────────────────────

interface EnvelopeDraft {
  key: number;
  order_ref: string;
  customer_name: string;
  amountText: string;
  processed_by: string;
}

function envelopeAmountPence(text: string): number | null {
  if (text.trim().length === 0) return null;
  const float = Number(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(float) || float <= 0) return null;
  return Math.round(float * 100);
}

function NewCountSheet({
  open,
  onClose,
  position,
  thresholds,
  currentAccountId,
  witnesses,
  witnessesError,
  onSigned,
  onExportCsv,
  onExportPdf,
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
  witnesses: SafeWitnessRow[] | null;
  witnessesError: string | null;
  onSigned: () => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
  // 'legacy_baseline' is the explicit launch / re-launch reset path
  // triggered from Admin → Testing → Legacy cash count. Functionally
  // identical to a regular count, but the sheet copy reads "Start fresh"
  // and the row's `kind` column lets the history list label the row as
  // a baseline reset rather than a routine reconciliation.
  kind?: 'regular' | 'legacy_baseline';
}) {
  const isMobile = useIsMobile(640);
  const [actualText, setActualText] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedPayments, setCheckedPayments] = useState<Set<string>>(new Set());
  const [envelopes, setEnvelopes] = useState<EnvelopeDraft[]>([]);
  const [staffNames, setStaffNames] = useState<StaffNameRow[]>([]);
  const twoPerson = useTwoPersonState(open, witnesses, currentAccountId);
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
    setError(null);
    setCheckedPayments(new Set());
    setEnvelopes([]);
    setInlineWithdrawalOpen(false);
    setInlineWithdrawalAmountText('');
    setInlineWithdrawalReason('bank_deposit');
    setInlineWithdrawalNote('');
    // Staff list for "who processed this envelope". Loaded on open so a
    // new starter added this morning is in the list tonight.
    listActiveStaffNames()
      .then(setStaffNames)
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Could not load the staff list: ${message}`);
      });
  }, [open]);

  const periodStart = useMemo(() => {
    if (position.last_signed_count) return position.last_signed_count.period_end;
    if (position.earliest_payment_at) return position.earliest_payment_at;
    return new Date(0).toISOString();
  }, [position]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const periodEnd = useMemo(() => new Date().toISOString(), [open]);

  const isLegacyBaseline = kind === 'legacy_baseline';

  const actualPence = useMemo(() => {
    if (actualText.trim().length === 0) return null;
    const float = Number(actualText.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(float)) return null;
    return Math.round(float * 100);
  }, [actualText]);

  const inlineWithdrawalPence = useMemo(() => {
    if (!isLegacyBaseline || !inlineWithdrawalOpen) return null;
    return envelopeAmountPence(inlineWithdrawalAmountText);
  }, [isLegacyBaseline, inlineWithdrawalOpen, inlineWithdrawalAmountText]);

  const diff = actualPence === null || isLegacyBaseline ? null : actualPence - position.expected_in_safe_pence;
  const over = diff !== null && diff > 0;
  const short = diff !== null && diff < 0;

  // Money the logged envelopes account for, and what is still unexplained.
  const envelopesPence = useMemo(
    () => envelopes.reduce((s, e) => s + (envelopeAmountPence(e.amountText) ?? 0), 0),
    [envelopes],
  );
  const unexplainedPence = over ? diff - envelopesPence : diff ?? 0;

  // Note is required above the threshold, unless the envelopes explain
  // every penny of a surplus (the envelopes ARE the explanation).
  const diffNeedsNote =
    thresholds !== null
    && diff !== null
    && diff !== 0
    && Math.abs(unexplainedPence) >= thresholds.cash_variance_pence;

  // Detective work. For a shortfall the full engine; for a surplus only
  // the strong leads, shown under the envelope log as a nudge.
  const clues = useMemo<CashClue[]>(() => {
    if (diff === null || diff === 0) return [];
    const all = findDifferenceClues({ diff_pence: diff, position });
    return over ? all.filter((c) => c.tone === 'strong' && c.kind !== 'pence') : all;
  }, [diff, over, position]);

  const paymentLines = useMemo(
    () => position.lines.filter((l): l is CashPositionPaymentLine => l.kind === 'payment'),
    [position.lines],
  );

  const addEnvelope = () =>
    setEnvelopes((prev) => [
      ...prev,
      { key: Date.now() + prev.length, order_ref: '', customer_name: '', amountText: '', processed_by: '' },
    ]);
  const updateEnvelope = (key: number, patch: Partial<EnvelopeDraft>) =>
    setEnvelopes((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  const removeEnvelope = (key: number) => setEnvelopes((prev) => prev.filter((e) => e.key !== key));

  const submit = async () => {
    setError(null);
    if (actualPence === null || actualPence < 0) {
      setError('Enter the total counted in the safe, in pounds, e.g. 405.00.');
      return;
    }
    // Every logged envelope must be complete: what it said, how much was
    // in it, who processed it. Half a record is worse than none.
    const envelopeInputs: UnrecordedEnvelopeInput[] = [];
    for (let i = 0; i < envelopes.length; i += 1) {
      const e = envelopes[i]!;
      const pence = envelopeAmountPence(e.amountText);
      if (!e.order_ref.trim() && !e.customer_name.trim()) {
        setError(`Envelope ${i + 1}: enter the order number or the customer's name written on it.`);
        return;
      }
      if (pence === null) {
        setError(`Envelope ${i + 1}: enter the amount that was inside it.`);
        return;
      }
      if (!e.processed_by) {
        setError(`Envelope ${i + 1}: pick the employee who processed it.`);
        return;
      }
      envelopeInputs.push({
        amount_pence: pence,
        order_ref: e.order_ref.trim() || null,
        customer_name: e.customer_name.trim() || null,
        processed_by: e.processed_by,
      });
    }
    if (over && envelopesPence > diff) {
      setError(
        `The envelopes you logged add up to ${formatPence(envelopesPence)}, more than the ${formatPence(diff)} extra. Check the amounts.`,
      );
      return;
    }
    if (diffNeedsNote && notes.trim().length === 0) {
      setError(
        over
          ? `${formatPence(unexplainedPence)} of the extra is still unexplained. Log the envelopes it came from, or add a note saying what it is.`
          : `That's over the ${formatPence(thresholds!.cash_variance_pence)} threshold for unexplained differences. Add a quick note about what happened.`,
      );
      return;
    }
    const rule = twoPerson.validate();
    if (rule) {
      setError(rule);
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
    if (isLegacyBaseline && inlineWithdrawalOpen) {
      if (inlineWithdrawalPence === null) {
        setError('Enter the withdrawal amount in pounds, e.g. 400.00.');
        return;
      }
      if (inlineWithdrawalPence > actualPence) {
        setError(`Withdrawal can't exceed the starting balance (${formatPence(actualPence)}).`);
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
        witness_id: twoPerson.witnessId!,
        on_camera: true,
      });
      pendingCountId = created.count_id;
      await updateCashCountActual(created.count_id, actualPence, notes);
      if (envelopeInputs.length > 0) {
        await saveCashCountUnrecorded(created.count_id, envelopeInputs);
      }
      // The safe witness is the second person and signs the count.
      await signCashCount({
        count_id: created.count_id,
        signer_account_id: twoPerson.witnessId!,
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
          witness_id: twoPerson.witnessId!,
          on_camera: true,
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
          witnessName: twoPerson.witnessName,
        });
      }
      onSigned();
    } catch (e) {
      // Roll back a pending count so the next retry isn't blocked
      // by orphan history. Best-effort; if the delete fails too
      // (RLS, network) we still surface the original error. Envelope
      // rows cascade with the count.
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
        context: { actualPence, periodStart, periodEnd, envelopes: envelopeInputs.length },
      });
    } finally {
      setBusy(false);
    }
  };

  const envelopeList = useMemo(() => envelopeListSince(position), [position]);

  return (
    <BottomSheet
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title={kind === 'legacy_baseline' ? 'Legacy cash count — start fresh' : 'Count cash'}
      description={
        kind === 'legacy_baseline'
          ? 'Count what is physically in the safe right now, with the safe witness present and the camera on. This becomes the baseline. Every count after this starts from this point.'
          : 'Count the cash in the safe with the safe witness present and the camera on. Enter the total; Lounge shows any difference and how to account for it.'
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
                ? `Opening ${formatPence(position.baseline_pence)} from the count on ${formatLongDate(position.last_signed_count.period_end)}, plus ${formatNumber(position.payment_count)} cash payment${position.payment_count === 1 ? '' : 's'} in, minus ${formatNumber(position.withdrawal_count + position.refund_count)} taken out since.`
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
          placeholder="e.g. 1949.00"
          autoFocus
          fullWidth
        />

        {diff !== null ? (
          <DifferencePanel
            diff={diff}
            actualPence={actualPence ?? 0}
            expectedPence={position.expected_in_safe_pence}
            thresholdPence={thresholds?.cash_variance_pence ?? null}
            explainedPence={over ? envelopesPence : 0}
          />
        ) : null}

        {over ? (
          <ExtraCashBlock
            diffPence={diff}
            envelopes={envelopes}
            staffNames={staffNames}
            onAdd={addEnvelope}
            onUpdate={updateEnvelope}
            onRemove={removeEnvelope}
            envelopesPence={envelopesPence}
            envelopeCount={envelopeList.rows.length}
            envelopeSince={envelopeList.since}
            onDownloadList={() => exportEnvelopeListCsv(position)}
            isMobile={isMobile}
            disabled={busy}
            clues={clues}
          />
        ) : null}

        {short ? (
          <SheetBlock
            title="Find the difference"
            sub="Lounge checked everything recorded in this period for something that explains it."
            icon={<SearchCheck size={16} aria-hidden />}
          >
            <ClueList clues={clues} />
          </SheetBlock>
        ) : null}

        {over || short ? (
          <PaymentChecklist
            lines={paymentLines}
            checked={checkedPayments}
            onToggle={(id) =>
              setCheckedPayments((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onExportCsv={onExportCsv}
            onExportPdf={onExportPdf}
          />
        ) : null}

        <Input
          label={diffNeedsNote ? 'Note (required)' : 'Note (optional)'}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            isLegacyBaseline
              ? 'Optional context, e.g. cash collected pre-launch.'
              : over
                ? 'Anything else about the extra, e.g. loose coins that were not in an envelope.'
                : short
                  ? 'What explains the shortfall?'
                  : 'Anything worth noting about this count.'
          }
          fullWidth
        />

        {isLegacyBaseline ? (
          <SheetBlock
            title="Also record a withdrawal"
            sub="Optional. If part of the starting balance is about to leave the safe (banking, float top-up, etc.), log it here in the same step. It drops off the running balance the moment this is signed."
            aside={
              <Button
                variant={inlineWithdrawalOpen ? 'tertiary' : 'secondary'}
                size="sm"
                onClick={() => setInlineWithdrawalOpen((v) => !v)}
              >
                {inlineWithdrawalOpen ? 'Not now' : 'Add'}
              </Button>
            }
          >
            {inlineWithdrawalOpen ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
                <Input
                  label="Amount taken (£)"
                  numericFormat="currency"
                  value={inlineWithdrawalAmountText}
                  onChange={(e) => setInlineWithdrawalAmountText(e.target.value)}
                  placeholder="e.g. 400.00"
                  fullWidth
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
                  fullWidth
                />
              </div>
            ) : null}
          </SheetBlock>
        ) : null}

        <TwoPersonBlock state={twoPerson} witnessesError={witnessesError} action="count" />

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

// ─────────────────────────────────────────────────────────────────────────────
// Extra cash — the envelope log
//
// Every cash payment goes into the safe in an envelope with the order
// number and the customer's name on it. A surplus means an envelope (or
// loose cash) that Lounge never recorded. The counter downloads the
// list of what SHOULD be there, ticks each envelope off, and logs the
// leftovers here: what the envelope says, how much was inside, and
// which employee processed it. Saved on the count for review.
// ─────────────────────────────────────────────────────────────────────────────

function ExtraCashBlock({
  diffPence,
  envelopes,
  staffNames,
  onAdd,
  onUpdate,
  onRemove,
  envelopesPence,
  envelopeCount,
  envelopeSince,
  onDownloadList,
  isMobile,
  disabled,
  clues,
}: {
  diffPence: number;
  envelopes: EnvelopeDraft[];
  staffNames: StaffNameRow[];
  onAdd: () => void;
  onUpdate: (key: number, patch: Partial<EnvelopeDraft>) => void;
  onRemove: (key: number) => void;
  envelopesPence: number;
  envelopeCount: number;
  envelopeSince: string;
  onDownloadList: () => void;
  isMobile: boolean;
  disabled: boolean;
  clues: CashClue[];
}) {
  const remaining = diffPence - envelopesPence;
  const explained = remaining === 0 && envelopes.length > 0;
  const steps = [
    `Take every envelope out of the safe.`,
    `Download the envelope list: the ${formatNumber(envelopeCount)} cash payment${envelopeCount === 1 ? '' : 's'} recorded since cash was last taken out on ${formatLongDate(envelopeSince)}. Tick each envelope off against its order number and name.`,
    `Any envelope left over was never recorded in Lounge. Log it below, exactly as written on it, with the employee who processed it.`,
  ];
  return (
    <SheetBlock
      title="Log where the extra came from"
      sub={`There is ${formatPence(diffPence)} in the safe that Lounge has no record of.`}
      icon={<Mail size={16} aria-hidden />}
      aside={
        <Button variant="secondary" size="sm" onClick={onDownloadList}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <FileSpreadsheet size={14} aria-hidden /> Download envelope list
          </span>
        </Button>
      }
    >
      <ol
        style={{
          margin: 0,
          paddingLeft: theme.space[5],
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[2],
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.normal,
        }}
      >
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>

      {envelopes.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {envelopes.map((e, idx) => (
            <li
              key={e.key}
              style={{
                padding: theme.space[4],
                borderRadius: theme.radius.input,
                background: theme.color.surface,
                border: `1px solid ${theme.color.border}`,
                display: 'flex',
                flexDirection: 'column',
                gap: theme.space[3],
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.space[3] }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.inkMuted,
                    textTransform: 'uppercase',
                    letterSpacing: theme.type.tracking.wide,
                  }}
                >
                  Envelope {idx + 1}
                </span>
                <Button variant="tertiary" size="sm" onClick={() => onRemove(e.key)} disabled={disabled}>
                  Remove
                </Button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: theme.space[3] }}>
                <Input
                  label="Order number on the envelope"
                  value={e.order_ref}
                  onChange={(ev) => onUpdate(e.key, { order_ref: ev.target.value })}
                  placeholder="e.g. LAP-01064"
                  fullWidth
                  disabled={disabled}
                />
                <Input
                  label="Customer name on the envelope"
                  value={e.customer_name}
                  onChange={(ev) => onUpdate(e.key, { customer_name: ev.target.value })}
                  placeholder="As written"
                  fullWidth
                  disabled={disabled}
                />
                <Input
                  label="Amount inside (£)"
                  numericFormat="currency"
                  value={e.amountText}
                  onChange={(ev) => onUpdate(e.key, { amountText: ev.target.value })}
                  placeholder="e.g. 70.00"
                  fullWidth
                  disabled={disabled}
                />
                <DropdownSelect
                  label="Employee who processed it"
                  value={e.processed_by}
                  onChange={(v) => onUpdate(e.key, { processed_by: v })}
                  placeholder="Pick the employee"
                  options={staffNames.map((s) => ({ value: s.account_id, label: s.name }))}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: explained ? theme.color.accent : remaining < 0 ? theme.color.alert : theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {envelopes.length === 0
            ? `Nothing logged yet. ${formatPence(diffPence)} to account for.`
            : explained
              ? `All ${formatPence(diffPence)} accounted for by ${formatNumber(envelopes.length)} envelope${envelopes.length === 1 ? '' : 's'}.`
              : remaining < 0
                ? `Envelopes add up to ${formatPence(envelopesPence)}, more than the ${formatPence(diffPence)} extra.`
                : `${formatPence(envelopesPence)} logged · ${formatPence(remaining)} still to account for.`}
        </span>
        <Button variant={envelopes.length === 0 ? 'primary' : 'secondary'} size="sm" onClick={onAdd} disabled={disabled}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <Plus size={14} aria-hidden /> {envelopes.length === 0 ? 'Log an envelope' : 'Log another envelope'}
          </span>
        </Button>
      </div>

      {clues.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Lounge also spotted
          </span>
          <ClueList clues={clues} />
        </div>
      ) : null}
    </SheetBlock>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet building blocks
// ─────────────────────────────────────────────────────────────────────────────

// One bordered section of the count sheet: title, helper sentence,
// optional control on the right, content below. Every section uses
// it so the vertical rhythm is identical top to bottom.
function SheetBlock({
  title,
  sub,
  aside,
  icon,
  children,
}: {
  title: string;
  sub?: string;
  aside?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
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
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 200 }}>
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[2],
            }}
          >
            {icon ? <span style={{ color: theme.color.accent, display: 'inline-flex' }}>{icon}</span> : null}
            {title}
          </h3>
          {sub ? (
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.normal,
              }}
            >
              {sub}
            </p>
          ) : null}
        </div>
        {aside ? <div style={{ flexShrink: 0 }}>{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

// The plain-English verdict: matched, over, or short. Sits between the
// count and the detective work so a passer-by reads "counted, expected,
// difference" in one glance.
function DifferencePanel({
  diff,
  actualPence,
  expectedPence,
  thresholdPence,
  explainedPence = 0,
}: {
  diff: number;
  actualPence: number;
  expectedPence: number;
  thresholdPence: number | null;
  /** Surplus already accounted for by logged envelopes. */
  explainedPence?: number;
}) {
  const matched = diff === 0;
  const over = diff > 0;
  const fullyExplained = over && explainedPence === diff;
  const colour = matched || fullyExplained ? theme.color.accent : over ? theme.color.warn : theme.color.alert;
  const background = matched || fullyExplained ? theme.color.accentBg : over ? '#FFF6E5' : '#FFEEEC';
  const overThreshold = thresholdPence !== null && Math.abs(diff - (over ? explainedPence : 0)) >= thresholdPence;
  return (
    <div
      role="status"
      style={{
        padding: theme.space[5],
        borderRadius: theme.radius.input,
        background,
        border: `1px solid ${theme.color.border}`,
        display: 'flex',
        gap: theme.space[4],
        alignItems: 'flex-start',
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
          background: theme.color.surface,
          color: colour,
          flexShrink: 0,
        }}
      >
        {matched || fullyExplained ? <CheckCircle2 size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1], minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: colour,
            letterSpacing: theme.type.tracking.tight,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: theme.type.leading.tight,
          }}
        >
          {matched
            ? 'Matches what Lounge expected'
            : `${formatPence(Math.abs(diff))} ${over ? 'more' : 'less'} than expected${fullyExplained ? ', all accounted for' : ''}`}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.normal,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {matched
            ? `You counted ${formatPence(actualPence)}, exactly what the records say. Nothing to explain.`
            : over
              ? `You counted ${formatPence(actualPence)}. The records say ${formatPence(expectedPence)}. There is more cash in the safe than Lounge knows about: an envelope went in without its payment being recorded.`
              : `You counted ${formatPence(actualPence)}. The records say ${formatPence(expectedPence)}. There is less cash in the safe than Lounge expects, so some recorded cash never reached it or left without being recorded.`}
          {!matched && !fullyExplained && overThreshold ? ' A note is required before this can be signed.' : ''}
        </p>
      </div>
    </div>
  );
}

// The findings from cashReconcile, one row per clue. Strong clues get
// the green tick, possibilities the amber magnifier, context the grey i.
function ClueList({ clues }: { clues: CashClue[] }) {
  if (clues.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
        Nothing to check yet.
      </p>
    );
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      {clues.map((clue, idx) => {
        const colour =
          clue.tone === 'strong' ? theme.color.accent : clue.tone === 'possible' ? theme.color.warn : theme.color.inkMuted;
        const Icon = clue.tone === 'strong' ? CheckCircle2 : clue.tone === 'possible' ? Search : Info;
        return (
          <li
            key={`${clue.kind}-${idx}`}
            style={{
              display: 'flex',
              gap: theme.space[3],
              alignItems: 'flex-start',
              padding: theme.space[4],
              borderRadius: theme.radius.input,
              background: theme.color.surface,
              border: `1px solid ${theme.color.border}`,
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: theme.radius.pill,
                background: theme.color.bg,
                color: colour,
                flexShrink: 0,
              }}
            >
              <Icon size={15} aria-hidden />
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], minWidth: 0, flex: 1 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  lineHeight: theme.type.leading.snug,
                }}
              >
                {clue.title}
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  lineHeight: theme.type.leading.normal,
                }}
              >
                {clue.detail}
              </p>
              {clue.matches.length > 0 ? (
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
                  {clue.matches.map((set, setIdx) => (
                    <li
                      key={setIdx}
                      style={{
                        borderRadius: theme.radius.input,
                        background: theme.color.bg,
                        padding: `${theme.space[2]}px ${theme.space[3]}px`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: theme.space[1],
                      }}
                    >
                      {set.map((m, mIdx) => (
                        <div
                          key={`${m.visit_id ?? m.label}-${mIdx}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            gap: theme.space[3],
                          }}
                        >
                          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                            <span
                              style={{
                                fontSize: theme.type.size.sm,
                                fontWeight: theme.type.weight.medium,
                                color: theme.color.ink,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {m.label}
                            </span>
                            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>{m.sub}</span>
                          </span>
                          <span
                            style={{
                              fontSize: theme.type.size.sm,
                              fontWeight: theme.type.weight.semibold,
                              color: theme.color.ink,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatPence(m.amount_pence)}
                          </span>
                        </div>
                      ))}
                      {set.length > 1 ? (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            borderTop: `1px solid ${theme.color.border}`,
                            paddingTop: theme.space[1],
                            fontSize: theme.type.size.xs,
                            color: theme.color.inkMuted,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          <span>Together</span>
                          <span>{formatPence(set.reduce((s, m) => s + m.amount_pence, 0))}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Every recorded cash payment in the period, tickable one by one
// against receipts. Progress reads in money as well as count, because
// "£320 still to check" is the number that matters at the safe.
function PaymentChecklist({
  lines,
  checked,
  onToggle,
  onExportCsv,
  onExportPdf,
}: {
  lines: CashPositionPaymentLine[];
  checked: Set<string>;
  onToggle: (paymentId: string) => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = lines.reduce((s, l) => s + l.amount_pence, 0);
  const checkedTotal = lines.reduce((s, l) => (checked.has(l.payment_id) ? s + l.amount_pence : s), 0);
  const remaining = total - checkedTotal;
  const done = lines.length > 0 && checked.size === lines.length;
  return (
    <SheetBlock
      title="Tick off each envelope"
      sub={`${formatNumber(lines.length)} cash payment${lines.length === 1 ? '' : 's'} recorded since the last count, each one an envelope. Tick each off as you match it by order number and name. Download the full statement to check on paper.`}
      icon={<ListChecks size={16} aria-hidden />}
      aside={
        <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
          <Button variant="tertiary" size="sm" onClick={onExportCsv}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <FileSpreadsheet size={14} aria-hidden /> CSV
            </span>
          </Button>
          <Button variant="tertiary" size="sm" onClick={onExportPdf}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <FileText size={14} aria-hidden /> PDF
            </span>
          </Button>
        </div>
      }
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: done ? theme.color.accent : theme.color.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {done
            ? `All ${formatNumber(lines.length)} envelopes matched, ${formatPence(total)} accounted for.`
            : `${formatNumber(checked.size)} of ${formatNumber(lines.length)} envelopes matched · ${formatPence(remaining)} still to match`}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide the list' : 'Show the list'}
        </Button>
      </div>
      {expanded ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            overflow: 'hidden',
            background: theme.color.surface,
          }}
        >
          {lines.map((l, idx) => {
            const isChecked = checked.has(l.payment_id);
            return (
              <li
                key={l.payment_id}
                style={{
                  borderTop: idx === 0 ? 'none' : `1px solid ${theme.color.border}`,
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                  opacity: isChecked ? 0.55 : 1,
                  transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                }}
              >
                <Checkbox
                  checked={isChecked}
                  onChange={() => onToggle(l.payment_id)}
                  ariaLabel={`${l.patient_name}, ${formatPence(l.amount_pence)}, checked`}
                />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontSize: theme.type.size.sm,
                      fontWeight: theme.type.weight.semibold,
                      color: theme.color.ink,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textDecoration: isChecked ? 'line-through' : 'none',
                    }}
                  >
                    {l.patient_name}
                  </span>
                  <span
                    style={{
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {[l.appointment_ref, formatDateTime(l.taken_at), `by ${l.taken_by_name}`]
                      .filter((s): s is string => !!s)
                      .join(' · ')}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: theme.type.size.base,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatPence(l.amount_pence)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SheetBlock>
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
            {data.count.signed_off_by_name && data.count.signed_off_by_name !== data.count.witness_name ? (
              <>
                {' · '}
                Signed by{' '}
                <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
                  {data.count.signed_off_by_name}
                </span>
              </>
            ) : null}
            {data.count.witness_name ? (
              <>
                {' · '}
                Witnessed by{' '}
                <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
                  {data.count.witness_name}
                </span>
                {data.count.on_camera ? ', on camera' : ''}
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
          {data.unrecorded.length > 0 ? (
            <Section
              title={`Envelopes not recorded in Lounge (${formatNumber(data.unrecorded.length)})`}
              sub="Found in the safe at this count with no matching payment. Logged exactly as written on the envelope, with the employee who processed it."
            >
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
                {data.unrecorded.map((u) => (
                  <li
                    key={u.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: theme.space[3],
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      borderRadius: theme.radius.input,
                      background: '#FFF6E5',
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
                        {[u.order_ref, u.customer_name].filter((x): x is string => !!x).join(' · ')}
                      </p>
                      <p
                        style={{
                          margin: `${theme.space[1]}px 0 0`,
                          fontSize: theme.type.size.xs,
                          color: theme.color.inkMuted,
                        }}
                      >
                        {u.processed_by_name ? `Processed by ${u.processed_by_name}` : 'Processed by unknown'}
                        {u.note ? ` · ${u.note}` : ''}
                      </p>
                    </div>
                    <span
                      style={{
                        fontSize: theme.type.size.sm,
                        fontWeight: theme.type.weight.semibold,
                        color: theme.color.warn,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      +{formatPence(u.amount_pence)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
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

// Exports of the current period. The CSV is a statement with a running
// balance and a blank Checked column; the PDF is the same as a printed
// working sheet with tick boxes. Both are built from the same
// authoritative position the page renders.
function exportActivityCsv(position: CashPosition): void {
  try {
    const csv = buildCashActivityCsv(position);
    downloadTextFile(csv, `cash_since_last_count_${position.period_end.slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    void logFailure({
      source: 'cash.activity.csv',
      severity: 'error',
      message,
      context: { period_end: position.period_end },
    });
  }
}

// The envelope list: recorded cash payments since cash was last taken
// out, one row per envelope that should be in the safe.
function exportEnvelopeListCsv(position: CashPosition): void {
  try {
    const csv = buildEnvelopeListCsv(position);
    downloadTextFile(csv, `envelopes_in_safe_${position.period_end.slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    void logFailure({
      source: 'cash.envelopes.csv',
      severity: 'error',
      message,
      context: { period_end: position.period_end },
    });
  }
}

async function exportActivityPdf(position: CashPosition): Promise<void> {
  try {
    const blob = await buildCashActivityPdf(position, { name: 'Venneir', addressLine: null });
    downloadCashCountPdf(blob, `cash_since_last_count_${position.period_end.slice(0, 10)}.pdf`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logFailure({
      source: 'cash.activity.pdf',
      severity: 'error',
      message,
      context: { period_end: position.period_end },
    });
  }
}

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
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${stamp} ${fmtTzAbbr(iso)}`;
}
