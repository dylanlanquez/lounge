import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { BottomSheet, Button, Card, EmptyState, Input, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { formatPence } from '../lib/queries/carts.ts';
import {
  useBalanceWriteoffs,
  reinstateWriteOff,
  writeOffReasonLabel,
  type BalanceWriteoffRow,
} from '../lib/queries/writeoffs.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';

// Admin, Write-offs. Lists every balance write-off (live and
// reinstated) and lets an authorised person reinstate a live one so
// the balance can be collected if the patient comes back. The write-
// off itself is created from the Pay screen; this tab is the record
// and the reversal surface.

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function AdminWriteOffsTab() {
  const { rows, loading, error, refresh } = useBalanceWriteoffs();
  const { account } = useCurrentAccount();
  // The reinstate RPC is gated on auth_can_write_off() (super admin or
  // the can_write_off grant). A plain admin without that grant can see
  // the list but cannot reinstate, so hide the button for them rather
  // than surface a raw "Not authorised" error on tap.
  const canReinstate = account?.can_write_off === true;

  const [target, setTarget] = useState<BalanceWriteoffRow | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const openReinstate = (row: BalanceWriteoffRow) => {
    setTarget(row);
    setNote('');
    setSheetError(null);
  };

  const submitReinstate = async () => {
    if (!target) return;
    if (note.trim().length === 0) {
      setSheetError('A reason is required to reinstate a balance.');
      return;
    }
    setBusy(true);
    setSheetError(null);
    try {
      await reinstateWriteOff({ cartId: target.cartId, note });
      setTarget(null);
      setToast({
        tone: 'success',
        title: 'Balance reinstated',
        description: `${formatPence(target.amountPence)} is due again on ${target.patientName}'s sale.`,
      });
      refresh();
    } catch (e) {
      setSheetError(e instanceof Error ? e.message : 'Could not reinstate the balance');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Write-offs
        </h2>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          Uncollectable balances that were forgiven. A write-off keeps the money already collected
          and never counts as revenue. Reinstate a live one to reopen the balance and collect it if
          the patient comes back.
        </p>
      </div>

      {error ? (
        <Card padding="lg">
          <p role="alert" style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
            Could not load write-offs. {error}
          </p>
        </Card>
      ) : loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No write-offs yet"
          description="When staff write off an uncollectable balance from the Pay screen, it appears here."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {rows.map((row) => (
            <Card key={row.id} padding="lg">
              <div style={{ display: 'flex', gap: theme.space[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold }}>
                      {row.patientName}
                    </span>
                    {row.appointmentRef ? (
                      <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                        {row.appointmentRef}
                      </span>
                    ) : null}
                    <StatusPill tone={row.isLive ? 'unsuitable' : 'neutral'} size="sm">
                      {row.isLive ? 'Live' : 'Reinstated'}
                    </StatusPill>
                  </div>
                  <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink }}>
                    {writeOffReasonLabel(row.reasonCategory)}. {row.reasonNote}
                  </span>
                  <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                    Written off{row.writtenOffByName ? ` by ${row.writtenOffByName}` : ''} on {formatDateTime(row.writtenOffAt)}
                  </span>
                  {!row.isLive && row.reinstatedAt ? (
                    <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
                      Reinstated{row.reinstatedByName ? ` by ${row.reinstatedByName}` : ''} on {formatDateTime(row.reinstatedAt)}
                      {row.reinstatedReason ? `. ${row.reinstatedReason}` : ''}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: theme.space[2] }}>
                  <span style={{ fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold, whiteSpace: 'nowrap' }}>
                    {formatPence(row.amountPence)}
                  </span>
                  {row.isLive && canReinstate ? (
                    <Button variant="secondary" onClick={() => openReinstate(row)}>
                      <RotateCcw size={16} style={{ marginRight: theme.space[2] }} />
                      Reinstate
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <BottomSheet
        open={target !== null}
        onClose={() => !busy && setTarget(null)}
        dismissable={!busy}
        title={target ? `Reinstate ${formatPence(target.amountPence)}` : 'Reinstate balance'}
        description={
          target
            ? `This reopens the balance on ${target.patientName}'s sale so it can be collected. The sale goes back on the in-clinic board.`
            : undefined
        }
        footer={
          <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitReinstate} loading={busy}>
              Reinstate balance
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
          <Input
            label="Reason"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Patient came back to pay the balance"
          />
          {sheetError ? (
            <p role="alert" style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
              {sheetError}
            </p>
          ) : null}
        </div>
      </BottomSheet>

      {toast ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            duration={6000}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
