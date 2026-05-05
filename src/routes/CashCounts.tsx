import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Download, FileSignature, Plus, Wallet } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  StatusPill,
} from '../components/index.ts';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useCurrentAccount } from '../lib/queries/currentAccount.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  type CashCountRow,
  type CashPosition,
  createCashCount,
  signCashCount,
  updateCashCountActual,
  useAnomalyThresholds,
  useCashCounts,
  useCashCountStatement,
  useCashPosition,
} from '../lib/queries/cashCounts.ts';
import { formatNumber, formatPence } from '../lib/queries/carts.ts';
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
  const [statementCountId, setStatementCountId] = useState<string | null>(null);

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
              onStart={() => setSheetOpen(true)}
            />
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
          onClose={() => setSheetOpen(false)}
          position={position.data}
          thresholds={thresholds.data}
          currentAccountId={account.account_id ?? null}
          onSigned={() => {
            counts.refresh?.();
            position.refresh();
            setSheetOpen(false);
          }}
        />
      ) : null}

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
}: {
  position: CashPosition;
  canCountCash: boolean;
  onStart: () => void;
}) {
  const last = position.last_signed_count;
  const hasActivity =
    position.payment_count > 0 || position.expected_in_safe_pence > 0;

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
              {formatNumber(position.payment_count)} cash payment
              {position.payment_count === 1 ? '' : 's'}
              {last
                ? ` since the last count on ${formatLongDate(last.period_end)}.`
                : position.earliest_payment_at
                  ? ` since the first cash payment on ${formatLongDate(position.earliest_payment_at)}.`
                  : '.'}
            </span>
          </>
        ) : (
          <span style={{ color: theme.color.inkMuted }}>
            {last
              ? `No cash payments since the last count on ${formatLongDate(last.period_end)}. Nothing to count yet.`
              : 'No cash activity yet. Cash counts kick in once the first cash payment is taken.'}
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

      {canCountCash && hasActivity ? (
        <div style={{ marginTop: theme.space[5] }}>
          <Button variant="primary" onClick={onStart}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Plus size={14} aria-hidden />
              Count cash now
            </span>
          </Button>
        </div>
      ) : null}
    </Card>
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

  // Headline sentence — varies by whether the count matched.
  const summary =
    counted === null ? (
      <>Not yet counted · expected {formatPence(expected)}</>
    ) : matched ? (
      <>
        {formatPence(counted)} counted · matched expected
      </>
    ) : (
      <>
        {formatPence(counted)} counted · expected {formatPence(expected)}
      </>
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
          {showStatus ? <CountStatus status={count.status} /> : null}
          {!matched && counted !== null ? (
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
}) {
  const [actualText, setActualText] = useState('');
  const [notes, setNotes] = useState('');
  const [managerId, setManagerId] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [managerPassword, setManagerPassword] = useState('');
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setActualText('');
    setNotes('');
    setManagerId('');
    setManagerEmail('');
    setManagerPassword('');
    setError(null);
    listManagers()
      .then((rows) => setManagers(rows.filter((r) => r.account_id !== currentAccountId)))
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

  const diff = actualPence === null ? null : actualPence - position.expected_in_safe_pence;
  const diffNeedsNote =
    thresholds !== null && diff !== null && Math.abs(diff) >= thresholds.cash_variance_pence;

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
      setError('Pick a different manager to sign off.');
      return;
    }
    if (!managerPassword) {
      setError('The signing manager needs to enter their password.');
      return;
    }
    if (!position.last_signed_count && !position.earliest_payment_at) {
      setError('No cash activity yet — there is nothing to count.');
      return;
    }

    setBusy(true);
    try {
      const locationId = await resolveLocationId();
      const created = await createCashCount({
        location_id: locationId,
        period_start: periodStart,
        period_end: periodEnd,
      });
      await updateCashCountActual(created.count_id, actualPence, notes);
      await signCashCount({
        count_id: created.count_id,
        signer_email: managerEmail,
        signer_password: managerPassword,
      });
      onSigned();
    } catch (e) {
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
      title="Count cash"
      description="Count the cash in the safe and have a different manager sign off. Differences get flagged automatically."
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <div
          style={{
            padding: theme.space[4],
            borderRadius: theme.radius.input,
            background: theme.color.accentBg,
            border: `1px solid ${theme.color.border}`,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Expected in safe
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xl,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {formatPence(position.expected_in_safe_pence)}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            Cash since{' '}
            {position.last_signed_count
              ? `the last count on ${formatLongDate(position.last_signed_count.period_end)}`
              : `the first cash payment on ${formatLongDate(position.earliest_payment_at ?? '')}`}
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

        {diff !== null ? (
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
          placeholder="What explains the difference, if anything?"
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
          <div>
            <p
              style={{
                margin: 0,
                fontSize: 11,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
              }}
            >
              Counter-sign by another manager
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              A second pair of eyes signs off. They re-enter their password to authorise.
            </p>
          </div>
          <ManagerPicker
            managers={managers}
            value={managerId}
            onChange={(id, email) => {
              setManagerId(id);
              setManagerEmail(email);
            }}
          />
          <Input
            label="Manager password"
            type="password"
            // Block saved-password autofill — the manager must re-enter
            // their password every count so the audit row reflects an
            // intentional, in-the-room sign-off rather than a cached
            // credential drifting across sessions.
            autoComplete="new-password"
            name="lng-cash-count-manager-password"
            data-lpignore="true"
            data-1p-ignore
            value={managerPassword}
            onChange={(e) => setManagerPassword(e.target.value)}
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
  onChange: (id: string, email: string) => void;
}) {
  if (managers.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.warn }}>
        No other manager available. Add a Manager-flagged staff member in Admin, Staff first.
      </p>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => {
        const m = managers.find((mgr) => mgr.account_id === e.target.value);
        if (m) onChange(m.account_id, m.login_email);
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
          {m.name}
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
          <div>
            <p
              style={{
                margin: 0,
                fontSize: 11,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                marginBottom: theme.space[2],
              }}
            >
              Cash payments in this count ({formatNumber(data.lines.length)})
            </p>
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
          </div>
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

