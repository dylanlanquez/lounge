import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  MessageSquare,
  Phone,
  User,
} from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import {
  explainSmsError,
  useSmsMessage,
  type SmsMessageRow,
} from '../../lib/queries/visitReadySms.ts';

// SmsPreviewModal
//
// Opens from any Timeline "View SMS" trigger. Hands an id to
// useSmsMessage and renders the persisted body in an iMessage-style
// chat bubble so the receptionist sees exactly what the patient
// received — no rendered HTML, no template variables, the literal
// SMS text as it sat in Twilio's payload. Chrome around the bubble
// surfaces the destination phone, the sent-at timestamp, Twilio's
// message SID, and (on a failed send) a structured explanation of
// the carrier error code.
//
// Mirrors EmailPreviewModal in shape so the visit timeline reads
// consistently between email + SMS rows. Same BottomSheet host, same
// kind-pill, same metadata grid, same copy-id affordance — only the
// body surface differs.

export interface SmsPreviewModalProps {
  open: boolean;
  smsMessageId: string | null;
  onClose: () => void;
}

export function SmsPreviewModal({ open, smsMessageId, onClose }: SmsPreviewModalProps) {
  // Skip the network call until the modal is actually open.
  const idForFetch = open ? smsMessageId : null;
  const { data, loading, error } = useSmsMessage(idForFetch);

  return (
    <BottomSheet open={open} onClose={onClose} title="SMS preview" bareContent>
      {error ? (
        <ErrorState message={error} />
      ) : loading || !data ? (
        <LoadingState />
      ) : (
        <Body row={data} />
      )}
    </BottomSheet>
  );
}

function Body({ row }: { row: SmsMessageRow }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <MetaHeader row={row} />
      <BodyBubble body={row.body} sentAt={row.sent_at} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome: kind pill + recipient + sent metadata + failure banner.
// ─────────────────────────────────────────────────────────────────────────────

function MetaHeader({ row }: { row: SmsMessageRow }) {
  return (
    <div
      style={{
        padding: `${theme.space[3]}px ${theme.space[6]}px ${theme.space[4]}px`,
        borderBottom: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
      }}
    >
      <KindPill templateKey={row.template_key} status={row.send_status} />
      <div
        style={{
          marginTop: `${theme.space[3]}px`,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: theme.space[2],
          columnGap: theme.space[4],
          alignItems: 'baseline',
          fontSize: theme.type.size.sm,
        }}
      >
        <MetaLabel icon={<User size={14} />} label="To" />
        <MetaValue>{row.to_phone}</MetaValue>

        <MetaLabel icon={<Phone size={14} />} label="Sender" />
        <MetaValue>Venneir</MetaValue>

        <MetaLabel icon={<Clock size={14} />} label="Sent" />
        <MetaValue>{formatSentAt(row.sent_at)}</MetaValue>

        {row.twilio_message_sid ? (
          <>
            <MetaLabel icon={<Copy size={14} />} label="ID" />
            <MessageIdValue id={row.twilio_message_sid} />
          </>
        ) : null}
      </div>

      {row.send_status === 'failed' ? (
        <FailureBanner error={row.send_error} />
      ) : null}
    </div>
  );
}

function MetaLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: theme.color.inkMuted,
        fontWeight: theme.type.weight.medium,
        minWidth: 56,
      }}
    >
      <span style={{ display: 'inline-flex', color: theme.color.inkSubtle }}>{icon}</span>
      {label}
    </span>
  );
}

function MetaValue({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        color: theme.color.ink,
        fontWeight: theme.type.weight.medium,
        wordBreak: 'break-word',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  );
}

function MessageIdValue({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        minWidth: 0,
        flexWrap: 'wrap',
      }}
    >
      <code
        style={{
          fontSize: theme.type.size.xs,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          padding: '2px 8px',
          borderRadius: 6,
          color: theme.color.ink,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        }}
      >
        {id}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy message id"
        style={{
          appearance: 'none',
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
          color: copied ? theme.color.accent : theme.color.inkMuted,
          padding: '2px 8px',
          borderRadius: theme.radius.pill,
          cursor: 'pointer',
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'inherit',
          transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function KindPill({
  templateKey,
  status,
}: {
  templateKey: string | null;
  status: 'sent' | 'failed' | 'pending';
}) {
  const palette =
    status === 'failed'
      ? { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert }
      : status === 'pending'
        ? { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn }
        : { bg: theme.color.accentBg, fg: theme.color.accent };
  const label = humaniseTemplateKey(templateKey);
  const statusSuffix =
    status === 'failed' ? ' · failed' : status === 'pending' ? ' · sending' : '';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: theme.radius.pill,
        background: palette.bg,
        color: palette.fg,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        letterSpacing: theme.type.tracking.tight,
      }}
    >
      <MessageSquare size={12} />
      {label}
      {statusSuffix}
    </span>
  );
}

function FailureBanner({ error }: { error: string | null }) {
  const explained = explainSmsError(error);
  return (
    <div
      style={{
        marginTop: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: 'rgba(184, 58, 42, 0.08)',
        border: `1px solid rgba(184, 58, 42, 0.18)`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
      }}
    >
      <AlertTriangle size={16} color={theme.color.alert} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.alert,
          }}
        >
          {explained?.what ?? 'Delivery failed'}
        </p>
        {explained?.fix ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
            }}
          >
            {explained.fix}
          </p>
        ) : error ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              wordBreak: 'break-word',
            }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Body renderer — iMessage-style outbound bubble.
// ─────────────────────────────────────────────────────────────────────────────

function BodyBubble({ body, sentAt }: { body: string; sentAt: string }) {
  return (
    <div
      style={{
        padding: `${theme.space[6]}px ${theme.space[5]}px ${theme.space[8]}px`,
        background: theme.color.bg,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
        alignItems: 'flex-end',
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          background: theme.color.accent,
          color: '#fff',
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          borderRadius: 20,
          borderBottomRightRadius: 6,
          fontSize: theme.type.size.base,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          boxShadow: theme.shadow.card,
        }}
      >
        {body}
      </div>
      <span
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatBubbleTime(sentAt)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / error states.
// ─────────────────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div style={{ padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[6]}px` }}>
      <Skeleton width="30%" height={20} radius={6} />
      <div style={{ height: theme.space[3] }} />
      <Skeleton width="60%" height={16} radius={6} />
      <div style={{ height: theme.space[5] }} />
      <Skeleton height={120} radius={20} />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: `${theme.space[5]}px ${theme.space[6]}px ${theme.space[6]}px`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
      }}
    >
      <AlertTriangle size={18} color={theme.color.alert} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Could not load this text message
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          {message}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

function humaniseTemplateKey(key: string | null): string {
  if (!key) return 'Text message';
  switch (key) {
    case 'visit_ready':
      return 'Order ready';
    default:
      return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function formatSentAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBubbleTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
