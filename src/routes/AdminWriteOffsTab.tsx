import { type ReactNode, useState } from 'react';
import { HandCoins, Info, RotateCcw, ShieldCheck } from 'lucide-react';
import { BottomSheet, Button, Card, EmptyState, Input, Skeleton, StatusPill, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { formatPence } from '../lib/queries/carts.ts';
import {
  useBalanceWriteoffs,
  reinstateWriteOff,
  writeOffReasonLabel,
  type BalanceWriteoffRow,
} from '../lib/queries/writeoffs.ts';
import { useCurrentAccount } from '../lib/queries/currentAccount.tsx';

// Admin, Write-offs. Records every balance write-off and reinstates a
// live one. Opens with a hero that explains what a write-off is in
// plain terms, then a symmetric How it works panel (write off / take it
// back), then the log. Built in the app's own visual language: white
// cards, the mint accent ribbon, and the circular icon chip motif from
// AppointmentHero, so it reads as native rather than bolted on.

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

// The circular icon chip used across the app's heroes: white surface,
// hairline border, accent-coloured glyph. One motif, sized per context.
function IconChip({ children, size = 40 }: { children: ReactNode; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: theme.radius.pill,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        color: theme.color.accent,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

// One How it works column: a titled sequence of steps. Numbering is
// honest here, the steps are a real order the reader follows.
function HowToColumn({ icon, title, steps }: { icon: ReactNode; title: string; steps: string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
        <IconChip size={36}>{icon}</IconChip>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {title}
        </h3>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        {steps.map((step, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
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
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {i + 1}
            </span>
            <span
              style={{
                fontSize: theme.type.size.base,
                color: theme.color.ink,
                lineHeight: theme.type.leading.normal,
              }}
            >
              {step}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const WRITE_OFF_STEPS = [
  'Open the part-paid sale and tap Take payment.',
  'Below the payment methods, tap Write off remaining, then pick a reason and add a note.',
  'Confirm. The sale closes, leaves the In clinic board, and appears in the records below.',
];

const REINSTATE_STEPS = [
  'Find the sale in the records below and tap Reinstate.',
  'Add a reason, for example that the patient came back to pay.',
  'Confirm. The balance reopens and the sale returns to the In clinic board to collect.',
];

export function AdminWriteOffsTab() {
  const { rows, loading, error, refresh } = useBalanceWriteoffs();
  const { account } = useCurrentAccount();
  const narrow = useIsMobile(720);
  // The reinstate RPC is gated on auth_can_write_off() (super admin or
  // the can_write_off grant). A plain admin without that grant can see
  // the records but cannot reinstate, so hide the button for them
  // rather than surface a raw error on tap.
  const canReinstate = account?.can_write_off === true;

  const liveRows = rows.filter((r) => r.isLive);
  const liveTotalPence = liveRows.reduce((sum, r) => sum + r.amountPence, 0);

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
      setToast({
        tone: 'success',
        title: 'Balance reinstated',
        description: `${formatPence(target.amountPence)} is due again on ${target.patientName}'s sale.`,
      });
      setTarget(null);
      refresh();
    } catch (e) {
      setSheetError(e instanceof Error ? e.message : 'Could not reinstate the balance');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[6] }}>
      {/* Hero. Two zones like AppointmentHero: an identity zone with the
          icon chip + title, then a mint ribbon carrying the plain-English
          thesis so a passer-by understands what this is at a glance. */}
      <Card padding="none" elevation="raised" style={{ overflow: 'hidden' }}>
        <div
          style={{
            padding: theme.space[6],
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[4],
          }}
        >
          <IconChip size={48}>
            <HandCoins size={22} />
          </IconChip>
          <div style={{ minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: narrow ? theme.type.size.xl : theme.type.size.xxl,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
                lineHeight: theme.type.leading.tight,
              }}
            >
              Write-offs
            </h2>
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                fontSize: theme.type.size.md,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.snug,
              }}
            >
              Forgive a balance you cannot collect, and keep a record of it.
            </p>
          </div>
        </div>
        <div
          style={{
            padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[5]}px`,
            background: theme.color.accentBg,
            borderTop: `1px solid ${theme.color.border}`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: theme.space[3],
          }}
        >
          <span style={{ color: theme.color.accent, display: 'inline-flex', marginTop: 2, flexShrink: 0 }}>
            <ShieldCheck size={18} aria-hidden />
          </span>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.ink,
              lineHeight: theme.type.leading.normal,
            }}
          >
            A write-off is not a refund. The money already collected stays, and nothing here counts
            as revenue. Every one can be reinstated if the patient comes back to pay.
          </p>
        </div>
      </Card>

      {/* How it works. Two symmetric columns, split by a hairline on wide
          screens and stacked on a tablet held in portrait or a phone. */}
      <Card padding="lg" elevation="raised">
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginBottom: theme.space[6] }}>
          <Info size={16} aria-hidden style={{ color: theme.color.inkSubtle }} />
          <span
            style={{
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.wide,
              textTransform: 'uppercase',
              color: theme.color.inkMuted,
            }}
          >
            How it works
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : '1fr 1px 1fr',
            gap: narrow ? theme.space[6] : theme.space[8],
            alignItems: 'stretch',
          }}
        >
          <HowToColumn icon={<HandCoins size={18} />} title="Write off a balance" steps={WRITE_OFF_STEPS} />
          {narrow ? (
            <div style={{ height: 1, background: theme.color.border }} />
          ) : (
            <div style={{ width: 1, background: theme.color.border }} />
          )}
          <HowToColumn icon={<RotateCcw size={18} />} title="Reinstate a balance" steps={REINSTATE_STEPS} />
        </div>
        <p
          style={{
            margin: `${theme.space[6]}px 0 0`,
            paddingTop: theme.space[5],
            borderTop: `1px solid ${theme.color.border}`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          Only super admins and staff granted Write off balances can do this. Turn it on per person
          in Admin, Staff, Section access. Configured managers are notified by email each time.
        </p>
      </Card>

      {/* Records. The log of every write-off, live and reinstated. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3] }}>
          <span
            style={{
              fontSize: theme.type.size.xs,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.wide,
              textTransform: 'uppercase',
              color: theme.color.inkMuted,
            }}
          >
            Records
          </span>
          {liveRows.length > 0 ? (
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
              {liveRows.length} live · {formatPence(liveTotalPence)} outstanding
            </span>
          ) : null}
        </div>

        {error ? (
          <Card padding="lg">
            <p role="alert" style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium }}>
              Could not load write-offs. {error}
            </p>
          </Card>
        ) : loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton height={104} />
            <Skeleton height={104} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No write-offs yet"
            description="When staff write off an uncollectable balance from the Pay screen, it is recorded here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            {rows.map((row) => (
              <Card key={row.id} padding="lg">
                <div style={{ display: 'flex', gap: theme.space[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], flexWrap: 'wrap' }}>
                      <span style={{ fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink, letterSpacing: theme.type.tracking.tight }}>
                        {row.patientName}
                      </span>
                      {row.appointmentRef ? (
                        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums' }}>
                          {row.appointmentRef}
                        </span>
                      ) : null}
                      <StatusPill tone={row.isLive ? 'unsuitable' : 'neutral'} size="sm">
                        {row.isLive ? 'Live' : 'Reinstated'}
                      </StatusPill>
                    </div>
                    <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, lineHeight: theme.type.leading.normal }}>
                      {writeOffReasonLabel(row.reasonCategory)}. {row.reasonNote}
                    </span>
                    <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
                      Written off{row.writtenOffByName ? ` by ${row.writtenOffByName}` : ''} on {formatDateTime(row.writtenOffAt)}
                    </span>
                    {!row.isLive && row.reinstatedAt ? (
                      <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
                        Reinstated{row.reinstatedByName ? ` by ${row.reinstatedByName}` : ''} on {formatDateTime(row.reinstatedAt)}
                        {row.reinstatedReason ? `. ${row.reinstatedReason}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: theme.space[3] }}>
                    <span style={{ fontSize: theme.type.size.xl, fontWeight: theme.type.weight.semibold, color: theme.color.ink, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', letterSpacing: theme.type.tracking.tight }}>
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
      </div>

      <BottomSheet
        open={target !== null}
        onClose={() => !busy && setTarget(null)}
        dismissable={!busy}
        title={target ? `Reinstate ${formatPence(target.amountPence)}` : 'Reinstate balance'}
        description={
          target
            ? `This reopens the balance on ${target.patientName}'s sale so it can be collected. The sale goes back on the In clinic board.`
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
