import { useCallback, useEffect, useState } from 'react';
import { Bell, MessageCircleWarning, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';

// PatientCommsCard — receptionist-side "Notify patient" affordance
// for the Visit page. Sits under the visit hero and exposes one
// action today (visit_ready SMS); the card framing leaves room to
// add reschedule pings / appointment reminders / etc later without
// re-arranging the page.
//
// Flow:
//   1. Receptionist taps Notify ready
//   2. Sheet opens and shows the rendered SMS body for THIS visit
//      (server-rendered via send-visit-ready-sms?preview=true so the
//      same variable substitution path the actual send uses produces
//      the preview — no client/server drift)
//   3. Receptionist hits Send to fire it through Twilio
//   4. Card flips to "Sent {{time}}" state so it's clear the SMS
//      already went out; staff can still re-send (rare but legitimate
//      — e.g. patient says they never got it)

export interface PatientCommsCardProps {
  visitId: string;
  patientPhone: string | null;
  patientFirstName: string | null;
}

export function PatientCommsCard({
  visitId,
  patientPhone,
  patientFirstName,
}: PatientCommsCardProps) {
  const [open, setOpen] = useState(false);
  const phoneOk = !!patientPhone && patientPhone.trim().length > 0;
  return (
    <>
      <Card
        padding="lg"
        style={{
          marginBottom: theme.space[6],
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: theme.space[2],
            marginBottom: theme.space[3],
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Patient comms
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            Texts and emails to{' '}
            <strong style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
              {patientFirstName ?? 'the patient'}
            </strong>
            .
          </p>
        </header>

        <ActionRow
          icon={<Bell size={16} aria-hidden />}
          title="Notify ready"
          subtitle="Text the patient that their work is ready to collect."
          ctaLabel="Send SMS"
          ctaDisabled={!phoneOk}
          ctaDisabledHint={!phoneOk ? 'No phone number on file' : undefined}
          onClick={() => setOpen(true)}
        />
      </Card>

      <NotifyReadySheet
        open={open}
        onClose={() => setOpen(false)}
        visitId={visitId}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// Action row primitive
// ─────────────────────────────────────────────────────────────────

function ActionRow({
  icon,
  title,
  subtitle,
  ctaLabel,
  ctaDisabled,
  ctaDisabledHint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaDisabled: boolean;
  ctaDisabledHint: string | undefined;
  onClick: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[4],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: theme.color.accentBg,
          color: theme.color.accent,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
          {subtitle}
        </span>
      </div>
      <Button
        variant="primary"
        onClick={onClick}
        disabled={ctaDisabled}
        title={ctaDisabledHint}
      >
        {ctaLabel}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Notify-ready preview + send sheet
// ─────────────────────────────────────────────────────────────────

interface PreviewState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  body: string;
  to: string;
  reason: string | null;
  message: string | null;
}

const INITIAL_PREVIEW: PreviewState = {
  status: 'idle',
  body: '',
  to: '',
  reason: null,
  message: null,
};

function NotifyReadySheet({
  open,
  onClose,
  visitId,
}: {
  open: boolean;
  onClose: () => void;
  visitId: string;
}) {
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    | { kind: 'idle' }
    | { kind: 'sent'; to: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Hit the edge function in preview mode whenever the sheet opens
  // so the body the receptionist reads is the exact body the send
  // would emit. Re-runs on every open (not once per mount) so a
  // template edit in Admin between two opens picks up immediately.
  useEffect(() => {
    if (!open) {
      setPreview(INITIAL_PREVIEW);
      setSendResult({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setPreview({ status: 'loading', body: '', to: '', reason: null, message: null });
    (async () => {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        preview?: boolean;
        body?: string;
        to?: string;
        error?: string;
        reason?: string;
      }>('send-visit-ready-sms', { body: { visit_id: visitId, preview: true } });
      if (cancelled) return;
      if (error) {
        setPreview({
          status: 'error',
          body: '',
          to: '',
          reason: null,
          message: error.message,
        });
        return;
      }
      if (!data || data.ok !== true || !data.body) {
        setPreview({
          status: 'error',
          body: '',
          to: '',
          reason: data?.reason ?? null,
          message: data?.error ?? 'Preview failed.',
        });
        return;
      }
      setPreview({
        status: 'loaded',
        body: data.body,
        to: data.to ?? '',
        reason: null,
        message: null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, visitId]);

  const handleSend = useCallback(async () => {
    setSending(true);
    setSendResult({ kind: 'idle' });
    try {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        body?: string;
        to?: string;
        twilioSid?: string;
        error?: string;
      }>('send-visit-ready-sms', { body: { visit_id: visitId } });
      if (error) {
        setSendResult({ kind: 'error', message: error.message });
        return;
      }
      if (!data || data.ok !== true) {
        setSendResult({ kind: 'error', message: data?.error ?? 'Send failed.' });
        return;
      }
      setSendResult({ kind: 'sent', to: data.to ?? preview.to });
      // Auto-close after a short delay so the receptionist sees the
      // success state before the sheet goes away.
      setTimeout(() => onClose(), 1100);
    } finally {
      setSending(false);
    }
  }, [visitId, preview.to, onClose]);

  const charCount = preview.body.length;

  return (
    <BottomSheet open={open} onClose={onClose} title="Notify patient — ready to collect">
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {/* Body preview */}
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
            {preview.status === 'loaded' ? (
              <span
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkSubtle,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {charCount} character{charCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </header>

          <div
            style={{
              minHeight: 96,
              padding: theme.space[4],
              borderRadius: theme.radius.card,
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              fontSize: theme.type.size.base,
              lineHeight: theme.type.leading.normal,
              color: theme.color.ink,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {preview.status === 'loading' ? (
              <span style={{ color: theme.color.inkMuted }}>Rendering preview…</span>
            ) : preview.status === 'error' ? (
              <ErrorPanel
                reason={preview.reason}
                message={preview.message ?? 'Preview failed.'}
              />
            ) : preview.body ? (
              preview.body
            ) : (
              <span style={{ color: theme.color.inkMuted }}>—</span>
            )}
          </div>

          {preview.status === 'loaded' && preview.to ? (
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              Sending to{' '}
              <span
                style={{
                  color: theme.color.ink,
                  fontWeight: theme.type.weight.medium,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {preview.to}
              </span>
              . Edit the wording from{' '}
              <a
                href="/admin"
                style={{
                  color: theme.color.accent,
                  fontWeight: theme.type.weight.medium,
                  textDecoration: 'none',
                }}
              >
                Admin → Emails &amp; SMS
              </a>
              .
            </p>
          ) : null}
        </section>

        {/* Send result */}
        {sendResult.kind === 'sent' ? (
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
            Sent to {sendResult.to}.
          </div>
        ) : null}
        {sendResult.kind === 'error' ? (
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
            {sendResult.message}
          </div>
        ) : null}

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          <Button variant="tertiary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={preview.status !== 'loaded' || sending || sendResult.kind === 'sent'}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Send size={14} aria-hidden />
              {sending ? 'Sending…' : 'Send SMS'}
            </span>
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function ErrorPanel({
  reason,
  message,
}: {
  reason: string | null;
  message: string;
}) {
  // Soft-tone reason-specific guidance for the common cases — keeps
  // the error human even when Twilio / the template / the patient row
  // is the actual culprit.
  const hint =
    reason === 'no_phone'
      ? 'Add a number to the patient profile and try again.'
      : reason === 'template_disabled'
        ? 'Re-enable the visit_ready template under Admin → Emails & SMS.'
        : reason === 'template_not_found'
          ? 'Seed the visit_ready template from Admin → Emails & SMS.'
          : null;
  return (
    <span style={{ color: '#7C1D1D' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <MessageCircleWarning size={16} aria-hidden />
        {message}
      </span>
      {hint ? (
        <span
          style={{
            display: 'block',
            marginTop: 6,
            color: '#7C1D1D',
            fontSize: theme.type.size.sm,
          }}
        >
          {hint}
        </span>
      ) : null}
    </span>
  );
}

