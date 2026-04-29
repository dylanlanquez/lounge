import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Banknote, CreditCard, ShoppingBag } from 'lucide-react';
import { BOTTOM_NAV_HEIGHT } from '../components/BottomNav/BottomNav.tsx';
import { KIOSK_STATUS_BAR_HEIGHT } from '../components/KioskStatusBar/KioskStatusBar.tsx';
import { useIsMobile } from '../lib/useIsMobile.ts';
import { Breadcrumb, Button, Card, EmptyState, Input, StatusPill, Toast } from '../components/index.ts';
import { TerminalPaymentModal } from '../components/TerminalPaymentModal/TerminalPaymentModal.tsx';
import { BNPLHelper, type BnplProvider } from '../components/BNPLHelper/BNPLHelper.tsx';
import { theme } from '../theme/index.ts';
import { useAuth } from '../lib/auth.tsx';
import { formatVisitCrumb, useVisitDetail } from '../lib/queries/visits.ts';
import { useCart, formatPence } from '../lib/queries/carts.ts';
import { recordCashPayment } from '../lib/queries/payments.ts';
import { patientFullName } from '../lib/queries/patients.ts';
import { useTerminalReaders } from '../lib/queries/terminalReaders.ts';
import { supabase } from '../lib/supabase.ts';

type Stage = 'choose' | 'cash' | 'card' | 'bnpl' | 'success';
type Journey = 'standard' | 'klarna' | 'clearpay';

// Router state read by PayBreadcrumbs to render the right trail. The
// "Take payment" button on VisitDetail forwards a `from: 'visit'`
// payload that carries the visit id, opened-at, and the visit's own
// entry so the breadcrumb here can render [origin] › Visit › Take
// payment, with each crumb popping back to the right place. Direct
// URL pastes (no state) fall back to a sensible default chain.
interface PayEntryState {
  from?: 'visit';
  visitId?: string;
  visitOpenedAt?: string;
  // Full preview of the visit's own entry state, mirrored from
  // VisitDetail's VisitEntryState. Carries patientName and
  // visitOpenedAt so navigating back to the visit pre-renders
  // every breadcrumb crumb on first paint.
  visitEntry?: {
    from?: 'patient' | 'schedule' | 'in_clinic';
    patientId?: string;
    patientName?: string;
    visitOpenedAt?: string;
  } | null;
}

export function Pay() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();
  const { visit, patient, deposit } = useVisitDetail(id);
  const { cart, items } = useCart(id);
  const navigate = useNavigate();
  const location = useLocation();
  // Hop back to the visit page with its original entry chain intact.
  // VisitDetail forwarded its own state when sending us here; passing
  // it back through means the visit's breadcrumb pre-renders every
  // crumb (origin / patient / timestamp) on first paint with no
  // shimmer transition.
  const visitState = (location.state as PayEntryState | null)?.visitEntry ?? undefined;
  const goBackToVisit = () =>
    navigate(`/visit/${id}`, visitState ? { state: visitState } : undefined);
  const [stage, setStage] = useState<Stage>('choose');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [receiptChannel, setReceiptChannel] = useState<'email' | 'sms' | 'none'>('email');
  const [receiptRecipient, setReceiptRecipient] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [bnplOpen, setBnplOpen] = useState(false);
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

  const openBnpl = (provider: BnplProvider) => {
    if (!reader) {
      setError('No card reader registered. BNPL needs the same reader.');
      return;
    }
    setJourney(provider);
    setBnplOpen(true);
  };

  const isMobile = useIsMobile(640);

  if (authLoading) return null;
  if (!user) return <Navigate to="/sign-in" replace />;

  // Subtotal = sum of line items. Only PAID deposits credit the bill; a
  // failed deposit is informational (the receptionist sees a red badge in
  // the schedule sheet) and the till still collects the full subtotal.
  // Floor at 0 so a deposit larger than the bill doesn't produce a
  // negative charge — refund handled manually in PayPal.
  const subtotal = items.reduce((s, i) => s + i.line_total_pence - i.discount_pence, 0);
  const depositPence = deposit?.status === 'paid' ? deposit.pence : 0;
  const balanceDue = Math.max(0, subtotal - depositPence);
  // Total is what we ACTUALLY charge — used everywhere downstream (cash,
  // card, BNPL). Keeping the variable name `total` minimises churn on the
  // submit handlers below.
  const total = balanceDue;

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
      const note =
        depositPence > 0
          ? `Tendered ${formatPence(tenderedPence)}, change ${formatPence(change)}. Deposit ${formatPence(depositPence)} via ${deposit?.provider ?? 'paypal'} already collected at booking.`
          : `Tendered ${formatPence(tenderedPence)}, change ${formatPence(change)}`;
      const payment = await recordCashPayment(cart.id, total, note);
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
      await closeVisit();
      goBackToVisit();
      return;
    }
    setBusy(true);
    try {
      // 1. Insert as queued (no sent_at). The edge function flips it to sent
      //    after Resend/Twilio confirms delivery — or sets failure_reason.
      const { data: receipt, error: insErr } = await supabase
        .from('lng_receipts')
        .insert({
          payment_id: paymentId,
          channel: receiptChannel,
          recipient: receiptRecipient || null,
          content: null,
        })
        .select('id')
        .single();
      if (insErr || !receipt) throw new Error(insErr?.message ?? 'Could not queue receipt');

      // 2. Invoke the send-receipt edge function. Surface but don't block on
      //    a delivery failure — the row is recoverable from /admin later.
      const url = new URL(import.meta.env.VITE_SUPABASE_URL);
      const projectRef = url.hostname.split('.')[0];
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const r = await fetch(`https://${projectRef}.functions.supabase.co/send-receipt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiptId: (receipt as { id: string }).id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body?.ok) {
        // Show a soft warning toast but proceed: the visit still closes.
        const reason = body?.error ?? `HTTP ${r.status}`;
        setError(`Receipt queued but not delivered: ${reason}. You can resend from the appointment later.`);
      }

      await closeVisit();
      goBackToVisit();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const closeVisit = async () => {
    if (!visit) return;
    await supabase
      .from('lng_visits')
      .update({ status: 'complete', closed_at: new Date().toISOString() })
      .eq('id', visit.id);

    // Free the job box. The source rows (appointment / walk-in)
    // hold the "currently assigned" JB; nulling them once the
    // visit completes lets the box be reassigned to a new
    // appointment. The visit's own jb_ref column was captured at
    // insert time (trigger lng_visits_capture_jb_ref_trg) and is
    // immutable, so the historical record survives on the
    // VisitDetail timeline.
    if (visit.appointment_id) {
      await supabase
        .from('lng_appointments')
        .update({ jb_ref: null })
        .eq('id', visit.appointment_id);
    }
    if (visit.walk_in_id) {
      await supabase
        .from('lng_walk_ins')
        .update({ jb_ref: null })
        .eq('id', visit.walk_in_id);
    }

    if (patient) {
      await supabase.from('patient_events').insert({
        patient_id: patient.id,
        event_type: 'visit_closed',
        payload: { visit_id: visit.id, total_pence: total, receipt_channel: receiptChannel },
      });
    }
  };

  if (!visit || !cart || items.length === 0) {
    return (
      <main
        style={{
          minHeight: '100dvh',
          background: theme.color.bg,
          padding: isMobile ? theme.space[4] : theme.space[6],
          paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
          paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
        }}
      >
        <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
          <PayBreadcrumbs visitId={id ?? null} entry={location.state as PayEntryState | null} />
          <Card padding="lg" style={{ marginTop: theme.space[5] }}>
            <EmptyState
              title="Nothing to pay for"
              description="Cart has no line items. Add some, then come back."
              action={<Button variant="primary" onClick={goBackToVisit}>Back to appointment</Button>}
            />
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: theme.color.bg,
        padding: isMobile ? theme.space[4] : theme.space[6],
        paddingTop: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + ${isMobile ? theme.space[4] : theme.space[6]}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${BOTTOM_NAV_HEIGHT}px + ${isMobile ? theme.space[6] : theme.space[8]}px + env(safe-area-inset-bottom, 0px))`,
      }}
    >
      <div style={{ maxWidth: theme.layout.pageMaxWidth, margin: '0 auto' }}>
        <PayBreadcrumbs visitId={id ?? null} entry={location.state as PayEntryState | null} />

        <h1
          style={{
            margin: `${theme.space[5]}px 0 ${theme.space[2]}px`,
            fontSize: theme.type.size.xxl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {patient ? patientFullName(patient) : 'Appointment'} · {formatPence(total)}
          {depositPence > 0 ? (
            <span
              style={{
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.medium,
                color: theme.color.inkMuted,
                marginLeft: theme.space[2],
              }}
            >
              to collect
            </span>
          ) : null}
        </h1>
        {depositPence > 0 ? (
          <p
            style={{
              margin: `0 0 ${theme.space[3]}px`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>Subtotal {formatPence(subtotal)}</span>
            <span style={{ margin: `0 ${theme.space[2]}px` }}>·</span>
            <span style={{ color: theme.color.accent, fontWeight: theme.type.weight.semibold }}>
              Deposit −{formatPence(depositPence)}
            </span>
            <span style={{ color: theme.color.inkSubtle }}>
              {' '}
              ({deposit?.provider === 'stripe' ? 'Stripe' : 'PayPal'} via Calendly)
            </span>
          </p>
        ) : null}
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
                onClick={() => openBnpl('klarna')}
                disabled={!reader}
              />
              <MethodCard
                icon={<ShoppingBag size={20} />}
                title="Clearpay"
                description={`Customer's app caps the limit. Reader: ${reader?.friendly_name ?? '—'}`}
                onClick={() => openBnpl('clearpay')}
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
        <>
          <TerminalPaymentModal
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            visitId={visit?.id ?? ''}
            cartId={cart.id}
            amountPence={total}
            readerId={reader.id}
            readerName={reader.friendly_name}
            paymentJourney={journey === 'klarna' || journey === 'clearpay' ? journey : 'standard'}
            onSucceeded={(pid) => {
              setPaymentId(pid);
              setTerminalOpen(false);
              setStage('success');
            }}
          />
          {(journey === 'klarna' || journey === 'clearpay') ? (
            <BNPLHelper
              open={bnplOpen}
              onClose={() => setBnplOpen(false)}
              provider={journey}
              visitId={visit?.id ?? ''}
              cartId={cart.id}
              amountPence={total}
              readerId={reader.id}
              readerName={reader.friendly_name}
              onSucceeded={(pid) => {
                setPaymentId(pid);
                setBnplOpen(false);
                setStage('success');
              }}
            />
          ) : null}
        </>
      ) : null}

      {error ? (
        <div style={{ position: 'fixed', bottom: theme.space[6], left: '50%', transform: 'translateX(-50%)', zIndex: 100 }}>
          <Toast tone="error" title="Could not record payment" description={error} duration={8000} onDismiss={() => setError(null)} />
        </div>
      ) : null}
    </main>
  );
}

function PayBreadcrumbs({
  visitId,
  entry,
}: {
  visitId: string | null;
  entry: PayEntryState | null;
}) {
  const navigate = useNavigate();
  const e = entry ?? {};

  const items = (() => {
    // Entered from a visit page: render the full chain so each crumb
    // pops back to the right step. The "Visit" crumb preserves the
    // visit's own entry state so its breadcrumb stays intact when
    // navigated back to.
    if (e.from === 'visit' && e.visitId && e.visitOpenedAt) {
      // Pay's chain has no separate patient crumb, so the visit
      // crumb takes ownership of the patient name. Falls back to
      // bare "Appt. {date}" when the name isn't in state.
      const visitLabel = formatVisitCrumb({
        name: e.visitEntry?.patientName ?? null,
        openedAtIso: e.visitOpenedAt,
        includeName: true,
      });
      const visitState = e.visitEntry ?? null;
      const visitFrom = visitState?.from;
      const baseCrumb =
        visitFrom === 'patient'
          ? { label: 'Patients', onClick: () => navigate('/patients') }
          : visitFrom === 'in_clinic'
            ? { label: 'In clinic', onClick: () => navigate('/in-clinic') }
            : { label: 'Schedule', onClick: () => navigate('/schedule') };
      return [
        baseCrumb,
        {
          label: visitLabel,
          onClick: () =>
            navigate(`/visit/${e.visitId}`, {
              state: visitState ?? undefined,
            }),
        },
        { label: 'Take payment' },
      ];
    }
    // No entry state — direct URL paste or browser refresh. Show a
    // sensible default that still gets the receptionist out via the
    // visit page.
    return [
      { label: 'Schedule', onClick: () => navigate('/schedule') },
      visitId
        ? { label: 'Appointment', onClick: () => navigate(`/visit/${visitId}`) }
        : { label: 'Appointment' },
      { label: 'Take payment' },
    ];
  })();

  return (
    <div style={{ margin: `${theme.space[3]}px 0 ${theme.space[6]}px` }}>
      <Breadcrumb items={items} />
    </div>
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
