import { useEffect, useMemo, useState } from 'react';
import { Mail, MessageSquare, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';

// SendReceiptSheet
//
// Re-sends the receipt for the cart's most recent succeeded
// payment. Same mechanism the Pay flow uses on the initial take:
// insert lng_receipts row → invoke send-receipt edge function.
// The function renders the canonical email template (Resend
// from clinic@notifications.venneir.com) or the payment_receipt
// SMS template (Twilio Messaging Service, "Venneir" sender) and
// records the attempt on the patient timeline regardless of
// outcome.
//
// Visible only after at least one succeeded payment exists on
// the cart (gated at the caller). Renders nothing until the
// caller opens it.

export interface SendReceiptSheetProps {
  open: boolean;
  onClose: () => void;
  /** Payment id to attach the receipt row to. Caller picks (usually
   *  the most recent succeeded payment on the cart). When null the
   *  sheet renders an empty state — defensive, shouldn't happen
   *  given the action menu's gate, but keeps the surface from
   *  crashing if the cart shape shifts mid-render. */
  paymentId: string | null;
  /** Patient's email on file. Pre-filled into the recipient input
   *  when channel='email'. */
  patientEmail: string | null;
  /** Patient's phone on file. Pre-filled when channel='sms'. */
  patientPhone: string | null;
}

type Channel = 'email' | 'sms';

export function SendReceiptSheet({
  open,
  onClose,
  paymentId,
  patientEmail,
  patientPhone,
}: SendReceiptSheetProps) {
  const [channel, setChannel] = useState<Channel>('email');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Reset state on each fresh open so a previous send result
  // doesn't bleed into a follow-up open. Channel defaults to
  // email — most receipts go via email today, and SMS is the
  // exception.
  useEffect(() => {
    if (!open) return;
    setChannel('email');
    setRecipient((patientEmail ?? '').trim());
    setBusy(false);
    setError(null);
    setSent(false);
  }, [open, patientEmail]);

  // When the staff flips the channel, refresh the recipient
  // to the patient's value for that channel. Keeps the input
  // useful without forcing the staff to clear + retype.
  useEffect(() => {
    if (!open) return;
    setRecipient(((channel === 'email' ? patientEmail : patientPhone) ?? '').trim());
    setError(null);
  }, [channel, open, patientEmail, patientPhone]);

  const trimmedRecipient = recipient.trim();
  const recipientValid = useMemo(() => {
    if (!trimmedRecipient) return false;
    if (channel === 'email') return /.+@.+\..+/.test(trimmedRecipient);
    return /[0-9+]/.test(trimmedRecipient) && trimmedRecipient.replace(/\D/g, '').length >= 9;
  }, [channel, trimmedRecipient]);

  const handleSend = async () => {
    if (!paymentId) {
      setError('No payment to attach the receipt to.');
      return;
    }
    if (!recipientValid) {
      setError(channel === 'email' ? 'Enter a valid email address.' : 'Enter a valid phone number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Insert the queued lng_receipts row, then hand to send-receipt
      // which flips it to sent / writes the failure_reason and emits
      // the timeline event. Identical to the Pay flow's path so a
      // resend from here lands in the same audit pipeline as the
      // original send.
      const { data: row, error: insErr } = await supabase
        .from('lng_receipts')
        .insert({
          payment_id: paymentId,
          channel,
          recipient: trimmedRecipient,
          content: null,
        })
        .select('id')
        .single();
      if (insErr || !row) throw new Error(insErr?.message ?? 'Could not queue receipt.');

      const { data: result, error: invokeErr } = await supabase.functions.invoke<{
        ok?: boolean;
        error?: string;
      }>('send-receipt', {
        body: { receiptId: (row as { id: string }).id },
      });
      if (invokeErr) {
        setError(`Couldn't send: ${invokeErr.message}. The row is queued, retry from /admin.`);
        return;
      }
      if (result && result.ok !== true) {
        setError(`Couldn't send: ${result.error ?? 'unknown error'}. The row is queued, retry from /admin.`);
        return;
      }
      setSent(true);
      // Auto-close after the confirmation has a beat to land — the
      // caller doesn't need to be involved beyond opening the sheet.
      window.setTimeout(() => onClose(), 1200);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Send receipt">
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.sm }}>
          Resend the receipt for the most recent payment. The
          original payment record stays untouched.
        </p>

        {/* Channel picker — two cards, same shape as the Pay
            flow's receipt-channel options so the surface reads
            consistently between the initial send and a resend. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <ChannelCard
            label="Email"
            hint="Sent from clinic@notifications.venneir.com."
            icon={<Mail size={18} aria-hidden />}
            selected={channel === 'email'}
            onClick={() => setChannel('email')}
          />
          <ChannelCard
            label="SMS"
            hint="Texted from Venneir, using the payment_receipt template."
            icon={<MessageSquare size={18} aria-hidden />}
            selected={channel === 'sms'}
            onClick={() => setChannel('sms')}
          />
        </div>

        <Input
          label={channel === 'email' ? 'Email address' : 'Phone number'}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder={
            channel === 'email'
              ? patientEmail ?? 'name@example.com'
              : patientPhone ?? '+44...'
          }
          type={channel === 'email' ? 'email' : 'tel'}
          autoCorrect="off"
          spellCheck={false}
        />

        {error ? (
          <div
            role="alert"
            style={{
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.card,
              background: '#FDECEC',
              border: '1px solid #F1BFBF',
              color: '#7C1D1D',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
            }}
          >
            {error}
          </div>
        ) : null}

        {sent ? (
          <div
            role="status"
            style={{
              padding: `${theme.space[3]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.card,
              background: '#E8F5EC',
              border: '1px solid #B8DCC1',
              color: '#13502B',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
            }}
          >
            Receipt handed off for {trimmedRecipient}.
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSend()}
            disabled={busy || sent || !recipientValid || !paymentId}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Send size={14} aria-hidden />
              {busy ? 'Sending…' : sent ? 'Sent' : 'Send receipt'}
            </span>
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function ChannelCard({
  label,
  hint,
  icon,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        appearance: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        background: selected ? theme.color.ink : theme.color.surface,
        color: selected ? theme.color.surface : theme.color.ink,
        border: `1px solid ${selected ? theme.color.ink : theme.color.border}`,
        borderRadius: theme.radius.card,
        padding: `${theme.space[4]}px ${theme.space[4]}px`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        fontFamily: 'inherit',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span
        aria-hidden
        style={{
          color: selected ? theme.color.surface : theme.color.inkMuted,
          paddingTop: 2,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: theme.type.weight.semibold, fontSize: theme.type.size.base }}>
          {label}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: selected ? 'rgba(255,255,255,0.78)' : theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {hint}
        </span>
      </span>
    </button>
  );
}
