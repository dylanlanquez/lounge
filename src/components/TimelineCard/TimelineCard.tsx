import { type ReactNode, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Box,
  CalendarCheck,
  CreditCard,
  BellRing,
  Eye,
  FileSignature,
  Flag,
  HandCoins,
  Loader2,
  Mail,
  MessageSquare,
  MessageSquareWarning,
  RotateCcw,
  Send,
  ShoppingBag,
  UserCheck,
} from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { DepositGlyph } from '../DepositGlyph/DepositGlyph.tsx';
import { DiscountIcon } from '../Icons/DiscountIcon.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { Toast } from '../Toast/Toast.tsx';
import { EmailPreviewModal } from '../EmailPreviewModal/EmailPreviewModal.tsx';
import { SmsPreviewModal } from '../SmsPreviewModal/SmsPreviewModal.tsx';
import { theme } from '../../theme/index.ts';
import type { TimelineEvent } from '../../lib/queries/visitTimeline.ts';
import {
  resendAppointmentEmail,
  resendEmailByMessageId,
} from '../../lib/queries/resendAppointmentEmail.ts';

// Pure presentation for an audit-trail timeline. Takes a fully
// hydrated event list (each event already carries its title /
// detail / actor / hint / optional tone) and renders the same
// vertically-connected dot+row layout used on both VisitDetail and
// AppointmentDetail.
//
// Decoupled from any specific data source so two surfaces can share
// it: the visit timeline aggregates patient_events + lng_visits +
// lng_payments + waiver signatures, the appointment timeline reads
// only the appointment-scoped patient_events. Both flow through this
// component so the visual language is guaranteed identical.

export interface TimelineCardProps {
  events: TimelineEvent[];
  loading: boolean;
  error: string | null;
  // Optional override for the empty-state copy. Defaults to
  // "No events yet." which works for the visit timeline but reads
  // a bit odd on a fresh booking; the appointment timeline passes
  // a better-fitting message.
  emptyMessage?: string;
}

export function TimelineCard({ events, loading, error, emptyMessage }: TimelineCardProps) {
  const meta = useMemo(() => {
    if (loading) return 'Loading';
    if (error) return 'Error';
    return `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  }, [loading, error, events.length]);

  // The Timeline owns the email-preview modal so a single instance handles
  // every "View email" trigger in the list — opening one row never tears
  // down another, and the modal mounts above the Card's stacking context.
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Same one-modal-per-list pattern for SMS rows. View SMS pill on any
  // sms_queued / sms_delivered / sms_failed row opens this against
  // the lng_sms_messages id resolved by visitTimeline.ts.
  const [smsPreviewId, setSmsPreviewId] = useState<string | null>(null);
  // Track which event id is mid-resend so its pill renders a spinner,
  // and stash the toast state for the post-send confirmation. The
  // resend dispatcher uses the row's resendKind + resendAppointmentId
  // to invoke the right edge function, which re-renders against
  // current data and reads patient.email fresh.
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<
    | { tone: 'success' | 'error'; title: string; description?: string }
    | null
  >(null);

  const handleResend = async (event: TimelineEvent) => {
    // Prefer the per-kind resender when the event carries one — it
    // re-renders the email against current appointment data, which
    // matters for confirmations (in case the booking was rescheduled
    // between sends). Fall back to the generic emailMessageId replay
    // for receipts / dispatch notifications / anything else whose
    // content is immutable after the original send.
    const useKindSender = event.resendKind && event.resendAppointmentId;
    const useGenericSender = !useKindSender && event.emailMessageId;
    if (!useKindSender && !useGenericSender) return;
    setResendingId(event.id);
    try {
      const result = useKindSender
        ? await resendAppointmentEmail({
            kind: event.resendKind!,
            appointmentId: event.resendAppointmentId!,
          })
        : await resendEmailByMessageId(event.emailMessageId!);
      if (result.ok) {
        setToast({
          tone: 'success',
          title: 'Email resent',
          description: result.recipient ? `Sent to ${result.recipient}` : undefined,
        });
      } else {
        setToast({
          tone: 'error',
          title: 'Could not resend',
          description: result.error ?? undefined,
        });
      }
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not resend',
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setResendingId(null);
    }
  };

  return (
    <>
      <Card padding="lg">
        <Header meta={meta} />
        <div
          style={{
            height: 1,
            background: theme.color.border,
            margin: `${theme.space[4]}px 0 ${theme.space[5]}px`,
          }}
        />
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
            <Skeleton height={48} radius={12} />
            <Skeleton height={48} radius={12} />
            <Skeleton height={48} radius={12} />
          </div>
        ) : error ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
            Could not load the timeline: {error}
          </p>
        ) : events.length === 0 ? (
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            {emptyMessage ?? 'No events yet.'}
          </p>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
            {events.map((ev, i) => (
              <Row
                key={ev.id}
                event={ev}
                isLast={i === events.length - 1}
                onPreviewEmail={setPreviewId}
                onPreviewSms={setSmsPreviewId}
                onResend={handleResend}
                resending={resendingId === ev.id}
              />
            ))}
          </ol>
        )}
      </Card>
      <EmailPreviewModal
        open={previewId !== null}
        emailMessageId={previewId}
        onClose={() => setPreviewId(null)}
      />
      <SmsPreviewModal
        open={smsPreviewId !== null}
        smsMessageId={smsPreviewId}
        onClose={() => setSmsPreviewId(null)}
      />
      {toast ? (
        <Toast
          tone={toast.tone}
          title={toast.title}
          description={toast.description}
          onDismiss={() => setToast(null)}
        />
      ) : null}
      <SpinKeyframe />
    </>
  );
}

// One-shot keyframe injection for the Resend button's spinner. Lucide
// icons don't carry their own animation, and there's no global spinner
// stylesheet to piggyback on — declaring it here keeps the rotation
// self-contained to the surface that needs it.
function SpinKeyframe() {
  return (
    <style>{`
      @keyframes lng-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `}</style>
  );
}

function Header({ meta }: { meta: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
        <Flag size={18} aria-hidden />
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          Timeline
        </h2>
      </span>
      <span
        style={{
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: theme.type.weight.medium,
        }}
      >
        {meta}
      </span>
    </div>
  );
}

function Row({
  event,
  isLast,
  onPreviewEmail,
  onPreviewSms,
  onResend,
  resending,
}: {
  event: TimelineEvent;
  isLast: boolean;
  onPreviewEmail: (id: string) => void;
  onPreviewSms: (id: string) => void;
  onResend: (event: TimelineEvent) => void;
  resending: boolean;
}) {
  const icon = iconFor(event);
  const tone = toneFor(event);
  return (
    <li
      style={{
        position: 'relative',
        display: 'flex',
        gap: theme.space[3],
        paddingBottom: isLast ? 0 : theme.space[4],
      }}
    >
      {isLast ? null : (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 17,
            top: 36,
            bottom: 0,
            width: 1,
            background: theme.color.border,
          }}
        />
      )}
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: theme.radius.pill,
          background: tone.bg,
          color: tone.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: theme.space[3],
            alignItems: 'baseline',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              lineHeight: 1.35,
            }}
          >
            {event.title}
          </p>
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
            title={relativeTimestamp(event.timestamp)}
          >
            {compactTimestamp(event.timestamp)}
          </span>
        </div>
        {event.detail || event.actor ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: 1.5,
            }}
          >
            {event.detail}
            {event.detail && event.actor ? (
              <span style={{ color: theme.color.inkSubtle }}>{' · '}</span>
            ) : null}
            {event.actor ? (
              <span style={{ color: theme.color.inkSubtle }}>
                by {event.actor}
                {event.approver ? `, approved by ${event.approver}` : ''}
              </span>
            ) : null}
          </p>
        ) : null}
        {event.notifiedManagers && event.notifiedManagers.length > 0 ? (
          <NotifiedManagersLine managers={event.notifiedManagers} />
        ) : null}
        {event.facts && event.facts.length > 0 ? (
          <FactsLine facts={event.facts} />
        ) : null}
        {(() => {
          const hasView = !!event.emailMessageId;
          const hasKindResend = !!(event.resendKind && event.resendAppointmentId);
          // Every email-bearing row gets a Resend button — bespoke kind
          // when one's wired (re-renders against current data), generic
          // emailMessageId replay otherwise.
          const hasResend = hasKindResend || hasView;
          const hasViewSms = !!event.smsMessageId;
          if (!hasView && !hasResend && !hasViewSms) return null;
          return (
            <EmailActionRow>
              {hasView ? (
                <ViewEmailButton onClick={() => onPreviewEmail(event.emailMessageId!)} />
              ) : null}
              {hasResend ? (
                <ResendEmailButton busy={resending} onClick={() => onResend(event)} />
              ) : null}
              {hasViewSms ? (
                <ViewSmsButton onClick={() => onPreviewSms(event.smsMessageId!)} />
              ) : null}
            </EmailActionRow>
          );
        })()}
      </div>
    </li>
  );
}

// Two-pill action row glued to the bottom of an email-bearing event
// card. Keeps the buttons grouped together so they read as a single
// affordance set, with a small gap that mirrors the FactsLine spacing
// above.
function EmailActionRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: theme.space[2],
        display: 'flex',
        flexWrap: 'wrap',
        gap: theme.space[2],
      }}
    >
      {children}
    </div>
  );
}

// Anchored to the bottom of the row, right under the detail line and any
// facts chips. Reads as part of the event card rather than an external
// action — same typographic weight as the actor suffix, with a subtle
// accent treatment to invite the click. Pill border keeps it visually
// adjacent to the facts chips without competing for attention.
function ViewEmailButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={emailPillStyle({ hover, busy: false, primary: true })}
    >
      <Eye size={12} aria-hidden />
      View email
    </button>
  );
}

// SMS counterpart to ViewEmailButton — same pill chrome, swapped
// icon + label so the timeline reads "View SMS" against text-message
// rows. There is no Resend SMS sibling yet; the receptionist
// triggers a fresh send from the Notify the patient card on
// VisitDetail rather than re-firing a frozen body. Keeping the
// trigger here surfaces the audit row without duplicating the
// resend affordance.
function ViewSmsButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={emailPillStyle({ hover, busy: false, primary: true })}
    >
      <MessageSquare size={12} aria-hidden />
      View SMS
    </button>
  );
}

// Pairs with ViewEmailButton. Secondary visual weight — outline-only
// when idle, hover lifts to the accent like its sibling, and the
// spinner replaces the send icon during the re-invoke so the
// receptionist sees something is happening without having to wait
// for the toast.
function ResendEmailButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={busy ? 'Resending email' : 'Resend email'}
      style={emailPillStyle({ hover, busy, primary: false })}
    >
      {busy ? (
        <Loader2
          size={12}
          aria-hidden
          style={{ animation: 'lng-spin 600ms linear infinite' }}
        />
      ) : (
        <Send size={12} aria-hidden />
      )}
      {busy ? 'Sending' : 'Resend'}
    </button>
  );
}

function emailPillStyle({
  hover,
  busy,
  primary,
}: {
  hover: boolean;
  busy: boolean;
  primary: boolean;
}): React.CSSProperties {
  const borderActive = hover && !busy;
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: theme.radius.pill,
    border: `1px solid ${borderActive ? theme.color.accent : theme.color.border}`,
    background: primary
      ? hover && !busy
        ? theme.color.accentBg
        : theme.color.surface
      : theme.color.surface,
    color: busy ? theme.color.inkMuted : theme.color.accent,
    fontSize: theme.type.size.xs,
    fontWeight: theme.type.weight.semibold,
    letterSpacing: theme.type.tracking.tight,
    cursor: busy ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    opacity: busy ? 0.7 : 1,
  };
}

// Per-event tone for the icon dot. Explicit tone on the event wins;
// otherwise we fall back to the type-derived defaults that the visit
// timeline relies on (those titles are visit-specific and shouldn't
// be touched without understanding the existing surfaces).
type EventTone = { bg: string; fg: string };
const TONE: Record<'accent' | 'warn' | 'alert' | 'neutral', EventTone> = {
  accent: { bg: theme.color.accentBg, fg: theme.color.accent },
  warn: { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn },
  alert: { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert },
  neutral: { bg: 'rgba(14, 20, 20, 0.05)', fg: theme.color.inkMuted },
};

// Renders structured facts as small inline chip pills under the
// event detail line. Each chip shows "label value" with label muted
// and value in ink semibold, on a soft tinted surface with a 1px
// border. Wraps onto multiple rows when needed.
//
// Previous versions went through both a tinted box (too heavy) and
// flat inline prose (every word same weight, no visual depth). Chips
// give the structured facts their own visual rhythm while staying
// quieter than the event title.
// Below the detail line, a compact note that surfaces the managers
// who received the manager_notification email when the event was
// recorded. Bell icon + comma-joined names. Reads at the same
// weight as the actor suffix above so the eye groups them as one
// audit unit.
function NotifiedManagersLine({
  managers,
}: {
  managers: ReadonlyArray<{ id: string; name: string }>;
}) {
  const names = managers.map((m) => m.name).join(', ');
  const label = managers.length === 1 ? 'Notified' : 'Notified';
  return (
    <p
      style={{
        margin: `${theme.space[1]}px 0 0`,
        fontSize: theme.type.size.xs,
        color: theme.color.inkSubtle,
        lineHeight: 1.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      <BellRing size={11} aria-hidden style={{ flexShrink: 0 }} />
      <span style={{ fontWeight: theme.type.weight.medium }}>{label}:</span>
      <span>{names}</span>
    </p>
  );
}

function FactsLine({ facts }: { facts: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: theme.space[2],
        marginTop: theme.space[2],
      }}
    >
      {facts.map((f, i) => (
        <span
          key={`${f.label}|${i}`}
          style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 6,
            padding: '4px 10px',
            borderRadius: theme.radius.pill,
            background: theme.color.bg,
            border: `1px solid ${theme.color.border}`,
            fontSize: theme.type.size.xs,
            lineHeight: 1.3,
            maxWidth: '100%',
          }}
        >
          <span
            style={{
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              flexShrink: 0,
            }}
          >
            {f.label}
          </span>
          <span
            style={{
              color: theme.color.ink,
              fontWeight: theme.type.weight.semibold,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {f.value}
          </span>
        </span>
      ))}
    </div>
  );
}

function toneFor(event: TimelineEvent): EventTone {
  if (event.tone) return TONE[event.tone];
  switch (event.type) {
    case 'appointment_created':
    case 'deposit_paid':
    case 'visit_opened':
    case 'waiver_signed':
    case 'payment_succeeded':
      return TONE.accent;
    case 'payment_failed':
      return TONE.alert;
    case 'cart_item_added':
    case 'jb_assigned':
    case 'jb_freed':
    case 'visit_closed':
      return TONE.neutral;
    case 'patient_event': {
      const t = event.title;
      if (t === 'Unsuitable reversed') return TONE.accent;
      if (t === 'Marked unsuitable' || t === 'Visit ended early') return TONE.warn;
      if (t === 'Cart line removed') return TONE.warn;
      if (t === 'Deposit failed') return TONE.alert;
      return TONE.neutral;
    }
    default:
      return TONE.neutral;
  }
}

function iconFor(event: TimelineEvent): ReactNode {
  const size = 16;
  switch (event.hint) {
    case 'calendar':
      return <CalendarCheck size={size} />;
    case 'cart':
      return <ShoppingBag size={size} />;
    case 'check':
      return <UserCheck size={size} />;
    case 'signature':
      return <FileSignature size={size} />;
    case 'card':
      return <CreditCard size={size} />;
    case 'deposit':
      return <DepositGlyph size={18} />;
    case 'paid_in_full':
      // Solid badge-with-check — the same mark the AppointmentDetail
      // Deposit card and the Schedule popup use for fully-settled
      // bookings. The visual contrast against the dashed DepositGlyph
      // is intentional: dashed = balance still owed; solid = nothing
      // to collect.
      return <BadgeCheck size={size + 2} />;
    case 'discount':
      return <DiscountIcon size={16} />;
    case 'box':
      return <Box size={size} />;
    case 'mail':
      return <Mail size={size} />;
    case 'sms':
      return <MessageSquare size={size} />;
    case 'sms_failed':
      return <MessageSquareWarning size={size} />;
    case 'refund_owed':
      // Hand-with-coins reads as "we're holding the patient's
      // money" — the unresolved-debt moment that the visit page
      // surfaces as the red banner.
      return <HandCoins size={size} />;
    case 'refund_issued':
      // Counter-clockwise rotate — money has been returned. Pairs
      // visually with the HandCoins for refund_owed: one says
      // "owed", the other says "given back".
      return <RotateCcw size={size} />;
    case 'flag':
    default:
      return <Flag size={size} />;
  }
}

function relativeTimestamp(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const now = Date.now();
  const diffMs = now - t;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function compactTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date} · ${time}`;
}
