import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquare, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { properCase } from '../../lib/queries/appointments.ts';

// VirtualCallReminder — the "Patient not on the virtual call" SMS
// surface that sits under MeetingLinkCard on a virtual impression
// appointment. Visual language is the exact same shape as
// PatientCommsCard on the Visit page: hero header with a chat-bubble
// icon disc + "Send an SMS" title + a subtitle naming the patient,
// then a status row below carrying the destination phone and a dark
// "Preview & send" pill on the trailing edge.
//
// No template picker here — the appointment surface fires exactly
// one template (`virtual_call_waiting`), so a dropdown would be a
// row of one. The picker is only on the Visit page where multiple
// templates make sense.
//
// Flow:
//   • Tap "Preview & send" → BottomSheet opens
//   • Sheet fetches a render of the SMS body via
//     send-visit-ready-sms with { appointment_id, template_key:
//     'virtual_call_waiting', preview: true } so reception sees the
//     exact text before it goes out
//   • "Send now" fires the same edge function without `preview`,
//     and the sheet auto-closes after success

const TEMPLATE_KEY = 'virtual_call_waiting';

export interface VirtualCallReminderProps {
  appointmentId: string;
  patientFirstName: string | null;
  patientPhone: string | null;
  onSent?: () => void;
}

export function VirtualCallReminder({
  appointmentId,
  patientFirstName,
  patientPhone,
  onSent,
}: VirtualCallReminderProps) {
  const [open, setOpen] = useState(false);
  const phoneOk = !!patientPhone && patientPhone.trim().length > 0;
  const properFirstName = properCase(patientFirstName ?? '') || 'the patient';
  const formattedPhone = formatUkPhone(patientPhone ?? '');
  return (
    <>
      <Card padding="lg">
        <SmsHeroHeader patientFirstName={properFirstName} />
        <div style={{ marginTop: theme.space[4] }}>
          <StatusRow
            phone={formattedPhone}
            onOpen={() => setOpen(true)}
            phoneOk={phoneOk}
          />
        </div>
      </Card>
      <ReminderSheet
        open={open}
        onClose={() => setOpen(false)}
        appointmentId={appointmentId}
        onSent={onSent}
      />
    </>
  );
}

// Hero header — accent disc + "Send an SMS" + subtitle naming who
// the message would go to. Matches PatientCommsCard's
// SmsHeroHeader exactly so the two surfaces read as one design.
function SmsHeroHeader({ patientFirstName }: { patientFirstName: string }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          flexShrink: 0,
        }}
      >
        <MessageSquare size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Patient not on the call?
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Send{' '}
          <strong style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
            {patientFirstName}
          </strong>{' '}
          a text with the join link so they can jump on the meeting now.
        </p>
      </div>
    </header>
  );
}

// Status row — neutral tone with "Not sent yet" label, formatted
// phone underneath, dark Preview & send pill on the trailing edge.
// Mirrors PatientCommsCard's NotifyReadyRow in its neutral (never
// sent) state. We don't track sent-status on the appointment side
// since the audit lives in lng_sms_messages and the realtime sub
// is on the Visit page; for this surface a single "preview, then
// send" affordance is all the receptionist needs.
function StatusRow({
  phone,
  phoneOk,
  onOpen,
}: {
  phone: string;
  phoneOk: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[4],
        padding: `${theme.space[4]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3], flex: 1, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: theme.color.accent,
            flexShrink: 0,
            marginTop: 7,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1.3,
            }}
          >
            Not sent yet
          </span>
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.4,
            }}
          >
            {phoneOk ? phone : 'No mobile number on file'}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={!phoneOk}
        title={phoneOk ? undefined : 'No phone number on file'}
        style={{
          appearance: 'none',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.surface,
          background: theme.color.ink,
          padding: `${theme.space[2]}px ${theme.space[4]}px`,
          borderRadius: theme.radius.pill,
          cursor: phoneOk ? 'pointer' : 'not-allowed',
          opacity: phoneOk ? 1 : 0.55,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          height: 36,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <MessageSquare size={14} aria-hidden />
        Preview & send
      </button>
    </div>
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
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  appointmentId: string;
  onSent?: () => void;
}) {
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [send, setSend] = useState<SendState>({ status: 'idle' });

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
      setPreview({ status: 'loaded', body: data.body, to: data.to ?? '' });
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
    onSent?.();
    setTimeout(onClose, 1200);
  }, [appointmentId, onClose]);

  const canSend =
    preview.status === 'loaded' && send.status !== 'sending' && send.status !== 'sent';

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
          <Button
            size="md"
            onClick={handleSend}
            disabled={!canSend}
            loading={send.status === 'sending'}
          >
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

// "+44 7…" lightly formatted UK number. Mirrors the visit-side
// formatter so the destination phone reads consistently across
// surfaces. Returns the raw input if it doesn't look UK so we
// never invent digits.
function formatUkPhone(raw: string): string {
  const digits = (raw ?? '').replace(/[^0-9+]/g, '');
  if (!digits) return '';
  // Already E.164 with country code → split as "+44 7xxx xxxxxx"
  if (digits.startsWith('+44') && digits.length >= 12) {
    const rest = digits.slice(3);
    return `+44 ${rest.slice(0, 4)} ${rest.slice(4)}`;
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return `${digits.slice(0, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return raw;
}
