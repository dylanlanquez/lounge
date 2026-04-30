import { useEffect, useMemo, useState } from 'react';
import { Banknote, Clock, Download, FileSignature, Plus, Wallet } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  StatCard,
  StatusPill,
} from '../../components/index.ts';
import { theme } from '../../theme/index.ts';
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
} from '../../lib/queries/cashCounts.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';
import { listManagers, type ManagerRow } from '../../lib/queries/staff.ts';
import { buildCashCountPdf, downloadCashCountPdf } from '../../lib/cashCountPdf.ts';
import { logFailure } from '../../lib/failureLog.ts';

export function CashReconciliationTab() {
  const counts = useCashCounts();
  const position = useCashPosition();
  const thresholds = useAnomalyThresholds();
  const { account } = useCurrentAccount();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [statementCountId, setStatementCountId] = useState<string | null>(null);

  if (counts.error || position.error) {
    return (
      <Card padding="lg">
        <p style={{ margin: 0, color: theme.color.alert }}>
          Could not load cash reconciliation data: {counts.error ?? position.error}
        </p>
      </Card>
    );
  }
  if (counts.loading || position.loading || !counts.data || !position.data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Skeleton height={120} />
        <Skeleton height={300} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <CurrentPositionCard
        position={position.data}
        canCountCash={!!account?.can_count_cash}
        onStart={() => setSheetOpen(true)}
      />
      <PastCountsCard
        counts={counts.data}
        onStatement={(id) => setStatementCountId(id)}
      />

      <NewCountSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        position={position.data}
        thresholds={thresholds.data}
        currentAccountId={account?.account_id ?? null}
        onSigned={() => {
          counts.refresh?.();
          position.refresh();
          setSheetOpen(false);
        }}
      />

      <StatementSheet
        countId={statementCountId}
        onClose={() => setStatementCountId(null)}
      />
    </div>
  );
}

function CurrentPositionCard({
  position,
  canCountCash,
  onStart,
}: {
  position: CashPosition;
  canCountCash: boolean;
  onStart: () => void;
}) {
  const last = position.last_signed_count;
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: theme.space[3],
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[2],
            }}
          >
            <Wallet size={16} aria-hidden /> What should be in the safe right now
          </h3>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            Sum of cash payments since the last signed count{last ? ` ended ${formatDate(last.period_end)}` : ' (no signed count yet — earliest cash payment is the anchor)'}.
          </p>
        </div>
        {canCountCash ? (
          <Button variant="primary" size="sm" onClick={onStart}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Plus size={14} aria-hidden /> New count
            </span>
          </Button>
        ) : null}
      </div>
      <div
        style={{
          marginTop: theme.space[4],
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: theme.space[3],
        }}
      >
        <StatCard
          label="Expected in safe"
          value={formatPence(position.expected_in_safe_pence)}
          delta={`${position.payment_count.toLocaleString('en-GB')} cash payment${position.payment_count === 1 ? '' : 's'}`}
          tone="accent"
          icon={<Banknote size={14} />}
        />
        <StatCard
          label="Earliest in run"
          value={position.earliest_payment_at ? formatShort(position.earliest_payment_at) : '—'}
          delta={position.latest_payment_at ? `Latest ${formatShort(position.latest_payment_at)}` : '—'}
          icon={<Clock size={14} />}
        />
        <StatCard
          label="Last signed count"
          value={last ? formatShort(last.period_end) : 'Never'}
          delta={last && last.actual_pence != null ? `Counted ${formatPence(last.actual_pence)}` : 'Run a count to set the baseline'}
          tone={last ? 'normal' : 'warn'}
          icon={<FileSignature size={14} />}
        />
      </div>
    </Card>
  );
}

function PastCountsCard({
  counts,
  onStatement,
}: {
  counts: CashCountRow[];
  onStatement: (id: string) => void;
}) {
  if (counts.length === 0) {
    return (
      <Card padding="lg">
        <EmptyState
          icon={<FileSignature size={20} />}
          title="No counts yet"
          description="Run the first count to establish the safe's baseline. The button is at the top of this tab when your account has cash-counting permission."
        />
      </Card>
    );
  }
  return (
    <Card padding="lg">
      <h3
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
        }}
      >
        Past counts
      </h3>
      <p
        style={{
          margin: `${theme.space[1]}px 0 ${theme.space[4]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        Newest first. Each row is one safe count event with counter + signer attribution. Click "Statement" for the full breakdown + downloadable PDF.
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        {counts.map((c) => {
          const variancePos = c.variance_pence > 0;
          const varianceNeg = c.variance_pence < 0;
          return (
            <li
              key={c.id}
              style={{
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.bg,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: theme.space[3],
                  flexWrap: 'wrap',
                  marginBottom: theme.space[2],
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
                    {formatShort(c.period_start)} → {formatShort(c.period_end)}
                  </p>
                  <p
                    style={{
                      margin: `${theme.space[1]}px 0 0`,
                      fontSize: theme.type.size.xs,
                      color: theme.color.inkMuted,
                    }}
                  >
                    Counted by <strong>{c.counted_by_name}</strong>
                    {c.signed_off_by_name ? ` · Signed by ${c.signed_off_by_name}` : ''}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: theme.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
                  <CountStatusPill status={c.status} />
                  <Button variant="tertiary" size="sm" onClick={() => onStatement(c.id)}>
                    Statement
                  </Button>
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: theme.space[3],
                  marginTop: theme.space[3],
                }}
              >
                <Mini label="Expected" value={formatPence(c.expected_pence)} />
                <Mini label="Actual" value={c.actual_pence === null ? '—' : formatPence(c.actual_pence)} />
                <Mini
                  label="Variance"
                  value={
                    c.actual_pence === null
                      ? '—'
                      : `${variancePos ? '+' : varianceNeg ? '−' : ''}${formatPence(Math.abs(c.variance_pence))}`
                  }
                  tone={varianceNeg ? 'alert' : variancePos ? 'warn' : 'normal'}
                />
              </div>
              {c.notes ? (
                <p
                  style={{
                    margin: `${theme.space[3]}px 0 0`,
                    fontSize: theme.type.size.sm,
                    color: theme.color.ink,
                  }}
                >
                  "{c.notes}"
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── New-count sheet ─────────────────────────────────────────────────────────

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
  thresholds: { discount_pct: number; void_window_minutes: number; cash_variance_pence: number; cash_count_overdue_days: number } | null;
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
  const periodEnd = useMemo(() => new Date().toISOString(), [open]);

  const actualPence = useMemo(() => {
    const float = Number(actualText.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(float)) return null;
    return Math.round(float * 100);
  }, [actualText]);

  const variance = actualPence === null ? null : actualPence - position.expected_in_safe_pence;
  const varianceTriggersNotes =
    thresholds !== null && variance !== null && Math.abs(variance) >= thresholds.cash_variance_pence;

  const submit = async () => {
    setError(null);
    if (actualPence === null || actualPence < 0) {
      setError('Enter a valid amount in pounds, e.g. 405.00.');
      return;
    }
    if (varianceTriggersNotes && notes.trim().length === 0) {
      setError('Variance is over the configured threshold — a note is required.');
      return;
    }
    if (!managerId) {
      setError('Pick a different manager to sign the count off.');
      return;
    }
    if (!managerPassword) {
      setError('The signing manager must enter their password.');
      return;
    }
    if (!position.last_signed_count && !position.earliest_payment_at) {
      setError('No cash activity yet — there is nothing to count.');
      return;
    }

    setBusy(true);
    try {
      // Step 1: open the count + snapshot lines.
      // location_id is implicit — we'd resolve it from currentAccount.location_id
      // but for the single-location footprint we use the location of the
      // most recent cash payment's visit. As a safety measure, the
      // server-side write enforces RLS so a wrong location is caught loudly.
      const locationId = await resolveLocationId();
      const created = await createCashCount({
        location_id: locationId,
        period_start: periodStart,
        period_end: periodEnd,
      });
      // Step 2: actual + notes.
      await updateCashCountActual(created.count_id, actualPence, notes);
      // Step 3: manager sign-off (re-auths in a parallel client).
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
      title="New cash count"
      description="Counts the cash payments since the last signed count. The signing manager re-enters their password — a different staff member than the counter."
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Sign count
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <div
          style={{
            padding: theme.space[3],
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.bg,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <p style={{ margin: 0, fontSize: theme.type.size.xs, textTransform: 'uppercase', letterSpacing: theme.type.tracking.wide, color: theme.color.inkMuted, fontWeight: theme.type.weight.semibold }}>
            Period
          </p>
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.ink }}>
            {formatShort(periodStart)} → {formatShort(periodEnd)} · expected{' '}
            <strong>{formatPence(position.expected_in_safe_pence)}</strong>
          </p>
        </div>

        <Input
          label="Actual amount in safe (£)"
          inputMode="decimal"
          value={actualText}
          onChange={(e) => setActualText(e.target.value)}
          placeholder="e.g. 405.00"
          autoFocus
        />

        {variance !== null ? (
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color:
                variance < 0
                  ? theme.color.alert
                  : variance > 0
                    ? theme.color.warn
                    : theme.color.accent,
            }}
          >
            Variance: {variance >= 0 ? '+' : '−'}{formatPence(Math.abs(variance))}
            {varianceTriggersNotes ? ' — note required' : ''}
          </p>
        ) : null}

        <Input
          label={varianceTriggersNotes ? 'Note (required)' : 'Note (optional)'}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What explains the variance? Anything else worth recording."
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
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
            }}
          >
            Manager sign-off
          </span>
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
            value={managerPassword}
            onChange={(e) => setManagerPassword(e.target.value)}
          />
        </div>

        {error ? (
          <p
            role="alert"
            style={{
              margin: 0,
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
        No other manager available. Add a Manager-flagged staff member in Admin → Staff first.
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

// ── Statement sheet ─────────────────────────────────────────────────────────

function StatementSheet({ countId, onClose }: { countId: string | null; onClose: () => void }) {
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
      title="Cash count statement"
      description={data ? `Period ${formatShort(data.count.period_start)} → ${formatShort(data.count.period_end)}` : ''}
      footer={
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
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
        <p style={{ margin: 0, color: theme.color.alert }}>Could not load statement: {error}</p>
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
            <Mini label="Expected" value={formatPence(data.count.expected_pence)} />
            <Mini label="Actual" value={data.count.actual_pence === null ? '—' : formatPence(data.count.actual_pence)} />
            <Mini
              label="Variance"
              value={
                data.count.actual_pence === null
                  ? '—'
                  : `${data.count.variance_pence >= 0 ? '+' : '−'}${formatPence(Math.abs(data.count.variance_pence))}`
              }
              tone={data.count.variance_pence < 0 ? 'alert' : data.count.variance_pence > 0 ? 'warn' : 'normal'}
            />
          </div>
          <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
            Counted by <strong>{data.count.counted_by_name}</strong>
            {data.count.signed_off_by_name ? ` · Signed by ${data.count.signed_off_by_name}` : ''}
          </p>
          {data.count.notes ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, fontStyle: 'italic' }}>"{data.count.notes}"</p>
          ) : null}
          <hr style={{ border: 'none', borderTop: `1px solid ${theme.color.border}`, margin: 0 }} />
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
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold }}>
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
          {data.lines.length === 0 ? (
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              No cash payments in this period.
            </p>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveLocationId(): Promise<string> {
  // Single-location footprint for now. The current user's accounts
  // row carries location_id; a count happens against that location.
  // We don't try to derive from cash payments because the right
  // contract is "the location the counter belongs to". If the
  // accounts row has no location set, we fall over loudly rather
  // than silently writing an arbitrary row.
  const { supabase } = await import('../../lib/supabase.ts');
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

function Mini({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warn' | 'alert' }) {
  const colour =
    tone === 'alert'
      ? theme.color.alert
      : tone === 'warn'
        ? theme.color.warn
        : theme.color.ink;
  return (
    <div>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          fontWeight: theme.type.weight.medium,
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: `${theme.space[1]}px 0 0`,
          fontSize: theme.type.size.sm,
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

function CountStatusPill({ status }: { status: 'pending' | 'signed' | 'disputed' }) {
  switch (status) {
    case 'pending':
      return <StatusPill tone="pending" size="sm">Pending</StatusPill>;
    case 'signed':
      return <StatusPill tone="arrived" size="sm">Signed</StatusPill>;
    case 'disputed':
      return <StatusPill tone="no_show" size="sm">Disputed</StatusPill>;
  }
}

function formatShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
