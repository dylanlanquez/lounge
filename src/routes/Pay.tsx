import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Banknote, CreditCard, ShoppingBag } from 'lucide-react';
import { Button, Card, EmptyState, Input, StatusPill, Toast } from '../components/index.ts';
import { TerminalPaymentModal } from '../components/TerminalPaymentModal/TerminalPaymentModal.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { useVisitDetail } from '../lib/queries/visits.ts';
import { useCart, formatPence } from '../lib/queries/carts.ts';
import { recordCashPayment } from '../lib/queries/payments.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
import { supabase } from '../lib/supabase.ts';

type Stage = 'choose' | 'cash' | 'card' | 'bnpl' | 'success';
type Journey = 'standard' | 'klarna' | 'clearpay';

export function Pay() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const { visit, patient } = useVisitDetail(id);
  const { cart, items } = useCart(id);
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('choose');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [receiptChannel, setReceiptChannel] = useState<'email' | 'sms' | 'none'>('email');
  const [receiptRecipient, setReceiptRecipient] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [journey, setJourney] = useState<Journey>('standard');
  const { data: readers } = useTerminalReaders();
  const reader = readers[0] ?? null;

  const openTerminal = (j: Journey) => {
    if (!reader) {
      setError(
        'No card reader registered. Activate Terminal in Stripe Dashboard, register a Simulated WisePOS E or your S700, then INSERT a row into lng_terminal_readers.'
      );
      return;
    }
    setJourney(j);
    setTerminalOpen(true);
  };

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  const total = items.reduce((s, i) => s + i.line_total_pence - i.discount_pence, 0);

  const submitCash = async () => {
    if (!cart) return;
    const tenderedFloat = Number(tendered.replace(/[^\d.]/g, ''));
    const tenderedPence = Math.round(tenderedFloat * 100);
    if (!Number.isFinite(tenderedPence) || tenderedPence < total) {
      setError(`Tendered amount must be at least ${formatPence(total)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const change = tenderedPence - total;
      const payment = await recordCashPayment(cart.id, total, `Tendered ${formatPence(tenderedPence)}, change ${formatPence(change)}`);
      setPaymentId(payment.id);
      setStage('success');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const sendReceipt = async () => {
    if (!paymentId || receiptChannel === 'none') {
      navigate(`/visit/${id}`);
      return;
    }
    setBusy(true);
    try {
      await supabase.from('lng_receipts').insert({
        payment_id: paymentId,
        channel: receiptChannel,
        recipient: receiptRecipient || null,
        sent_at: new Date().toISOString(),
        content: { note: 'V0 receipt — actual delivery via Resend lands in slice 13b.' },
      });
      // Close the visit
      if (visit) {
        await supabase.from('lng_visits').update({ status: 'complete', closed_at: new Date().toISOString() }).eq('id', visit.id);
        // Patient-axis event
        if (patient) {
          await supabase.from('patient_events').insert({
            patient_id: patient.id,
            event_type: 'visit_closed',
            payload: { visit_id: visit.id, total_pence: total, receipt_channel: receiptChannel },
          });
        }
      }
      navigate(`/visit/${id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  if (!visit || !cart || items.length === 0) {
    return (
      <main style={{ minHeight: '100dvh', background: theme.color.bg, padding: theme.space[6] }}>
        <div style={{ maxWidth: 520, margin: '0 auto' }}>
          <Button variant="tertiary" size="sm" onClick={() => navigate(-1)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <ArrowLeft size={16} /> Back
            </span>
          </Button>
          <Card padding="lg" style={{ marginTop: theme.space[5] }}>
            <EmptyState
              title="Nothing to pay for"
              description="Cart has no line items. Add some, then come back."
              action={<Button variant="primary" onClick={() => navigate(`/visit/${id}`)}>Back to visit</Button>}
            />
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100dvh', background: theme.color.bg, padding: theme.space[6] }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <Button variant="tertiary" size="sm" onClick={() => navigate(`/visit/${id}`)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <ArrowLeft size={16} /> Visit
          </span>
        </Button>

        <h1
          style={{
            margin: `${theme.space[5]}px 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {patient ? patientFullName(patient) : 'Visit'} · {formatPence(total)}
        </h1>
        <p style={{ margin: `0 0 ${theme.space[6]}px`, color: theme.color.inkMuted }}>
          {stage === 'choose' && 'Choose a payment method.'}
          {stage === 'cash' && 'Enter the amount tendered. Change calculates live.'}
          {stage === 'card' && 'Card terminal flow ships in slice 8.'}
          {stage === 'bnpl' && 'BNPL helper ships in slice 12.'}
          {stage === 'success' && 'Choose how to send the receipt.'}
        </p>

        {stage === 'choose' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <MethodCard
              icon={<CreditCard size={20} />}
              title="Card"
              description={reader ? `Reader: ${reader.friendly_name}` : 'No reader registered yet'}
              onClick={() => openTerminal('standard')}
              disabled={!reader}
            />
            <MethodCard icon={<Banknote size={20} />} title="Cash" description="Change calculator built-in." onClick={() => setStage('cash')} />
            <MethodCard
              icon={<ShoppingBag size={20} />}
              title="Buy now, pay later"
              description={reader ? 'Klarna or Clearpay via the same reader' : 'Needs a registered reader'}
              onClick={() => setStage('bnpl')}
              disabled={!reader}
            />
          </div>
        ) : stage === 'bnpl' ? (
          <Card padding="lg">
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Pick a provider
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              Both work the same way: customer opens their app, taps phone on the reader. Receipt says Visa contactless.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Klarna"
                description={`£30 minimum, £2,000 max. Reader: ${reader?.friendly_name ?? '—'}`}
                onClick={() => openTerminal('klarna')}
                disabled={!reader}
              />
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Clearpay"
                description={`Customer's app caps the limit. Reader: ${reader?.friendly_name ?? '—'}`}
                onClick={() => openTerminal('clearpay')}
                disabled={!reader}
              />
            </div>
            <Button variant="tertiary" onClick={() => setStage('choose')} style={{ marginTop: theme.space[4] }}>
              Back to methods
            </Button>
          </Card>
        ) : stage === 'cash' ? (
          <Card padding="lg">
            <Input
              label="Tendered (£)"
              autoFocus
              inputMode="decimal"
              placeholder={`min ${formatPence(total)}`}
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
            />
            <ChangeRow tendered={tendered} totalPence={total} />
            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', marginTop: theme.space[4] }}>
              <Button variant="tertiary" onClick={() => setStage('choose')}>
                Back
              </Button>
              <Button variant="primary" onClick={submitCash} loading={busy}>
                Record cash payment
              </Button>
            </div>
          </Card>
        ) : stage === 'card' ? (
          <Card padding="lg">
            <EmptyState
              title="Use the Card option above"
              description="The terminal modal opens automatically when you pick Card."
              action={<Button variant="primary" onClick={() => setStage('choose')}>Back</Button>}
            />
          </Card>
        ) : (
          <Card padding="lg">
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              {formatPence(total)} paid
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 ${theme.space[5]}px`, color: theme.color.inkMuted }}>
              Receipt channel:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
              <ReceiptOption
                value="email"
                label="Email"
                hint="To the address on file or one you enter below."
                selected={receiptChannel === 'email'}
                onClick={() => setReceiptChannel('email')}
              />
              <ReceiptOption
                value="sms"
                label="SMS"
                hint="Slice 13b — provider not wired yet. Logs only."
                selected={receiptChannel === 'sms'}
                onClick={() => setReceiptChannel('sms')}
              />
              <ReceiptOption
                value="none"
                label="No receipt"
                hint="Customer doesn't want one."
                selected={receiptChannel === 'none'}
                onClick={() => setReceiptChannel('none')}
              />
            </div>

            {receiptChannel !== 'none' ? (
              <div style={{ marginTop: theme.space[4] }}>
                <Input
                  label={receiptChannel === 'email' ? 'Email address' : 'Phone number'}
                  placeholder={receiptChannel === 'email' ? (patient?.email ?? 'name@example.com') : (patient?.phone ?? '+44...')}
                  value={receiptRecipient}
                  onChange={(e) => setReceiptRecipient(e.target.value)}
                />
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end', marginTop: theme.space[5] }}>
              <Button variant="primary" onClick={sendReceipt} loading={busy} showArrow>
                Done
              </Button>
            </div>
          </Card>
        )}

        <div style={{ marginTop: theme.space[5], display: 'flex', justifyContent: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <StatusPill tone="neutral" size="sm">
            Total: {formatPence(total)}
          </StatusPill>
        </div>
      </div>

      {reader && cart ? (
        <TerminalPaymentModal
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          visitId={visit?.id ?? ''}
          cartId={cart.id}
          amountPence={total}
          readerId={reader.id}
          readerName={reader.friendly_name}
          paymentJourney={journey}
          onSucceeded={(pid) => {
            setPaymentId(pid);
            setTerminalOpen(false);
            setStage('success');
          }}
        />
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not record payment" description={error} duration={8000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </main>
  );
}

function MethodCard({
  icon,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        borderRadius: 16,
        padding: theme.space[5],
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        gap: theme.space[4],
        alignItems: 'center',
        fontFamily: 'inherit',
        boxShadow: theme.shadow.card,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {title}
        </p>
        <p style={{ margin: `${theme.space[1]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          {description}
        </p>
      </div>
    </button>
  );
}

function ChangeRow({ tendered, totalPence }: { tendered: string; totalPence: number }) {
  const tFloat = Number(tendered.replace(/[^\d.]/g, ''));
  const tPence = Math.round(tFloat * 100);
  const change = Number.isFinite(tPence) ? tPence - totalPence : null;
  return (
    <div
      style={{
        marginTop: theme.space[4],
        padding: theme.space[3],
        background: theme.color.bg,
        borderRadius: 12,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}
    >
      <span style={{ color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>Change due</span>
      <span
        style={{
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: change !== null && change >= 0 ? theme.color.ink : theme.color.alert,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {change === null ? '—' : formatPence(Math.max(0, change))}
        {change !== null && change < 0 ? ' short' : ''}
      </span>
    </div>
  );
}

function ReceiptOption({
  value,
  label,
  hint,
  selected,
  onClick,
}: {
  value: string;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
        background: selected ? theme.color.ink : theme.color.surface,
        color: selected ? theme.color.surface : theme.color.ink,
        borderRadius: 12,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
      }}
    >
      <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base }}>{label}</span>
      <span style={{ color: selected ? 'rgba(255,255,255,0.7)' : theme.color.inkMuted, fontSize: theme.type.size.xs }}>{hint}</span>
      <span style={{ display: 'none' }}>{value}</span>
    </button>
  );
}
