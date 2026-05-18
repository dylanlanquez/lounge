import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Clock,
  MessageCircleWarning,
  RefreshCw,
  Send,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import {
  type VisitReadySmsRow,
  explainSmsError,
  useLatestVisitReadySms,
} from '../../lib/queries/visitReadySms.ts';

// PatientCommsCard — receptionist-side "Notify patient" affordance
// for the Visit page. Surfaces the patient's most recent
// visit_ready SMS state in real time via lng_sms_messages so a
// silent carrier failure ("Unknown destination handset", spam
// filter, etc) doesn't slip through. State machine:
//
//   • No SMS yet            → "Notify ready" CTA, Bell icon
//   • Twilio accepted       → "Sending to +44…" with spinner
//   • Delivered             → "Delivered N min ago" with Resend
//   • Carrier failed        → loud error card with carrier reason
//                             and concrete next-step copy +
//                             Resend button (so a fixed phone
//                             number takes one tap to re-fire)
//
// Realtime keeps the card fresh the moment the twilio-sms-status
// webhook flips 'pending' → 'sent' / 'failed', so the receptionist
// doesn't walk away thinking a failed send went through.

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
  const latest = useLatestVisitReadySms(visitId);
  const row = latest.data;

  return (
    <>
      <Card padding="lg" style={{ marginBottom: theme.space[6] }}>
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
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            Texts and emails to{' '}
            <strong style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
              {patientFirstName ?? 'the patient'}
            </strong>
            .
          </p>
        </header>

        <NotifyReadyRow
          row={row}
          phoneOk={phoneOk}
          onOpen={() => setOpen(true)}
        />
      </Card>

      <NotifyReadySheet
        open={open}
        onClose={() => setOpen(false)}
        visitId={visitId}
        previousRow={row}
        onSent={() => latest.refresh()}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// Action row variants
// ─────────────────────────────────────────────────────────────────

function NotifyReadyRow({
  row,
  phoneOk,
  onOpen,
}: {
  row: VisitReadySmsRow | null;
  phoneOk: boolean;
  onOpen: () => void;
}) {
  // No prior SMS — initial state.
  if (!row) {
    return (
      <ActionRow
        tone="neutral"
        icon={<Bell size={16} aria-hidden />}
        title="Notify ready"
        subtitle="Text the patient that their work is ready to collect."
        ctaLabel="Send SMS"
        ctaDisabled={!phoneOk}
        ctaDisabledHint={!phoneOk ? 'No phone number on file' : undefined}
        onClick={onOpen}
      />
    );
  }

  if (row.send_status === 'pending') {
    return (
      <ActionRow
        tone="pending"
        icon={<Clock size={16} aria-hidden />}
        title="Sending…"
        subtitle={`Handed to the carrier for ${row.to_phone}. Waiting on delivery confirmation.`}
        ctaLabel={null}
      />
    );
  }

  if (row.send_status === 'sent') {
    return (
      <ActionRow
        tone="success"
        icon={<CheckCircle2 size={16} aria-hidden />}
        title={`Delivered ${formatRelative(row.sent_at)}`}
        subtitle={`Patient was notified on ${row.to_phone}.`}
        ctaLabel="Resend"
        ctaIcon={<RefreshCw size={14} aria-hidden />}
        ctaDisabled={!phoneOk}
        ctaDisabledHint={!phoneOk ? 'No phone number on file' : undefined}
        onClick={onOpen}
      />
    );
  }

  // send_status === 'failed' — show the carrier reason + a Resend
  // button so a corrected phone number takes one tap.
  const explained = explainSmsError(row.send_error);
  const headline = explained?.what ?? 'Carrier reported the SMS as undelivered.';
  const followup = explained?.fix ?? 'Try resending; if it keeps failing, call the patient.';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        background: '#FDECEC',
        border: '1px solid #F1BFBF',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: theme.radius.pill,
            background: 'rgba(220, 38, 38, 0.12)',
            color: '#B91C1C',
            flexShrink: 0,
          }}
        >
          <AlertCircle size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: '#7C1D1D',
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            SMS didn't reach {row.to_phone}
          </span>
          <span style={{ fontSize: theme.type.size.sm, color: '#7C1D1D', lineHeight: theme.type.leading.snug }}>
            {headline}
          </span>
          <span
            style={{
              fontSize: theme.type.size.sm,
              color: '#7C1D1D',
              lineHeight: theme.type.leading.snug,
              marginTop: 4,
            }}
          >
            {followup}
          </span>
          {row.send_error ? (
            <code
              style={{
                marginTop: 8,
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                fontSize: 11,
                color: 'rgba(124, 29, 29, 0.7)',
              }}
            >
              {row.send_error}
            </code>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={onOpen} disabled={!phoneOk} title={!phoneOk ? 'No phone number on file' : undefined}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            <RefreshCw size={14} aria-hidden />
            Resend
          </span>
        </Button>
      </div>
    </div>
  );
}

function ActionRow({
  tone,
  icon,
  title,
  subtitle,
  ctaLabel,
  ctaIcon,
  ctaDisabled,
  ctaDisabledHint,
  onClick,
}: {
  tone: 'neutral' | 'pending' | 'success';
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  ctaLabel: string | null;
  ctaIcon?: React.ReactNode;
  ctaDisabled?: boolean;
  ctaDisabledHint?: string;
  onClick?: () => void;
}) {
  const pillColors = {
    neutral: { bg: theme.color.accentBg, fg: theme.color.accent },
    pending: { bg: '#FEF3C7', fg: '#92400E' },
    success: { bg: '#E8F5EC', fg: '#13502B' },
  }[tone];
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
          background: pillColors.bg,
          color: pillColors.fg,
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
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{subtitle}</span>
      </div>
      {ctaLabel && onClick ? (
        <Button
          variant="primary"
          onClick={onClick}
          disabled={ctaDisabled}
          title={ctaDisabledHint}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
            {ctaIcon}
            {ctaLabel}
          </span>
        </Button>
      ) : null}
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
  previousRow,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  visitId: string;
  previousRow: VisitReadySmsRow | null;
  onSent: () => void;
}) {
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<
    | { kind: 'idle' }
    | { kind: 'sent'; to: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const isResend = !!previousRow;
  const resendOfFailed = !!previousRow && previousRow.send_status === 'failed';

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
      onSent();
      // Auto-close after a short delay so the receptionist sees the
      // success state before the sheet goes away. Realtime
      // subscription on the card behind will pick up the row and
      // flip into "Sending…" → "Delivered" / "Failed" without
      // another click.
      setTimeout(() => onClose(), 1200);
    } finally {
      setSending(false);
    }
  }, [visitId, preview.to, onClose, onSent]);

  const charCount = preview.body.length;
  const sheetTitle = resendOfFailed
    ? 'Resend after a failed delivery'
    : isResend
      ? 'Resend the ready notification'
      : 'Notify patient — ready to collect';

  return (
    <BottomSheet open={open} onClose={onClose} title={sheetTitle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {/* Optional context strip about a previous failure */}
        {resendOfFailed && previousRow ? (
          <PreviousFailurePanel row={previousRow} />
        ) : null}

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
              <ErrorPanel reason={preview.reason} message={preview.message ?? 'Preview failed.'} />
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
            Handed off to the carrier for {sendResult.to}. The card will update when delivery is confirmed.
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
              {isResend ? <RefreshCw size={14} aria-hidden /> : <Send size={14} aria-hidden />}
              {sending ? 'Sending…' : isResend ? 'Resend SMS' : 'Send SMS'}
            </span>
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function PreviousFailurePanel({ row }: { row: VisitReadySmsRow }) {
  const explained = explainSmsError(row.send_error);
  return (
    <div
      style={{
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        background: '#FDECEC',
        border: '1px solid #F1BFBF',
        color: '#7C1D1D',
        fontSize: theme.type.size.sm,
        lineHeight: theme.type.leading.snug,
      }}
    >
      <strong style={{ display: 'block', marginBottom: 4 }}>
        Previous send didn't reach {row.to_phone}
      </strong>
      <span>{explained?.what ?? 'Carrier reported the SMS as undelivered.'}</span>
      {explained?.fix ? (
        <span style={{ display: 'block', marginTop: 6 }}>{explained.fix}</span>
      ) : null}
    </div>
  );
}

function ErrorPanel({ reason, message }: { reason: string | null; message: string }) {
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

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
