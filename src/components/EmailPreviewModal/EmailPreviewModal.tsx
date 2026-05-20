import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
            <MessageIdValue id={row.provider_message_id} />
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
  // The persisted HTML is the patient-facing document; we splice in a
  // <base target="_blank"> so any in-frame link click escapes the
  // sandbox cleanly, and otherwise render the bytes verbatim.
  const srcDoc = useMemo(() => patchHtml(html), [html]);
  // Start tall enough to render the metadata-strip + body without a
  // visible jump on first paint, then shrink/grow to fit content.
  const [height, setHeight] = useState<number>(800);

  // Single resize routine: ask the iframe's documentElement + body for
  // the largest layout extent and pin the iframe to it (plus a small
  // bottom buffer for the inner card's drop shadow). With the iframe
  // height == content height, the iframe itself never scrolls, so the
  // only scroll surface is the outer BottomSheet body — staff get a
  // single continuous scroll context, with native scroll-chaining
  // handling top/bottom edges in the obvious way.
  const measure = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const html = doc.documentElement;
    const body = doc.body;
    const next = Math.max(
      html?.scrollHeight ?? 0,
      html?.offsetHeight ?? 0,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
    );
    if (next > 0) setHeight(next + 24);
  }, []);

  const onLoad = useCallback(() => {
    measure();
    const doc = ref.current?.contentDocument;
    if (!doc) return;

    // Disable the iframe's own scrollbars in addition to sizing it
    // to fit. Belt and braces: even if a measurement lags a frame,
    // overflow:hidden on the inner document means the iframe will
    // never present a scrollbar of its own.
    if (doc.documentElement) doc.documentElement.style.overflow = 'hidden';
    if (doc.body) doc.body.style.overflow = 'hidden';

    // Re-measure as images / fonts / inline assets finish loading —
    // their height contribution lands after the load event fires, so
    // a single measurement on load undercounts when an inline image
    // is still streaming. ResizeObserver catches that, plus any
    // viewport-driven reflow (window resize, sheet width changes).
    const ro = new ResizeObserver(() => measure());
    if (doc.documentElement) ro.observe(doc.documentElement);
    if (doc.body) ro.observe(doc.body);

    // Image-load tickling for browsers that don't surface inline
    // image growth via ResizeObserver on the body (older Safari).
    const images = Array.from(doc.images);
    const imageListeners: Array<{ img: HTMLImageElement; handler: () => void }> = [];
    for (const img of images) {
      if (img.complete) continue;
      const handler = () => measure();
      img.addEventListener('load', handler);
      img.addEventListener('error', handler);
      imageListeners.push({ img, handler });
    }

    // Stash teardown so the load-handler closure can clean up on the
    // next unload (e.g. srcDoc change → second load fires).
    const node = ref.current;
    (node as unknown as { __cleanup?: () => void }).__cleanup = () => {
      ro.disconnect();
      for (const { img, handler } of imageListeners) {
        img.removeEventListener('load', handler);
        img.removeEventListener('error', handler);
      }
    };
  }, [measure]);

  // Clean up observers on unmount or when the iframe is about to
  // re-render with a different srcDoc.
  useEffect(() => {
    const node = ref.current;
    return () => {
      const cleanup = (node as unknown as { __cleanup?: () => void } | null)?.__cleanup;
      if (cleanup) cleanup();
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
        onLoad={onLoad}
        // Sandbox without allow-scripts — outgoing emails never need
        // JS, and disabling it eliminates the entire vector category.
        // allow-popups lets link clicks open in a new tab so staff
        // can verify CTA destinations without leaving the preview.
        // allow-same-origin is REQUIRED so the parent can read
        // contentDocument and measure scrollHeight. Without it the
        // iframe gets an opaque origin and ref.current.contentDocument
        // is null — measure() early-returns on every call, the iframe
        // stays pinned to its initial 800px, and any email taller than
        // that gets silently clipped. allow-same-origin without
        // allow-scripts cannot be exploited (no JS can run inside the
        // iframe), it just lets the parent inspect the document.
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        scrolling="no"
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
