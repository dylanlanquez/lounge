import { useEffect, useState } from 'react';
import { Check, KeyRound, Mail, MessageSquare, PackageCheck } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { StatusBanner } from '../StatusBanner/StatusBanner.tsx';
import { theme } from '../../theme/index.ts';
import {
  type ReturnsChannelResult,
  type ReturnsPreview,
  previewReturnsInfo,
  sendReturnsInfo,
} from '../../lib/queries/returns.ts';

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
  // Rendered preview of what the patient will receive (+ whether the
  // sender has an authorisation code). undefined = still loading.
  const [preview, setPreview] = useState<ReturnsPreview | undefined>(undefined);
  // Editable greeting name. The patient record can hold a placeholder
  // like "Customer"; staff correct it here before sending and the
  // preview re-renders with the override.
  const [firstName, setFirstName] = useState(patientFirstName?.trim() ?? '');

  // Reset to the default (both available channels ticked) each open.
  useEffect(() => {
    if (!open) return;
    setEmail(hasEmail);
    setSms(hasPhone);
    setSending(false);
    setError(null);
    setResult(null);
    setPreview(undefined);
    setFirstName(patientFirstName?.trim() ?? '');
    // The preview itself is (re)loaded by the debounced effect below,
    // which also fires on every name edit.
  }, [open, appointmentId, hasEmail, hasPhone, patientFirstName]);

  // (Re)load the rendered preview whenever the sheet opens or the staff
  // edits the greeting name. Debounced so typing doesn't spam the edge
  // function. The previous preview stays on screen while a fresh one
  // loads, so the panel doesn't flash empty on each keystroke.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      previewReturnsInfo(appointmentId, firstName).then((p) => {
        if (!cancelled) setPreview(p);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, appointmentId, firstName]);

  const hasMyCode = preview?.hasAuthCode === true;
  const loadingPreview = preview === undefined;
  const canSend = hasMyCode && !loadingPreview && ((email && hasEmail) || (sms && hasPhone));

  const name = firstName.trim() || 'the patient';

  const handleSend = async () => {
    if (!canSend || sending) return;
    setSending(true);
    setError(null);
    setResult(null);
    const res = await sendReturnsInfo({
      appointmentId,
      email: email && hasEmail,
      sms: sms && hasPhone,
      firstName,
    });
    setSending(false);
    if (!res.ok) {
      setError(
        res.reason === 'no_auth_code'
          ? 'You have no authorisation code set. Add yours in Admin, Staff, then try again.'
          : res.error ?? 'Could not send the return instructions.',
      );
      return;
    }
    setResult({ email: res.email, sms: res.sms });
    if (res.email?.status === 'sent' || res.sms?.status === 'sent') onSent?.();
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Send return instructions"
      description={`Send ${name} the link to generate their prepaid DPD returns QR code, plus your authorisation code and how to send their impressions back.`}
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
            {preview?.hasAuthCode === false ? (
              <StatusBanner tone="warning" title="No authorisation code set">
                You have no returns authorisation code. Add yours in Admin, Staff, then you can send
                return instructions. (The patient&apos;s message includes your code, so it can&apos;t go
                without one.)
              </StatusBanner>
            ) : hasMyCode ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                <KeyRound size={15} aria-hidden style={{ color: theme.color.inkSubtle, flexShrink: 0 }} />
                Sending with your authorisation code.
              </div>
            ) : null}

            <Input
              label="Customer first name"
              helper="Used in the greeting. Edit it if the record shows a placeholder like Customer."
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="e.g. Allison"
              autoComplete="off"
            />

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

            {/* What the patient will actually receive. */}
            <div>
              <p
                style={{
                  margin: `0 0 ${theme.space[2]}px`,
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.medium,
                  color: theme.color.inkSubtle,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                }}
              >
                Preview
              </p>
              {loadingPreview ? (
                <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                  Loading preview…
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
                  {hasPhone && preview?.sms ? (
                    <SmsPreview body={preview.sms.body} />
                  ) : null}
                  {hasEmail && preview?.email ? (
                    <EmailPreview subject={preview.email.subject} html={preview.email.html} />
                  ) : null}
                  {!preview?.sms && !preview?.email ? (
                    <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                      Preview unavailable. Check the returns templates in Admin, Emails and SMS.
                    </p>
                  ) : null}
                </div>
              )}
            </div>

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

function SmsPreview({ body }: { body: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[2] }}>
        <MessageSquare size={14} aria-hidden style={{ color: theme.color.inkSubtle }} />
        <span style={{ fontSize: theme.type.size.xs, fontWeight: theme.type.weight.semibold, color: theme.color.inkMuted }}>
          Text message
        </span>
      </div>
      <div
        style={{
          background: theme.color.accentBg,
          color: theme.color.ink,
          borderRadius: 16,
          borderBottomLeftRadius: 4,
          padding: `${theme.space[4]}px ${theme.space[4]}px`,
          fontSize: theme.type.size.sm,
          lineHeight: theme.type.leading.relaxed,
          whiteSpace: 'pre-wrap',
          maxWidth: 420,
          wordBreak: 'break-word',
        }}
      >
        {body}
      </div>
    </div>
  );
}

function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[2] }}>
        <Mail size={14} aria-hidden style={{ color: theme.color.inkSubtle }} />
        <span style={{ fontSize: theme.type.size.xs, fontWeight: theme.type.weight.semibold, color: theme.color.inkMuted }}>
          Email
        </span>
      </div>
      <div
        style={{
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          overflow: 'hidden',
          background: theme.color.surface,
        }}
      >
        <div
          style={{
            padding: `${theme.space[2]}px ${theme.space[4]}px`,
            borderBottom: `1px solid ${theme.color.border}`,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
          }}
        >
          <span style={{ color: theme.color.inkSubtle }}>Subject: </span>
          <span style={{ fontWeight: theme.type.weight.semibold }}>{subject}</span>
        </div>
        <iframe
          title="Email preview"
          srcDoc={html}
          sandbox=""
          style={{ width: '100%', height: 420, border: 'none', display: 'block', background: '#fff' }}
        />
      </div>
    </div>
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
        title={anySent ? 'Return instructions sent' : 'Nothing sent'}
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
