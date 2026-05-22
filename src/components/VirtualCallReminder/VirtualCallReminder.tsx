import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Loader2, MessageSquare, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';

// VirtualCallReminder — text-the-patient affordance that sits under
// MeetingLinkCard on a virtual impression appointment. Reception
// fires this when the clinician is on the Meet call but the
// patient hasn't joined yet — the SMS carries the join URL so the
// patient taps straight through from their phone.
//
// Flow:
//   • Inline pill button "Text the join link" → opens BottomSheet
//   • Sheet fetches a preview via send-visit-ready-sms with
//     { appointment_id, template_key: 'virtual_call_waiting',
//       preview: true } so the user sees the exact text before it
//     goes out
//   • "Send now" fires the same function without preview; on
//     success the sheet auto-closes after a moment so the
//     receptionist isn't stuck on a confirmation screen.
//
// Twilio delivery status + history land in lng_sms_messages
// (audited by appointment_id, since the visit row doesn't exist
// yet) and show on the patient timeline. No realtime polling on
// this card — the visit page surfaces delivery state once the
// patient actually joins.

const TEMPLATE_KEY = 'virtual_call_waiting';

interface VirtualCallReminderProps {
  appointmentId: string;
  /** Used only to disable the button when the patient has no phone
   *  on file — keeps the receptionist from clicking through to a
   *  sheet that will immediately error. The edge function does its
   *  own check too. */
  patientHasPhone: boolean;
}

export function VirtualCallReminder({
  appointmentId,
  patientHasPhone,
}: VirtualCallReminderProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const disabled = !patientHasPhone;
  return (
    <>
      {/* Action-row visual: full-width tappable strip with a circular
          icon disc, label + sub-description, trailing chevron. Mirrors
          the pattern used by "Join meeting", "Patient profile",
          "Mark as no-show" etc. so the SMS reminder reads as the
          same kind of affordance, not a stray pill. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={
          disabled
            ? 'Add a phone number to the patient before sending an SMS.'
            : undefined
        }
        style={{
          appearance: 'none',
          width: '100%',
          marginTop: theme.space[3],
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          background: hover && !disabled ? theme.color.bg : theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: theme.color.ink,
          opacity: disabled ? 0.55 : 1,
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          WebkitTapHighlightColor: 'transparent',
          boxShadow: theme.shadow.card,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: theme.radius.pill,
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            color: theme.color.ink,
            flexShrink: 0,
          }}
        >
          <MessageSquare size={16} aria-hidden />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Text the join link to the patient
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 2,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            {disabled
              ? 'No phone number on file'
              : "Preview before it goes out — sends the meeting URL to the patient's mobile."}
          </span>
        </span>
        <ChevronRight
          size={16}
          aria-hidden
          style={{ color: theme.color.inkSubtle, flexShrink: 0 }}
        />
      </button>
      <ReminderSheet
        open={open}
        onClose={() => setOpen(false)}
        appointmentId={appointmentId}
      />
    </>
  );
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; body: string; to: string }
  | { status: 'error'; message: string };

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; to: string }
  | { status: 'error'; message: string };

function ReminderSheet({
  open,
  onClose,
  appointmentId,
}: {
  open: boolean;
  onClose: () => void;
  appointmentId: string;
}) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [send, setSend] = useState<SendState>({ status: 'idle' });

  // Preview pass on open. Re-fires when appointmentId changes (won't
  // in practice — the card is mounted per-appointment — but keeps the
  // effect dependencies honest).
  useEffect(() => {
    if (!open) {
      setPreview({ status: 'idle' });
      setSend({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setPreview({ status: 'loading' });
    (async () => {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        body?: string;
        to?: string;
        error?: string;
      }>('send-visit-ready-sms', {
        body: {
          appointment_id: appointmentId,
          template_key: TEMPLATE_KEY,
          preview: true,
        },
      });
      if (cancelled) return;
      if (error) {
        setPreview({ status: 'error', message: error.message });
        return;
      }
      if (!data || data.ok !== true || !data.body) {
        setPreview({
          status: 'error',
          message: data?.error ?? 'Could not load the preview.',
        });
        return;
      }
      setPreview({
        status: 'loaded',
        body: data.body,
        to: data.to ?? '',
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, appointmentId]);

  const handleSend = useCallback(async () => {
    setSend({ status: 'sending' });
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      body?: string;
      to?: string;
      error?: string;
    }>('send-visit-ready-sms', {
      body: {
        appointment_id: appointmentId,
        template_key: TEMPLATE_KEY,
      },
    });
    if (error) {
      setSend({ status: 'error', message: error.message });
      return;
    }
    if (!data || data.ok !== true) {
      setSend({ status: 'error', message: data?.error ?? 'Send failed.' });
      return;
    }
    setSend({ status: 'sent', to: data.to ?? '' });
    // Auto-close after a short delay so the receptionist sees the
    // success state before the sheet goes away.
    setTimeout(onClose, 1200);
  }, [appointmentId, onClose]);

  const canSend = preview.status === 'loaded' && send.status !== 'sending' && send.status !== 'sent';

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Text the join link to the patient"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <PreviewPanel preview={preview} />
        {send.status === 'error' ? (
          <ResultPanel tone="error" message={send.message} />
        ) : null}
        {send.status === 'sent' ? (
          <ResultPanel tone="success" message={`Sent to ${send.to}.`} />
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[3] }}>
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" onClick={handleSend} disabled={!canSend} loading={send.status === 'sending'}>
            <Send size={14} aria-hidden />
            {send.status === 'sending' ? 'Sending' : 'Send now'}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function PreviewPanel({ preview }: { preview: PreviewState }) {
  if (preview.status === 'loading' || preview.status === 'idle') {
    return (
      <div
        style={{
          padding: theme.space[4],
          background: theme.color.bg,
          borderRadius: theme.radius.input,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <Loader2 size={14} aria-hidden style={{ animation: 'lng-spin 900ms linear infinite' }} />
        Rendering preview…
      </div>
    );
  }
  if (preview.status === 'error') {
    return <ResultPanel tone="error" message={preview.message} />;
  }
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Preview
        </span>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          To {preview.to}
        </span>
      </header>
      <div
        style={{
          padding: theme.space[4],
          background: theme.color.bg,
          borderRadius: theme.radius.input,
          color: theme.color.ink,
          fontSize: theme.type.size.sm,
          whiteSpace: 'pre-wrap',
          lineHeight: theme.type.leading.snug,
        }}
      >
        {preview.body}
      </div>
    </section>
  );
}

function ResultPanel({
  tone,
  message,
}: {
  tone: 'success' | 'error';
  message: string;
}) {
  const isError = tone === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      style={{
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: isError ? '#FFF1F1' : theme.color.accentBg,
        border: `1px solid ${isError ? '#F5C2C2' : theme.color.accent}`,
        color: isError ? theme.color.alert : theme.color.ink,
        fontSize: theme.type.size.sm,
      }}
    >
      {message}
    </div>
  );
}
