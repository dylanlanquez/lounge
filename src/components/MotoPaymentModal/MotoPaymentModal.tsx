import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, CreditCard, Link2, Loader2, XCircle } from 'lucide-react';
import { Elements, CardElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Button } from '../Button/Button.tsx';
import { Checkbox } from '../Checkbox/Checkbox.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { theme } from '../../theme/index.ts';
import { env } from '../../lib/env.ts';
import { supabase } from '../../lib/supabase.ts';
import { formatPence } from '../../lib/queries/carts.ts';
import { useClinicSettings } from '../../lib/queries/clinicSettings.ts';

// loadStripe returns a singleton per key string, so this reuses one Stripe
// instance across opens. Replicated (not imported) from the booking widget so
// the widget bundle stays untouched.
const stripeSingletons = new Map<string, Promise<Stripe | null>>();
function getStripeSingleton(publishableKey: string): Promise<Stripe | null> {
  let p = stripeSingletons.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripeSingletons.set(publishableKey, p);
  }
  return p;
}
function resolvePublishableKey(mode: 'live' | 'test'): string | null {
  if (mode === 'test') return env.STRIPE_PUBLISHABLE_KEY_TEST ?? null;
  return env.STRIPE_PUBLISHABLE_KEY_LIVE ?? env.STRIPE_PUBLISHABLE_KEY ?? null;
}

export interface MotoPaymentModalProps {
  open: boolean;
  onClose: () => void;
  visitId: string;
  amountPence: number;
  onSucceeded?: (paymentId: string) => void;
}

interface MotoResult {
  ok: boolean;
  status: 'succeeded' | 'requires_fallback' | 'failed';
  payment_id?: string | null;
  payment_intent_id?: string | null;
  stripe_code?: string | null;
  decline_code?: string | null;
  message?: string;
  next_action?: 'done' | 'retry' | 'fallback' | 'retry_or_fallback';
}

export function MotoPaymentModal({ open, onClose, visitId, amountPence, onSucceeded }: MotoPaymentModalProps) {
  const clinic = useClinicSettings();
  const stripeMode: 'live' | 'test' = clinic.data.stripeMode === 'test' ? 'test' : 'live';
  const publishableKey = resolvePublishableKey(stripeMode);
  const stripePromise = useMemo(() => (publishableKey ? getStripeSingleton(publishableKey) : null), [publishableKey]);

  if (!open) return null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Card payment over the phone"
      description={`Charge ${formatPence(amountPence)}`}
    >
      {stripePromise ? (
        <Elements stripe={stripePromise}>
          <MotoForm visitId={visitId} amountPence={amountPence} onSucceeded={onSucceeded} onClose={onClose} />
        </Elements>
      ) : (
        <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
          Card payments are not set up on this device. Tell support.
        </p>
      )}
    </BottomSheet>
  );
}

type Phase = 'form' | 'processing' | 'result';

function MotoForm({
  visitId,
  amountPence,
  onSucceeded,
  onClose,
}: {
  visitId: string;
  amountPence: number;
  onSucceeded?: (paymentId: string) => void;
  onClose: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [phase, setPhase] = useState<Phase>('form');
  const [permission, setPermission] = useState(false);
  const [cardComplete, setCardComplete] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [result, setResult] = useState<MotoResult | null>(null);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());

  const [linkBusy, setLinkBusy] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fire the cart refresh exactly once when a charge succeeds.
  useEffect(() => {
    if (result?.ok && result.status === 'succeeded' && result.payment_id) {
      onSucceeded?.(result.payment_id);
    }
  }, [result, onSucceeded]);

  const canCharge = !!stripe && !!elements && permission && cardComplete && phase === 'form';

  const charge = async () => {
    if (!stripe || !elements) return;
    const card = elements.getElement(CardElement);
    if (!card) return;
    setCardError(null);

    // Tokenise the card while it is still mounted. We must NOT switch to the
    // processing view first: that unmounts the CardElement, after which
    // createPaymentMethod throws "Element not mounted" and the modal hangs on
    // the spinner. .catch keeps a thrown IntegrationError from escaping.
    const pm = await stripe.createPaymentMethod({ type: 'card', card }).catch(() => null);
    if (!pm || pm.error || !pm.paymentMethod) {
      // Local validation / card-creation problem. Stay on the form with the
      // inline message; nothing was charged.
      setCardError(pm?.error?.message ?? 'The card details could not be read. Check them and try again.');
      return;
    }

    // We have the pm_ id; now it is safe to swap to the processing view.
    setPhase('processing');

    const { data, error } = await supabase.functions.invoke<MotoResult>('lng-moto-payment', {
      body: { visit_id: visitId, amount_pence: amountPence, payment_method_id: pm.paymentMethod.id, attempt_id: attemptId },
    });

    if (error || !data) {
      setResult({
        ok: false,
        status: 'failed',
        message: 'The payment could not be completed. Try again or use Send payment link.',
        next_action: 'retry_or_fallback',
      });
      setPhase('result');
      return;
    }
    setResult(data);
    setPhase('result');
  };

  const retry = () => {
    setResult(null);
    setLinkUrl(null);
    setLinkError(null);
    setCopied(false);
    setAttemptId(crypto.randomUUID()); // fresh idempotency key for a new attempt
    setPhase('form');
  };

  const sendPaymentLink = async () => {
    setLinkBusy(true);
    setLinkError(null);
    const { data, error } = await supabase.functions.invoke<{ ok: boolean; url?: string; error?: string }>(
      'lng-create-payment-link',
      { body: { visit_id: visitId, amount_pence: amountPence } },
    );
    setLinkBusy(false);
    if (error || !data?.ok || !data.url) {
      setLinkError(data?.error ?? 'The payment link could not be created. Try again.');
      return;
    }
    setLinkUrl(data.url);
  };

  const copyLink = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  // ---- Result screen ----
  if (phase === 'result' && result) {
    const success = result.ok && result.status === 'succeeded';
    const showRetry = result.next_action === 'retry' || result.next_action === 'retry_or_fallback';
    const showFallback = result.next_action === 'fallback' || result.next_action === 'retry_or_fallback';

    if (success) {
      return (
        <div style={col(theme.space[5])}>
          <div style={center}>
            <CheckCircle2 size={56} style={{ color: theme.color.accent }} />
            <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              {formatPence(amountPence)} paid
            </p>
          </div>
          <Button variant="primary" fullWidth onClick={onClose}>
            Done
          </Button>
        </div>
      );
    }

    return (
      <div style={col(theme.space[4])}>
        <div style={center}>
          <XCircle size={44} style={{ color: theme.color.alert }} />
          <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.md, fontWeight: theme.type.weight.semibold, color: theme.color.ink, textAlign: 'center' }}>
            {result.message ?? 'The payment could not be completed.'}
          </p>
          {result.stripe_code || result.payment_intent_id ? (
            <p style={{ margin: `${theme.space[2]}px 0 0`, fontSize: theme.type.size.xs, color: theme.color.inkSubtle, textAlign: 'center' }}>
              Reference: {[result.stripe_code, result.payment_intent_id].filter(Boolean).join(' ')}
            </p>
          ) : null}
        </div>

        {linkUrl ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], padding: theme.space[3], borderRadius: theme.radius.input, background: theme.color.accentBg }}>
            <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              Payment link ready
            </span>
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.ink, wordBreak: 'break-all' }}>{linkUrl}</span>
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>
              Read it out to the patient, or copy it to send by text or email.
            </span>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => void copyLink()}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                  <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy link'}
                </span>
              </Button>
            </div>
          </div>
        ) : null}

        {linkError ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>{linkError}</p>
        ) : null}

        <div style={{ display: 'flex', gap: theme.space[2], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {showRetry ? (
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          ) : null}
          {showFallback && !linkUrl ? (
            <Button variant="primary" onClick={() => void sendPaymentLink()} loading={linkBusy}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <Link2 size={16} aria-hidden /> Send payment link
              </span>
            </Button>
          ) : null}
          {!showRetry && !showFallback ? (
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- Processing ----
  if (phase === 'processing') {
    return (
      <div style={{ ...center, padding: `${theme.space[6]}px 0` }}>
        <Loader2 size={44} style={{ color: theme.color.accent, animation: 'lng-spin 0.8s linear infinite' }} />
        <p style={{ margin: `${theme.space[3]}px 0 0`, fontSize: theme.type.size.md, color: theme.color.ink }}>
          Taking the payment.
        </p>
      </div>
    );
  }

  // ---- Form ----
  return (
    <div style={col(theme.space[4])}>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], color: theme.color.inkMuted }}>
        <CreditCard size={18} aria-hidden />
        <span style={{ fontSize: theme.type.size.sm }}>Enter the patient's card details</span>
      </div>

      <div
        style={{
          background: theme.color.surface,
          borderRadius: theme.radius.input,
          padding: `${theme.space[4]}px`,
          boxShadow: `inset 0 0 0 1px ${cardError ? theme.color.alert : theme.color.border}`,
        }}
      >
        <CardElement
          options={{
            style: {
              base: {
                color: theme.color.ink,
                fontFamily: theme.type.family,
                fontSize: '16px',
                '::placeholder': { color: theme.color.inkSubtle },
              },
              invalid: { color: theme.color.alert },
            },
          }}
          onChange={(e) => {
            setCardComplete(e.complete);
            setCardError(e.error?.message ?? null);
          }}
        />
      </div>

      {cardError ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>{cardError}</p>
      ) : null}

      <Checkbox
        checked={permission}
        onChange={setPermission}
        label="Confirm the patient has given permission to charge this card over the phone."
      />

      <Button variant="primary" fullWidth disabled={!canCharge} onClick={() => void charge()}>
        Charge {formatPence(amountPence)}
      </Button>
    </div>
  );
}

const col = (gap: number): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap });
const center: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center' };
