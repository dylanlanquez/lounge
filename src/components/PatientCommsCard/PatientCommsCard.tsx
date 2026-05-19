import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  Loader2,
  MessageCircleWarning,
  MessageSquare,
  RefreshCw,
  Send,
} from 'lucide-react';
import { supabase } from '../../lib/supabase.ts';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Card } from '../Card/Card.tsx';
import { DropdownSelect } from '../DropdownSelect/DropdownSelect.tsx';
import {
  type VisitSmsRow,
  explainSmsError,
  useLatestSmsForVisit,
} from '../../lib/queries/visitReadySms.ts';
import { humaniseSmsKey, smsDisplayName, useSmsTemplates } from '../../lib/queries/smsTemplates.ts';
import { properCase } from '../../lib/queries/appointments.ts';

// Canonical order for the template picker. Matches the admin's
// SMS_TEMPLATE_KEYS list — visit_ready first because it's the
// primary affordance, then the four secondary manually-sent
// templates in the order admins are most likely to reach for.
const SMS_PICKER_ORDER: ReadonlyArray<string> = [
  'visit_ready',
  'please_return',
  'please_call',
  'running_late',
  'reminder_to_attend',
];

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
  patientId: string | null;
  patientPhone: string | null;
  patientFirstName: string | null;
}

export function PatientCommsCard({
  visitId,
  patientId,
  patientPhone,
  patientFirstName,
}: PatientCommsCardProps) {
  const [open, setOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState<string>('visit_ready');
  const phoneOk = !!patientPhone && patientPhone.trim().length > 0;
  const latest = useLatestSmsForVisit(visitId, templateKey);
  const row = latest.data;
  const properFirstName = properCase(patientFirstName ?? '') || 'the patient';

  // Build the dropdown options from the General SMS template rows.
  // Disabled templates are dropped so the receptionist can't pick
  // a paused one. Falls back to a visit_ready-only list while
  // useSmsTemplates is still loading so the first paint of the
  // card isn't blank.
  const smsTemplates = useSmsTemplates();
  const templateOptions = useMemo(() => {
    // Build a key → General row map; the General row carries both
    // the enabled flag (gates the dropdown) and the display_name
    // (overrides the humanised label).
    const generalByKey = new Map<string, { enabled: boolean; display_name: string | null }>();
    for (const t of smsTemplates.data) {
      if (t.service_type !== null) continue;
      generalByKey.set(t.key, { enabled: t.enabled, display_name: t.display_name });
    }
    const filtered = SMS_PICKER_ORDER.filter((k) => generalByKey.get(k)?.enabled);
    if (filtered.length === 0) {
      return [{ value: 'visit_ready', label: humaniseSmsKey('visit_ready') }];
    }
    return filtered.map((k) => ({
      value: k,
      label: smsDisplayName({ key: k, display_name: generalByKey.get(k)?.display_name ?? null }),
    }));
  }, [smsTemplates.data]);

  return (
    <>
      <Card padding="lg">
        <SmsHeroHeader patientFirstName={properFirstName} />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            marginTop: theme.space[4],
          }}
        >
          <DropdownSelect<string>
            label="Which text"
            value={templateKey}
            options={templateOptions}
            onChange={setTemplateKey}
            disabled={smsTemplates.loading || templateOptions.length <= 1}
          />

          <NotifyReadyRow
            row={row}
            templateKey={templateKey}
            patientId={patientId}
            patientPhone={patientPhone}
            phoneOk={phoneOk}
            onOpen={() => setOpen(true)}
          />
        </div>
      </Card>

      <NotifyReadySheet
        open={open}
        onClose={() => setOpen(false)}
        visitId={visitId}
        templateKey={templateKey}
        previousRow={row}
        onSent={() => latest.refresh()}
      />
    </>
  );
}

// Section header for the Send-an-SMS card. Mirrors the visual
// rhythm of RescheduleAfterArrivalNote / DropdownSelect labels on
// the visit page — 32px icon disc + sm title — so the card sits in
// the column without claiming hero presence. MessageSquare is
// Lucide's most SMS-shaped glyph.
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
          Send an SMS
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Text{' '}
          <strong style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
            {patientFirstName}
          </strong>{' '}
          from the clinic. Pick which text below.
        </p>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────
// Status row — the body of the Notify card. Status-first display:
// a tinted dot + label on the leading edge, the destination phone
// underneath, and a single contextual action (medium accent pill
// on desktop, full-width tertiary 44pt-tall button on mobile) on
// the trailing edge.
//
// Design rationale: the earlier shape rendered a big tinted icon
// pill, a duplicate headline ("Text message: ready to collect")
// that repeated the card title, a multi-line subtitle, and then a
// full-width black slab button. That violated three things at once:
//
//   1. Two headers competing for the same scan — the card header
//      already says "Notify the patient" with a subtitle naming
//      the action. A second header inside the action surface adds
//      no information.
//   2. The slab button is a primary-affordance pattern reserved
//      for full-page CTAs (Pay / Sign in / Submit form). Inside a
//      card with other content, a medium pill is the convention
//      (Linear / Stripe / Notion). Apple HIG: 44pt min touch
//      target — met by 36pt button height + 8pt of padding.
//   3. The destination phone was buried in a long sentence, even
//      though it's the most important fact in the whole card —
//      "is the SMS going to the right number?"
// ─────────────────────────────────────────────────────────────────

type RowTone = 'neutral' | 'pending' | 'success' | 'alert';

function NotifyReadyRow({
  row,
  templateKey,
  patientId,
  patientPhone,
  phoneOk,
  onOpen,
}: {
  row: VisitSmsRow | null;
  templateKey: string;
  patientId: string | null;
  patientPhone: string | null;
  phoneOk: boolean;
  onOpen: () => void;
}) {
  // Compose the (tone, status text, CTA shape) tuple per state. The
  // body of the row is rendered by a single StatusRow below so layout
  // is consistent across every state — only the colour, label and
  // action change. When the user has switched to a template they
  // have never sent before, the row defaults to the neutral
  // "Not sent yet" state.
  const formattedPhone = formatUkPhone(row?.to_phone ?? patientPhone ?? '');
  if (!row) {
    return (
      <StatusRow
        tone="neutral"
        label="Not sent yet"
        formattedPhone={formattedPhone}
        patientId={patientId}
        action={
          <PrimaryAction
            label="Preview & send"
            icon={<MessageSquare size={14} aria-hidden />}
            onClick={onOpen}
            disabled={!phoneOk}
            disabledHint={!phoneOk ? 'No phone number on file' : undefined}
          />
        }
      />
    );
  }

  if (row.send_status === 'pending') {
    return (
      <StatusRow
        tone="pending"
        label={`Sending to the network${row.to_phone ? '' : '…'}`}
        formattedPhone={formattedPhone}
        patientId={patientId}
        helperText="Waiting on delivery confirmation. This panel updates by itself."
        action={
          <span
            aria-label="Sending"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              padding: '8px 14px',
            }}
          >
            <Loader2
              size={14}
              aria-hidden
              style={{ animation: 'lng-spin 600ms linear infinite' }}
            />
            Sending…
          </span>
        }
      />
    );
  }

  if (row.send_status === 'sent') {
    return (
      <StatusRow
        tone="success"
        label={`Delivered ${formatRelative(row.sent_at)}`}
        formattedPhone={formattedPhone}
        patientId={patientId}
        action={
          <PrimaryAction
            label="Send again"
            icon={<RefreshCw size={14} aria-hidden />}
            variant="secondary"
            onClick={onOpen}
            disabled={!phoneOk}
            disabledHint={!phoneOk ? 'No phone number on file' : undefined}
          />
        }
      />
    );
  }

  // send_status === 'failed' — alert tone, carrier reason inline, a
  // Retry pill on the trailing edge, and an Edit-on-profile link
  // beneath so a wrong number is one tap from being fixed.
  const explained = explainSmsError(row.send_error);
  const headline = explained?.what ?? 'The carrier reported the text as undelivered.';
  const followup = explained?.fix ?? null;
  // Keep templateKey referenced so future per-template error copy
  // can lean on it. Today the headline applies regardless of which
  // template fired — the carrier reason is template-agnostic.
  void templateKey;
  return (
    <StatusRow
      tone="alert"
      label="Didn't reach the patient"
      formattedPhone={formattedPhone}
      patientId={patientId}
      helperText={headline}
      secondaryHelperText={followup}
      action={
        <PrimaryAction
          label="Try again"
          icon={<RefreshCw size={14} aria-hidden />}
          onClick={onOpen}
          disabled={!phoneOk}
          disabledHint={!phoneOk ? 'No phone number on file' : undefined}
        />
      }
    />
  );
}

// Single source of truth for the action-row shape. Status dot on the
// left, label + phone + helper text in the middle column, action on
// the right. On mobile (<640px) the action wraps below as a full-
// width 44pt button (Apple HIG primary-action target).
function StatusRow({
  tone,
  label,
  formattedPhone,
  patientId,
  helperText,
  secondaryHelperText,
  action,
}: {
  tone: RowTone;
  label: string;
  formattedPhone: string;
  patientId: string | null;
  helperText?: string;
  secondaryHelperText?: string | null;
  action: React.ReactNode;
}) {
  const isMobile = useIsMobile(640);
  const palette = TONE_PALETTE[tone];
  const showEditLink = tone === 'alert' && patientId;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        gap: theme.space[4],
        padding: `${theme.space[4]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.card,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3], flex: 1, minWidth: 0 }}>
        <StatusDot tone={tone} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: palette.textStrong,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1.3,
            }}
          >
            {label}
          </span>
          {formattedPhone ? (
            <span
              style={{
                fontSize: theme.type.size.sm,
                color: palette.textMuted,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1.4,
              }}
            >
              {formattedPhone}
            </span>
          ) : null}
          {helperText ? (
            <span
              style={{
                marginTop: 6,
                fontSize: theme.type.size.sm,
                color: palette.textMuted,
                lineHeight: 1.4,
              }}
            >
              {helperText}
            </span>
          ) : null}
          {secondaryHelperText ? (
            <span
              style={{
                marginTop: 4,
                fontSize: theme.type.size.sm,
                color: palette.textMuted,
                lineHeight: 1.4,
              }}
            >
              {secondaryHelperText}
            </span>
          ) : null}
          {showEditLink ? (
            <Link
              to={`/patient/${patientId}`}
              style={{
                marginTop: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: palette.textStrong,
                textDecoration: 'none',
              }}
            >
              Update phone on profile
              <ChevronRight size={14} aria-hidden />
            </Link>
          ) : null}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: isMobile ? 'stretch' : 'flex-end',
          flexShrink: 0,
        }}
      >
        {action}
      </div>
    </div>
  );
}

// Trailing pill button. Defaults to accent (primary intent — fire
// the SMS), with a secondary variant for the "Delivered → Send
// again" path where the SMS is already in the wild and re-sending
// is a quieter re-action, not a primary call to act.
function PrimaryAction({
  label,
  icon,
  onClick,
  disabled,
  disabledHint,
  variant = 'primary',
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledHint?: string;
  variant?: 'primary' | 'secondary';
}) {
  const isMobile = useIsMobile(640);
  const primary = variant === 'primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledHint}
      aria-label={label}
      style={{
        appearance: 'none',
        border: primary ? 'none' : `1px solid ${theme.color.border}`,
        background: primary ? theme.color.accent : theme.color.surface,
        color: primary ? '#FFFFFF' : theme.color.ink,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: theme.type.tracking.tight,
        height: isMobile ? 44 : 36,
        padding: `0 ${theme.space[4]}px`,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space[2],
        width: isMobile ? '100%' : undefined,
        whiteSpace: 'nowrap',
        transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// Tonal palette per state. Backgrounds are very lightly tinted so
// the row sits inside the white card without competing with the
// card header. Border picks a slightly stronger shade so the row
// reads as a delimited surface, not a floating block.
const TONE_PALETTE: Record<RowTone, {
  bg: string;
  border: string;
  dot: string;
  textStrong: string;
  textMuted: string;
}> = {
  neutral: {
    bg: theme.color.bg,
    border: theme.color.border,
    dot: theme.color.accent,
    textStrong: theme.color.ink,
    textMuted: theme.color.inkMuted,
  },
  pending: {
    bg: '#FFFBEB',
    border: '#FCE7BD',
    dot: '#B36815',
    textStrong: '#7A4A0F',
    textMuted: '#8A5A1A',
  },
  success: {
    bg: '#F0F8F2',
    border: '#C7E2CD',
    dot: '#1B6E3A',
    textStrong: '#13502B',
    textMuted: '#43775A',
  },
  alert: {
    bg: '#FDECEC',
    border: '#F1BFBF',
    dot: '#B91C1C',
    textStrong: '#7C1D1D',
    textMuted: '#9F3434',
  },
};

function StatusDot({ tone }: { tone: RowTone }) {
  const palette = TONE_PALETTE[tone];
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: palette.dot,
        flexShrink: 0,
        marginTop: 8,
        boxShadow: `0 0 0 4px ${palette.bg}`,
      }}
    />
  );
}

// Format a UK mobile number into the conventional spaced shape
// "+44 7878 023 449". Falls through unchanged for non-UK inputs or
// numbers we can't confidently parse.
function formatUkPhone(raw: string): string {
  const digits = (raw ?? '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  // E.164 UK mobile: +447XXXXXXXXX
  const m = digits.match(/^\+44(7\d{9})$/);
  if (m && m[1]) {
    const rest = m[1];
    return `+44 ${rest.slice(0, 4)} ${rest.slice(4, 7)} ${rest.slice(7)}`;
  }
  // National UK mobile: 07XXXXXXXXX
  const nat = digits.match(/^(07\d{9})$/);
  if (nat && nat[1]) {
    const r = nat[1];
    return `${r.slice(0, 5)} ${r.slice(5, 8)} ${r.slice(8)}`;
  }
  return raw;
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
  templateKey,
  previousRow,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  visitId: string;
  /** Picked on the card itself before the sheet opens. */
  templateKey: string;
  previousRow: VisitSmsRow | null;
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
  // After the user clicks the CTA, "Preview & send" → opens this
  // sheet. The sheet title carries the action so the user knows
  // they're being asked to confirm a SEND, not "save" or anything
  // else. Re-sending a failed delivery gets a louder title so the
  // failure context carries into the sheet.

  useEffect(() => {
    if (!open) {
      setPreview(INITIAL_PREVIEW);
      setSendResult({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setPreview({ status: 'loading', body: '', to: '', reason: null, message: null });
    // Clear any prior send result so flipping the template after a
    // failure (or a quick successive send) doesn't leave a stale
    // banner pinned to the bottom of the sheet.
    setSendResult({ kind: 'idle' });
    (async () => {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        preview?: boolean;
        body?: string;
        to?: string;
        error?: string;
        reason?: string;
      }>('send-visit-ready-sms', {
        body: { visit_id: visitId, template_key: templateKey, preview: true },
      });
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
  }, [open, visitId, templateKey]);

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
      }>('send-visit-ready-sms', {
        body: { visit_id: visitId, template_key: templateKey },
      });
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
  }, [visitId, templateKey, preview.to, onClose, onSent]);

  const charCount = preview.body.length;
  const sheetTitle = resendOfFailed
    ? 'Try the text again'
    : isResend
      ? 'Send another text message'
      : 'Send a text message to the patient';

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

          {/* Body — iMessage-style outbound bubble, accent fill,
              right-anchored, with a soft tail. Surrounds the message
              in the spatial cue the patient will see on their phone
              so the receptionist instantly recognises what's being
              previewed, rather than reading a plain text block. */}
          <div
            style={{
              padding: `${theme.space[4]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.card,
              background: theme.color.bg,
              border: `1px solid ${theme.color.border}`,
              display: 'flex',
              justifyContent: 'flex-end',
              minHeight: 88,
            }}
          >
            {preview.status === 'loading' ? (
              <span
                style={{
                  alignSelf: 'center',
                  color: theme.color.inkMuted,
                  fontSize: theme.type.size.sm,
                }}
              >
                Rendering preview…
              </span>
            ) : preview.status === 'error' ? (
              <ErrorPanel reason={preview.reason} message={preview.message ?? 'Preview failed.'} />
            ) : preview.body ? (
              <div
                style={{
                  maxWidth: '85%',
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  borderRadius: 18,
                  borderBottomRightRadius: 6,
                  background: theme.color.accent,
                  color: '#FFFFFF',
                  fontSize: theme.type.size.base,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  boxShadow: theme.shadow.card,
                }}
              >
                {preview.body}
              </div>
            ) : (
              <span
                style={{
                  alignSelf: 'center',
                  color: theme.color.inkMuted,
                  fontSize: theme.type.size.sm,
                }}
              >
                No preview to show.
              </span>
            )}
          </div>

          {preview.status === 'loaded' && preview.to ? (
            <div
              style={{
                marginTop: theme.space[2],
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <span
                style={{
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.medium,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                  color: theme.color.inkSubtle,
                }}
              >
                Sending to
              </span>
              <span
                style={{
                  fontSize: theme.type.size.lg,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.ink,
                  letterSpacing: theme.type.tracking.tight,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatUkPhone(preview.to)}
              </span>
            </div>
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
              {sending
                ? 'Sending…'
                : sendResult.kind === 'sent'
                  ? 'Sent'
                  : isResend
                    ? 'Send the text again'
                    : 'Send the text'}
            </span>
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function PreviousFailurePanel({ row }: { row: VisitSmsRow }) {
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
        ? 'Re-enable the template under Admin → Emails & SMS.'
        : reason === 'template_not_found'
          ? 'Seed the template from Admin → Emails & SMS.'
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
