import { useEffect, useState } from 'react';
import { CheckCircle2, CreditCard, Loader2, XCircle } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { theme } from '../../theme/index.ts';
import { supabase } from '../../lib/supabase.ts';
import { formatPence } from '../../lib/queries/carts.ts';

export type TerminalState = 'idle' | 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface TerminalPaymentModalProps {
  open: boolean;
  onClose: () => void;
  visitId: string;
  cartId: string;
  amountPence: number;
  readerId: string;
  readerName: string;
  paymentJourney?: 'standard' | 'klarna' | 'clearpay';
  onSucceeded?: (paymentId: string) => void;
}

interface PaymentRow {
  id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  failure_reason: string | null;
  succeeded_at: string | null;
  cancelled_at: string | null;
}

export function TerminalPaymentModal({
  open,
  onClose,
  visitId,
  cartId: _cartId,
  amountPence,
  readerId,
  readerName,
  paymentJourney = 'standard',
  onSucceeded,
}: TerminalPaymentModalProps) {
  const [state, setState] = useState<TerminalState>('idle');
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setState('idle');
      setPaymentId(null);
      setError(null);
    }
  }, [open, visitId]);

  // Realtime subscription on the lng_payments row, keyed on payment_id.
  // Belt-and-braces: we ALSO poll terminal-payment-status on a 4s
  // cadence below so a missing webhook (e.g. wrong endpoint configured
  // in Stripe live vs test mode) can't leave the till stuck while the
  // customer has actually paid. Either path lands on the same
  // succeeded/failed/cancelled transitions.
  useEffect(() => {
    if (!paymentId) return;
    const channel = supabase
      .channel(`lng_payments:${paymentId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lng_payments', filter: `id=eq.${paymentId}` },
        (payload) => {
          const next = payload.new as PaymentRow;
          if (next.status === 'succeeded') {
            setState('succeeded');
            onSucceeded?.(next.id);
          } else if (next.status === 'failed') {
            setState('failed');
            setError(next.failure_reason ?? 'Payment failed');
          } else if (next.status === 'cancelled') {
            setState('cancelled');
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [paymentId, onSucceeded]);

  // Poll-based reconciler. While the modal is in 'waiting' (PI is at
  // Stripe but we haven't seen a terminal status yet), every 4s we
  // ask terminal-payment-status to GET the PI from Stripe and mirror
  // its status into local state. This is a reliability backstop for
  // the realtime/webhook path — if the Stripe webhook never lands
  // (endpoint misconfigured for the active mode, network blip,
  // function down) we still notice within ~4s of the customer's tap.
  // The function is idempotent — repeated calls against the same PI
  // produce no extra writes once local state matches Stripe.
  useEffect(() => {
    if (!paymentId) return;
    if (state !== 'waiting' && state !== 'starting') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        const r = await fetch(
          `https://${supabaseProjectRef()}.functions.supabase.co/terminal-payment-status`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_id: paymentId }),
          },
        );
        if (!r.ok) return;
        const body = (await r.json()) as { local_status?: string | null };
        if (cancelled) return;
        if (body.local_status === 'succeeded') {
          setState('succeeded');
          onSucceeded?.(paymentId);
        } else if (body.local_status === 'failed') {
          setState('failed');
          // The realtime channel will hydrate the failure_reason via
          // its UPDATE event; until then keep a generic message.
          setError((prev) => prev ?? 'Payment failed');
        } else if (body.local_status === 'cancelled') {
          setState('cancelled');
        }
      } catch {
        // Best-effort. Don't surface poll-side errors to staff —
        // realtime may still come through, and the next tick retries.
      }
    };
    const interval = setInterval(() => {
      void tick();
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paymentId, state, onSucceeded]);

  const start = async () => {
    setState('starting');
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Not signed in');
      const r = await fetch(
        `https://${supabaseProjectRef()}.functions.supabase.co/terminal-start-payment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visit_id: visitId,
            amount_pence: amountPence,
            reader_id: readerId,
            payment_journey: paymentJourney,
          }),
        }
      );
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? 'Could not start payment');
      setPaymentId(body.payment_id);
      setState('waiting');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setState('idle');
    }
  };

  const cancel = async () => {
    if (!paymentId) {
      onClose();
      return;
    }
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Not signed in');
      const r = await fetch(
        `https://${supabaseProjectRef()}.functions.supabase.co/terminal-cancel-payment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_id: paymentId }),
        }
      );
      // 409 = Stripe already captured this PI; the function reconciled
      // local state to succeeded instead of cancelling. Flip the modal
      // to the success path so staff doesn't re-take payment.
      if (r.status === 409) {
        setState('succeeded');
        onSucceeded?.(paymentId);
        return;
      }
      setState('cancelled');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not cancel');
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={state === 'waiting' || state === 'starting' ? () => undefined : onClose}
      title={
        paymentJourney === 'klarna'
          ? `Klarna · ${formatPence(amountPence)}`
          : paymentJourney === 'clearpay'
            ? `Clearpay · ${formatPence(amountPence)}`
            : `Card · ${formatPence(amountPence)}`
      }
      description={`Reader: ${readerName}`}
      dismissable={state === 'idle' || state === 'failed' || state === 'cancelled' || state === 'succeeded'}
      footer={renderFooter()}
    >
      {renderBody()}
    </BottomSheet>
  );

  function renderBody() {
    switch (state) {
      case 'idle':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.space[4], padding: `${theme.space[6]}px 0` }}>
            <CreditCard size={48} style={{ color: theme.color.ink }} />
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.ink, fontSize: theme.type.size.md }}>
              When the customer is ready, send the {formatPence(amountPence)} request to the reader.
            </p>
            {paymentJourney !== 'standard' ? (
              <p style={{ margin: 0, textAlign: 'center', color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                Receipt will say <strong>Visa contactless</strong>. That is correct for {paymentJourney === 'klarna' ? 'Klarna' : 'Clearpay'}.
              </p>
            ) : null}
          </div>
        );
      case 'starting':
      case 'waiting':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.space[4], padding: `${theme.space[6]}px 0` }}>
            <Loader2 size={48} style={{ color: theme.color.accent, animation: 'lng-spin 0.8s linear infinite' }} />
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.ink, fontSize: theme.type.size.md }}>
              {state === 'starting' ? 'Sending to reader…' : 'Waiting for the customer to tap or insert.'}
            </p>
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
              The reader screen shows the next step.
            </p>
            <style>{`@keyframes lng-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        );
      case 'succeeded':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.space[4], padding: `${theme.space[6]}px 0` }}>
            <CheckCircle2 size={56} style={{ color: theme.color.accent }} />
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.ink, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              {formatPence(amountPence)} paid
            </p>
            {paymentJourney !== 'standard' ? (
              <p style={{ margin: 0, textAlign: 'center', color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
                Their {paymentJourney === 'klarna' ? 'Klarna' : 'Clearpay'} app will show the instalment plan within a minute.
              </p>
            ) : null}
          </div>
        );
      case 'failed':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.space[4], padding: `${theme.space[6]}px 0` }}>
            <XCircle size={48} style={{ color: theme.color.alert }} />
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.ink, fontSize: theme.type.size.md }}>
              {error ?? 'Payment failed.'}
            </p>
          </div>
        );
      case 'cancelled':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.space[4], padding: `${theme.space[6]}px 0` }}>
            <p style={{ margin: 0, textAlign: 'center', color: theme.color.inkMuted, fontSize: theme.type.size.md }}>
              Payment cancelled.
            </p>
          </div>
        );
    }
  }

  function renderFooter() {
    if (state === 'idle') {
      return (
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
          <Button variant="tertiary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={start} showArrow>Send to reader</Button>
        </div>
      );
    }
    if (state === 'starting' || state === 'waiting') {
      return (
        <Button variant="secondary" onClick={cancel} fullWidth>
          Cancel payment
        </Button>
      );
    }
    if (state === 'succeeded') {
      return (
        <Button variant="primary" onClick={onClose} fullWidth showArrow>
          Done
        </Button>
      );
    }
    if (state === 'failed') {
      return (
        <div style={{ display: 'flex', gap: theme.space[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={start}>Try again</Button>
        </div>
      );
    }
    return (
      <Button variant="primary" onClick={onClose} fullWidth>
        Close
      </Button>
    );
  }
}

function supabaseProjectRef(): string {
  // Extract project ref from VITE_SUPABASE_URL like https://abc.supabase.co
  const url = new URL(import.meta.env.VITE_SUPABASE_URL);
  return url.hostname.split('.')[0]!;
}
