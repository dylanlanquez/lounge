import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Mail,
  Send,
  User,
} from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import { useEmailMessage, type EmailMessageRow } from '../../lib/queries/emailMessages.ts';

// EmailPreviewModal
//
// Opens from any Timeline "View email" trigger. Hands an id to
// useEmailMessage, then renders the persisted HTML inside a sandboxed
// iframe so the staff member sees exactly what the patient received —
// the brand shell, the styled buttons, the inline coloured spans, the
// images, every byte. The modal's own chrome shows the dispatch
// metadata Resend needed to deliver: subject, recipient, sender,
// sent-at, provider message id, kind.
//
// The iframe is sandboxed without allow-scripts so any future
// template change can't introduce active content. allow-popups keeps
// link clicks usable. The HTML is trusted (we render it ourselves in
// the edge function), but iframe sandbox is belt-and-braces — a
// future template editor that lets staff paste markup couldn't smuggle
// in script tags here.

export interface EmailPreviewModalProps {
  open: boolean;
  emailMessageId: string | null;
  onClose: () => void;
}

export function EmailPreviewModal({ open, emailMessageId, onClose }: EmailPreviewModalProps) {
  // Skip the network call until the modal is actually open.
  const idForFetch = open ? emailMessageId : null;
  const { data, loading, error } = useEmailMessage(idForFetch);

  return (
    <BottomSheet open={open} onClose={onClose} title="Email preview" bareContent>
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

function Body({ row }: { row: EmailMessageRow }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <MetaHeader row={row} />
      <EmailFrame html={row.html} subject={row.subject} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome: subject + recipient + dispatch metadata + failure banner.
// ─────────────────────────────────────────────────────────────────────────────

function MetaHeader({ row }: { row: EmailMessageRow }) {
  return (
    <div
      style={{
        padding: `${theme.space[3]}px ${theme.space[6]}px ${theme.space[4]}px`,
        borderBottom: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
      }}
    >
      <KindPill kind={row.kind} status={row.send_status} />
      <h3
        style={{
          margin: `${theme.space[2]}px 0 ${theme.space[3]}px`,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.tight,
          color: theme.color.ink,
          lineHeight: 1.3,
        }}
      >
        {row.subject}
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          rowGap: theme.space[2],
          columnGap: theme.space[4],
          alignItems: 'baseline',
          fontSize: theme.type.size.sm,
        }}
      >
        <MetaLabel icon={<User size={14} />} label="To" />
        <MetaValue>{row.to_email}</MetaValue>

        {row.from_email ? (
          <>
            <MetaLabel icon={<Send size={14} />} label="From" />
            <MetaValue>{row.from_email}</MetaValue>
          </>
        ) : null}

        <MetaLabel icon={<Mail size={14} />} label="Sent" />
        <MetaValue>{formatSentAt(row.sent_at ?? row.created_at)}</MetaValue>

        {row.provider_message_id ? (
          <>
            <MetaLabel icon={<Copy size={14} />} label="ID" />
            <MessageIdValue id={row.provider_message_id} provider={row.provider} />
          </>
        ) : null}
      </div>

      {row.send_status === 'failed' ? (
        <FailureBanner error={row.send_error ?? 'Delivery failed'} />
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
        // Stable column width so the values align on a clean rail.
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

function MessageIdValue({ id, provider }: { id: string; provider: string }) {
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
      <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.xs }}>
        via {humaniseProvider(provider)}
      </span>
    </span>
  );
}

function KindPill({ kind, status }: { kind: string | null; status: 'sent' | 'failed' }) {
  const palette =
    status === 'failed'
      ? { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert }
      : { bg: theme.color.accentBg, fg: theme.color.accent };
  const label = kind ? humaniseKind(kind) : 'Email';
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
      <Mail size={12} />
      {label}
      {status === 'failed' ? ' · failed' : ''}
    </span>
  );
}

function FailureBanner({ error }: { error: string }) {
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
          Delivery failed
        </p>
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
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Iframe renderer.
// ─────────────────────────────────────────────────────────────────────────────

function EmailFrame({ html, subject }: { html: string; subject: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  // Inline a base style nudge — emails are designed for a 600px max
  // width, so we centre the frame in our own bounded container and
  // keep the cream brand background flush around the white card. The
  // patched HTML is the same as the patient saw plus a single inline
  // override forcing body fill to the brand cream so a transparent
  // iframe background doesn't show through.
  const srcDoc = useMemo(() => patchHtml(html), [html]);
  const [height, setHeight] = useState<number>(600);

  useEffect(() => {
    // Resize the iframe to fit its content once loaded so the modal
    // body scrolls as one continuous surface — staff don't get a
    // double scrollbar.
    const onLoad = () => {
      const doc = ref.current?.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
      setHeight(h + 24);
    };
    const node = ref.current;
    if (node) node.addEventListener('load', onLoad);
    return () => {
      if (node) node.removeEventListener('load', onLoad);
    };
  }, [srcDoc]);

  return (
    <div
      style={{
        padding: `${theme.space[5]}px ${theme.space[4]}px ${theme.space[6]}px`,
        background: theme.color.bg,
      }}
    >
      <iframe
        ref={ref}
        title={`Email preview · ${subject}`}
        srcDoc={srcDoc}
        // Sandbox without allow-scripts — outgoing emails never need
        // JS, and disabling it eliminates the entire vector category.
        // allow-popups lets link clicks open in a new tab so staff
        // can verify CTA destinations without leaving the preview.
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        style={{
          width: '100%',
          height,
          border: 'none',
          background: theme.color.bg,
          display: 'block',
          // A soft outer border catches the eye on the brand cream so
          // the email body reads as its own surface rather than
          // floating in the modal.
          borderRadius: 14,
          boxShadow: theme.shadow.card,
          // The email template renders its own 600px max-width
          // wrapper, so the iframe just needs to be wide enough not
          // to clip. width:100% with the document's centred container
          // gives the same composition staff would see on desktop.
        }}
      />
    </div>
  );
}

function patchHtml(html: string): string {
  // The persisted HTML is a complete document. Wrap it once more so a
  // future template change that drops the outer cream fill still
  // renders against the brand background, and apply a permissive
  // base-target so any link the staff clicks opens in a new tab.
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">');
    }
    return html.replace(/<html([^>]*)>/i, '<html$1><head><base target="_blank"></head>');
  }
  return `<!DOCTYPE html><html><head><base target="_blank"></head><body style="margin:0;background:${theme.color.bg}">${html}</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / error states.
// ─────────────────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div style={{ padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[6]}px` }}>
      <Skeleton width="40%" height={20} radius={6} />
      <div style={{ height: theme.space[3] }} />
      <Skeleton width="80%" height={28} radius={6} />
      <div style={{ height: theme.space[5] }} />
      <Skeleton height={520} radius={14} />
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
          Could not load this email
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

function humaniseKind(kind: string): string {
  switch (kind) {
    case 'appointment_confirmation':
      return 'Confirmation';
    case 'appointment_cancellation':
      return 'Cancellation';
    case 'appointment_reminder':
      return 'Reminder';
    case 'receipt':
      return 'Receipt';
    case 'dispatch_confirmation':
      return 'Dispatch';
    case 'template_test':
      return 'Template test';
    case 'magic_link':
      return 'Magic link';
    case 'password_reset':
      return 'Password reset';
    case 'staff_invite':
      return 'Staff invite';
    default:
      return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

function humaniseProvider(provider: string): string {
  if (provider === 'resend') return 'Resend';
  if (provider === 'twilio') return 'Twilio';
  return provider;
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
