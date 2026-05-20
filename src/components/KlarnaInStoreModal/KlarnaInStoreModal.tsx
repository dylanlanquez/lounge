import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../Button/Button.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { theme } from '../../theme/index.ts';
import { supabase } from '../../lib/supabase.ts';
import { callEdgeFunction } from '../../lib/edgeFunction.ts';
import { formatPence } from '../../lib/queries/carts.ts';

// KlarnaInStoreModal
//
// Display surface for Klarna's native In-Store API (Dynamic QR +
// payment link). Replaces the BNPLHelper walkthrough for Klarna —
// staff hits "Pay with Klarna", we open this modal, it talks to
// klarna-create-session, shows the QR + payment link, and waits
// for the webhook (cross-verified) to flip the lng_klarna_sessions
// row to status='captured'.
//
// Why a single component (no preflight / no-app / steps stages
// like BNPLHelper):
//   • Klarna's QR flow handles install + sign-in + plan selection
//     inside the customer's own Klarna app journey. We don't ask
//     "do you have the app?" — the QR deep-link installs it if
//     not, and Klarna's app guides the customer from there.
//   • Staff just shows the QR. Less to read, less to mis-type,
//     fewer rejection paths.
//
// Status machine, mirroring lng_klarna_sessions.status:
//   • starting          — create-session in flight
//   • awaiting_customer — QR shown, waiting for scan + complete
//   • captured          — webhook reported COMPLETED + cross-verified
//   • cancelled         — staff hit Cancel
//   • expired / failed  — Klarna terminal failure
//
// Realtime: lng_klarna_sessions is in supabase_realtime; we
// subscribe to UPDATE events for our row id and flip state the
// instant the webhook handler captures the order. The polling
// backstop (every 4s) covers the realtime-channel-dropped edge
// case (mobile back-tab, transient network).

export type KlarnaModalState =
  | 'starting'
  | 'awaiting_customer'
  | 'captured'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface KlarnaInStoreModalProps {
  open: boolean;
  onClose: () => void;
  visitId: string;
  cartId: string;
  amountPence: number;
  onSucceeded?: (paymentId: string) => void;
}

interface SessionRow {
  id: string;
  payment_id: string;
  status:
    | 'pending'
    | 'awaiting_customer'
    | 'captured'
    | 'cancelled'
    | 'expired'
    | 'failed';
  qr_code_url: string | null;
  payment_link_url: string | null;
  expires_at: string | null;
}

interface CreateSessionResponse {
  ok: boolean;
  session_row_id?: string;
  payment_id?: string;
  klarna_session_id?: string;
  qr_code_url?: string | null;
  payment_link_url?: string | null;
  expires_at?: string | null;
  status?: string;
  error?: string;
}

export function KlarnaInStoreModal({
  open,
  onClose,
  visitId,
  cartId: _cartId,
  amountPence,
  onSucceeded,
}: KlarnaInStoreModalProps) {
  const [state, setState] = useState<KlarnaModalState>('starting');
  const [sessionRowId, setSessionRowId] = useState<string | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [paymentLinkUrl, setPaymentLinkUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);

  // Reset on fresh open. Same attempt-id pattern as the Stripe
  // modal — stable across HTTP retries of one user gesture so the
  // edge function's idempotency key lands on the same Klarna
  // session row.
  useEffect(() => {
    if (open) {
      setState('starting');
      setSessionRowId(null);
      setQrCodeUrl(null);
      setPaymentLinkUrl(null);
      setExpiresAt(null);
      setError(null);
      setAttemptId(crypto.randomUUID());
    }
  }, [open, visitId]);

  // Kick off the create-session call once we have an attempt id.
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !attemptId) return;
    if (startedRef.current === attemptId) return;
    startedRef.current = attemptId;
    void (async () => {
      try {
        const r = await callEdgeFunction<CreateSessionResponse>('klarna-create-session', {
          visit_id: visitId,
          amount_pence: amountPence,
          attempt_id: attemptId,
        });
        if (!r.ok || !r.body.ok) {
          setError(r.body.error ?? 'Could not start Klarna session');
          setState('failed');
          return;
        }
        const b = r.body;
        setSessionRowId(b.session_row_id ?? null);
        setQrCodeUrl(b.qr_code_url ?? null);
        setPaymentLinkUrl(b.payment_link_url ?? null);
        setExpiresAt(b.expires_at ?? null);
        const nextStatus =
          b.status === 'captured' ? 'captured' :
          b.status === 'awaiting_customer' ? 'awaiting_customer' :
          b.status === 'failed' ? 'failed' :
          'awaiting_customer';
        setState(nextStatus);
        if (b.status === 'captured' && b.payment_id) {
          onSucceeded?.(b.payment_id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
        setState('failed');
      }
    })();
  }, [open, attemptId, visitId, amountPence, onSucceeded]);

  // Realtime subscription on the session row.
  useEffect(() => {
    if (!sessionRowId) return;
    const channel = supabase
      .channel(`lng_klarna_sessions:${sessionRowId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'lng_klarna_sessions',
          filter: `id=eq.${sessionRowId}`,
        },
        (payload) => {
          const next = payload.new as SessionRow;
          if (next.qr_code_url) setQrCodeUrl(next.qr_code_url);
          if (next.payment_link_url) setPaymentLinkUrl(next.payment_link_url);
          if (next.expires_at) setExpiresAt(next.expires_at);
          if (next.status === 'captured') {
            setState('captured');
            if (next.payment_id) onSucceeded?.(next.payment_id);
          } else if (next.status === 'cancelled') {
            setState('cancelled');
          } else if (next.status === 'expired') {
            setState('expired');
          } else if (next.status === 'failed') {
            setState('failed');
          } else if (next.status === 'awaiting_customer') {
            setState('awaiting_customer');
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionRowId, onSucceeded]);

  // Polling backstop. Realtime channels can drop on mobile when
  // the tab loses focus; without this the till would stay on
  // "Waiting for customer" indefinitely after a successful
  // capture. Polls every 4s while we're in awaiting_customer.
  useEffect(() => {
    if (!sessionRowId) return;
    if (state !== 'awaiting_customer') return;
    let cancelled = false;
    const tick = async () => {
      const { data } = await supabase
        .from('lng_klarna_sessions')
        .select('status, payment_id, qr_code_url, payment_link_url, expires_at')
        .eq('id', sessionRowId)
        .maybeSingle();
      if (cancelled || !data) return;
      const row = data as {
        status: SessionRow['status'];
        payment_id: string;
        qr_code_url: string | null;
        payment_link_url: string | null;
        expires_at: string | null;
      };
      if (row.qr_code_url && !qrCodeUrl) setQrCodeUrl(row.qr_code_url);
      if (row.payment_link_url && !paymentLinkUrl) setPaymentLinkUrl(row.payment_link_url);
      if (row.expires_at && !expiresAt) setExpiresAt(row.expires_at);
      if (row.status === 'captured') {
        setState('captured');
        if (row.payment_id) onSucceeded?.(row.payment_id);
      } else if (row.status === 'cancelled') {
        setState('cancelled');
      } else if (row.status === 'expired') {
        setState('expired');
      } else if (row.status === 'failed') {
        setState('failed');
      }
    };
    const interval = setInterval(() => { void tick(); }, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionRowId, state, qrCodeUrl, paymentLinkUrl, expiresAt, onSucceeded]);

  const cancelSession = async () => {
    if (!sessionRowId) {
      onClose();
      return;
    }
    try {
      const r = await callEdgeFunction<{ ok: boolean; already_cancelled?: boolean; error?: string }>(
        'klarna-cancel-session',
        { session_row_id: sessionRowId },
      );
      if (!r.ok) {
        setError(r.body.error ?? 'Could not cancel session');
        return;
      }
      setState('cancelled');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel');
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        // While the session is awaiting the customer, closing the
        // modal must cancel the Klarna session — otherwise we'd
        // leave a live QR floating that could still be scanned and
        // pay against an abandoned visit. Captured / failed /
        // cancelled states are terminal; closing just closes.
        if (state === 'awaiting_customer' || state === 'starting') {
          void cancelSession();
        }
        onClose();
      }}
      dismissable={state !== 'starting'}
      title={`Klarna · ${formatPence(amountPence)}`}
      description={describeState(state)}
      footer={
        <div
          style={{
            display: 'flex',
            gap: theme.space[3],
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          {state === 'captured' ? (
            <Button variant="primary" onClick={onClose}>Done</Button>
          ) : state === 'cancelled' || state === 'expired' || state === 'failed' ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setAttemptId(crypto.randomUUID());
                  setState('starting');
                  setError(null);
                  startedRef.current = null;
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                  <RefreshCw size={16} /> Try again
                </span>
              </Button>
              <Button variant="primary" onClick={onClose}>Close</Button>
            </>
          ) : (
            <Button variant="secondary" onClick={cancelSession}>Cancel</Button>
          )}
        </div>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: theme.space[4],
          padding: `${theme.space[5]}px ${theme.space[4]}px`,
        }}
      >
        {state === 'starting' ? (
          <>
            <Loader2 size={32} style={{ animation: 'lng-spin 1.2s linear infinite', color: theme.color.inkMuted }} />
            <p style={{ margin: 0, color: theme.color.inkMuted }}>Starting Klarna session…</p>
          </>
        ) : state === 'awaiting_customer' ? (
          <>
            {qrCodeUrl ? (
              <div
                style={{
                  width: 280,
                  height: 280,
                  background: '#ffffff',
                  borderRadius: theme.radius.card,
                  border: `1px solid ${theme.color.border}`,
                  padding: theme.space[3],
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <img
                  src={qrCodeUrl}
                  alt="Klarna QR code"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>
            ) : (
              <Loader2 size={32} style={{ animation: 'lng-spin 1.2s linear infinite', color: theme.color.inkMuted }} />
            )}
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                textAlign: 'center',
              }}
            >
              Customer scans the QR with their phone.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                textAlign: 'center',
                maxWidth: 360,
                lineHeight: 1.5,
              }}
            >
              Their Klarna app opens automatically. If they do not have
              Klarna, the link installs it and guides them through
              sign-up. They confirm the plan and pay inside the app.
            </p>
            {paymentLinkUrl ? (
              <button
                type="button"
                onClick={() => {
                  if (navigator.clipboard && paymentLinkUrl) {
                    void navigator.clipboard.writeText(paymentLinkUrl);
                  }
                }}
                style={{
                  appearance: 'none',
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: theme.radius.pill,
                  background: theme.color.surface,
                  color: theme.color.inkMuted,
                  padding: `${theme.space[2]}px ${theme.space[4]}px`,
                  fontSize: theme.type.size.xs,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Copy payment link
              </button>
            ) : null}
            {expiresAt ? (
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                }}
              >
                QR expires at {new Date(expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </p>
            ) : null}
          </>
        ) : state === 'captured' ? (
          <>
            <CheckCircle2 size={48} style={{ color: theme.color.accent }} />
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              Paid {formatPence(amountPence)}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                textAlign: 'center',
                maxWidth: 360,
                lineHeight: 1.5,
              }}
            >
              Customer's Klarna app shows the instalment plan. Their
              first payment is taken now and the schedule continues
              from their app.
            </p>
          </>
        ) : state === 'cancelled' ? (
          <>
            <XCircle size={48} style={{ color: theme.color.inkMuted }} />
            <p style={{ margin: 0, fontSize: theme.type.size.md, color: theme.color.ink }}>
              Klarna session cancelled.
            </p>
          </>
        ) : (
          <>
            <XCircle size={48} style={{ color: theme.color.alert }} />
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                color: theme.color.ink,
                textAlign: 'center',
              }}
            >
              {state === 'expired' ? 'Session expired before payment.' : 'Klarna could not complete the payment.'}
            </p>
            {error ? (
              <p
                style={{
                  margin: 0,
                  fontSize: theme.type.size.sm,
                  color: theme.color.inkMuted,
                  textAlign: 'center',
                  maxWidth: 360,
                }}
              >
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </BottomSheet>
  );
}

function describeState(state: KlarnaModalState): string {
  switch (state) {
    case 'starting':
      return 'Asking Klarna for a QR code.';
    case 'awaiting_customer':
      return 'Show the QR to the customer. They pay in their Klarna app.';
    case 'captured':
      return 'Customer completed the payment in Klarna.';
    case 'cancelled':
      return 'The session has been cancelled.';
    case 'expired':
      return 'The Klarna session timed out.';
    case 'failed':
      return 'Klarna reported a failure.';
  }
}
