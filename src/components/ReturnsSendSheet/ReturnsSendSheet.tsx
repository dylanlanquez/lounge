import { useEffect, useState } from 'react';
import { Check, Mail, MessageSquare, PackageCheck } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { StatusBanner } from '../StatusBanner/StatusBanner.tsx';
import { theme } from '../../theme/index.ts';
import { type ReturnsChannelResult, sendReturnsInfo } from '../../lib/queries/returns.ts';

export interface ReturnsSendSheetProps {
  open: boolean;
  onClose: () => void;
  appointmentId: string;
  patientFirstName: string | null;
  patientEmail: string | null;
  patientPhone: string | null;
  // Fired once at least one channel sent successfully (parent toasts).
  onSent?: () => void;
}

export function ReturnsSendSheet({
  open,
  onClose,
  appointmentId,
  patientFirstName,
  patientEmail,
  patientPhone,
  onSent,
}: ReturnsSendSheetProps) {
  const hasEmail = !!patientEmail;
  const hasPhone = !!patientPhone;
  const [email, setEmail] = useState(hasEmail);
  const [sms, setSms] = useState(hasPhone);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email?: ReturnsChannelResult; sms?: ReturnsChannelResult } | null>(null);

  // Reset to the default (both available channels ticked) each open.
  useEffect(() => {
    if (!open) return;
    setEmail(hasEmail);
    setSms(hasPhone);
    setSending(false);
    setError(null);
    setResult(null);
  }, [open, hasEmail, hasPhone]);

  const canSend = (email && hasEmail) || (sms && hasPhone);

  const handleSend = async () => {
    if (!canSend || sending) return;
    setSending(true);
    setError(null);
    setResult(null);
    const res = await sendReturnsInfo({
      appointmentId,
      email: email && hasEmail,
      sms: sms && hasPhone,
    });
    setSending(false);
    if (!res.ok) {
      setError(
        res.reason === 'no_auth_code'
          ? 'You have no authorisation code set. Add yours in Admin, Staff, then try again.'
          : res.error ?? 'Could not send the returns message.',
      );
      return;
    }
    setResult({ email: res.email, sms: res.sms });
    const anySent = res.email?.status === 'sent' || res.sms?.status === 'sent';
    if (anySent) onSent?.();
  };

  const name = patientFirstName?.trim() || 'the patient';

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Send return label"
      description={`Send ${name} their prepaid DPD return label and your authorisation code.`}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onClose} disabled={sending}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          {!result ? (
            <Button variant="primary" onClick={handleSend} disabled={!canSend || sending} loading={sending}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
                <PackageCheck size={16} aria-hidden /> Send
              </span>
            </Button>
          ) : null}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        {result ? (
          <SentSummary result={result} />
        ) : (
          <>
            <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted, lineHeight: theme.type.leading.normal }}>
              Choose how to send it. The message text is editable in Admin, under Emails and SMS.
            </p>
            <ChannelRow
              icon={<Mail size={18} aria-hidden />}
              label="Email"
              detail={patientEmail ?? 'No email on file'}
              checked={email && hasEmail}
              disabled={!hasEmail}
              onToggle={() => setEmail((v) => !v)}
            />
            <ChannelRow
              icon={<MessageSquare size={18} aria-hidden />}
              label="SMS"
              detail={patientPhone ?? 'No phone on file'}
              checked={sms && hasPhone}
              disabled={!hasPhone}
              onToggle={() => setSms((v) => !v)}
            />
            {error ? (
              <StatusBanner tone="error" title="Couldn't send">
                {error}
              </StatusBanner>
            ) : null}
          </>
        )}
      </div>
    </BottomSheet>
  );
}

function ChannelRow({
  icon,
  label,
  detail,
  checked,
  disabled,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onToggle()}
      style={{
        appearance: 'none',
        width: '100%',
        textAlign: 'left',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        border: `1.5px solid ${checked ? theme.color.accent : theme.color.border}`,
        background: checked ? theme.color.accentBg : theme.color.surface,
        opacity: disabled ? 0.5 : 1,
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: theme.radius.pill,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: checked ? theme.color.accent : 'rgba(14,20,20,0.05)',
          color: checked ? theme.color.surface : theme.color.inkMuted,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
          {label}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {detail}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          borderRadius: theme.radius.pill,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: checked ? theme.color.accent : 'transparent',
          border: checked ? 'none' : `1.5px solid ${theme.color.border}`,
          color: theme.color.surface,
        }}
      >
        {checked ? <Check size={14} strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

function SentSummary({
  result,
}: {
  result: { email?: ReturnsChannelResult; sms?: ReturnsChannelResult };
}) {
  const lines: { label: string; r: ReturnsChannelResult }[] = [];
  if (result.email) lines.push({ label: 'Email', r: result.email });
  if (result.sms) lines.push({ label: 'SMS', r: result.sms });
  const anySent = lines.some((l) => l.r.status === 'sent');
  const anyBad = lines.some((l) => l.r.status !== 'sent');

  const reasonText = (r: ReturnsChannelResult): string => {
    if (r.status === 'sent') return 'Sent';
    if (r.status === 'failed') return `Failed: ${r.error}`;
    const map: Record<string, string> = {
      no_email: 'No email on file',
      no_phone: 'No phone on file',
      email_not_configured: 'Email sending not set up',
      template_disabled: 'Template is paused',
    };
    return map[r.reason] ?? `Skipped (${r.reason})`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
      <StatusBanner
        tone={anySent && !anyBad ? 'success' : anySent ? 'warning' : 'error'}
        title={anySent ? 'Return label sent' : 'Nothing sent'}
      >
        {anySent ? 'The patient should receive it shortly.' : 'Please check the details and try again.'}
      </StatusBanner>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {lines.map((l) => (
          <li
            key={l.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[3],
              padding: `${theme.space[2]}px ${theme.space[4]}px`,
              borderRadius: theme.radius.input,
              border: `1px solid ${theme.color.border}`,
              fontSize: theme.type.size.sm,
            }}
          >
            <span style={{ fontWeight: theme.type.weight.medium, color: theme.color.ink }}>{l.label}</span>
            <span style={{ color: l.r.status === 'sent' ? theme.color.accent : theme.color.inkMuted }}>
              {reasonText(l.r)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
