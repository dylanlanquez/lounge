import type { CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  formatRelativeShort,
  NOTIFICATION_TYPE_LABELS,
  type NotificationRow as NotificationRowData,
  type NotificationEventType,
} from '../../lib/queries/notifications.ts';
import { NotificationIcon } from './NotificationIcon.tsx';

// formatBookingTypeForNotification returns "Appointment" as the
// fallback when service_type / event_type_label / product_key are
// all unresolved. Treat that as "type unknown" so the sentence
// template can pivot to a shorter shape instead of reading
// "rescheduled their Appointment." — which carries no information.
const FALLBACK_BOOKING_TYPE = 'Appointment';

interface NotificationRowProps {
  row: NotificationRowData;
  // True iff this row was created after the staff's last_viewed_at
  // cutoff. Drives the subtle left-edge accent strip that marks
  // unseen rows — Linear / Stripe Inbox convention.
  unseen: boolean;
  // Optional substring to highlight in the patient name + booking
  // type fields. Search results use this to mark matching characters.
  highlight?: string;
  onActivate: (linkPath: string) => void;
}

export function NotificationRow({ row, unseen, highlight, onActivate }: NotificationRowProps) {
  const labels = NOTIFICATION_TYPE_LABELS[row.event_type];
  const interactive = !!row.link_path;
  const relative = formatRelativeShort(row.created_at);
  const activate = () => {
    if (row.link_path) onActivate(row.link_path);
  };

  return (
    <button
      type="button"
      onClick={activate}
      disabled={!interactive}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        padding: 0,
        cursor: interactive ? 'pointer' : 'default',
        width: '100%',
        fontFamily: 'inherit',
        color: 'inherit',
      }}
    >
      <article
        style={{
          display: 'flex',
          gap: theme.space[4],
          // 20px top + bottom gives the row breathing room without
          // bloat — splits the difference between iOS list-row 14px
          // and Linear-inbox 24px conventions. 16px was reading too
          // tight on the tablet at the default zoom.
          padding: `${theme.space[5]}px ${theme.space[5]}px`,
          borderBottom: `1px solid ${theme.color.border}`,
          position: 'relative',
          // Unseen rows show a 3px accent-coloured spine on the left
          // edge — subtle, doesn't compete with the bell badge, and
          // disappears the next time the bell is opened.
          boxShadow: unseen ? `inset 3px 0 0 0 ${theme.color.accent}` : undefined,
          background: unseen ? 'rgba(31, 77, 58, 0.025)' : theme.color.surface,
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <NotificationIcon type={row.event_type} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          {/* Top row: sentence-case event label + relative timestamp.
              Previous treatment used uppercase + wide tracking which
              Dylan flagged as "messy and hard to read" — the eyebrow
              competed visually with the body sentence. Switching to
              title case + medium weight + muted ink lets the
              hierarchy read as: subtle label → bold sentence → quiet
              action link. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: theme.space[2],
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.inkMuted,
                letterSpacing: theme.type.tracking.normal,
              }}
            >
              {labels.short}
            </span>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkSubtle,
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {relative}
            </span>
          </div>

          {/* Middle row: per-event sentence. Phrased to read
              naturally for each event type — see NotificationSentence
              below. */}
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              color: theme.color.ink,
              lineHeight: theme.type.leading.snug,
              wordBreak: 'break-word',
            }}
          >
            <NotificationSentence row={row} highlight={highlight} />
          </p>

          {/* Bottom row: action affordance. Only shown when there's
              somewhere to go — visit_ended_early without a visit_id
              would have link_path=null. */}
          {interactive ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[1],
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.accent,
              }}
            >
              {row.event_type === 'visit_ended_early' ||
              row.event_type === 'patient_unsuitable_reversed' ||
              (row.event_type === 'refund_issued' && row.link_path?.startsWith('/visit/'))
                ? 'View visit'
                : 'View appointment'}
              <ArrowRight size={14} />
            </span>
          ) : null}
        </div>
      </article>
    </button>
  );
}

// Per-event-type sentence template. Each type reads naturally in
// English and degrades gracefully when the booking type is
// unresolved (falls back to a shorter shape rather than the
// uninformative "for Appointment" fallback Dylan flagged).
function NotificationSentence({
  row,
  highlight,
}: {
  row: NotificationRowData;
  highlight?: string;
}) {
  const typeKnown = row.booking_type && row.booking_type !== FALLBACK_BOOKING_TYPE;

  // Helpers for the inline run. Bold = key noun (patient / booking
  // type / date); plain muted = connective tissue ("booked for",
  // "on", etc).
  const Name = (
    <HighlightedText
      text={row.patient_name}
      highlight={highlight}
      weight={theme.type.weight.semibold}
    />
  );
  const Type = typeKnown ? (
    <HighlightedText
      text={row.booking_type}
      highlight={highlight}
      weight={theme.type.weight.semibold}
    />
  ) : null;
  const Date = row.scheduled_at_label ? (
    <HighlightedText
      text={row.scheduled_at_label}
      highlight={highlight}
      weight={theme.type.weight.medium}
    />
  ) : null;

  // Actor handle — only renders when actor_role='staff' AND we
  // resolved a name. Customer / system rows leave this null and the
  // sentence falls back to patient-as-subject or passive voice.
  const Actor =
    row.actor_role === 'staff' && row.actor_name ? (
      <HighlightedText
        text={row.actor_name}
        highlight={highlight}
        weight={theme.type.weight.semibold}
      />
    ) : null;

  switch (row.event_type as NotificationEventType) {
    case 'appointment_booked':
      // Three voicings depending on who actually did the booking:
      //   staff:    "Dylan Lane booked Kerry MacPhee in for Click-in veneers on …"
      //   customer: "Kerry MacPhee booked Click-in veneers on …"
      //   system:   "A new Click-in veneers booking was made for Kerry MacPhee on …"
      // Type-unknown collapses each to a tighter form.
      if (Actor) {
        return typeKnown ? (
          <>
            {Actor}
            <Muted> booked </Muted>
            {Name}
            <Muted> in for </Muted>
            {Type}
            {Date ? (
              <>
                <Muted> on </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Actor}
            <Muted> booked an appointment for </Muted>
            {Name}
            {Date ? (
              <>
                <Muted> on </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        );
      }
      if (row.actor_role === 'customer') {
        return typeKnown ? (
          <>
            {Name}
            <Muted> booked </Muted>
            {Type}
            {Date ? (
              <>
                <Muted> on </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Name}
            <Muted> booked a new appointment{Date ? ' for ' : ''}</Muted>
            {Date}.
          </>
        );
      }
      return typeKnown ? (
        <>
          <Muted>A new </Muted>
          {Type}
          <Muted> booking was made for </Muted>
          {Name}
          {Date ? (
            <>
              <Muted> on </Muted>
              {Date}
            </>
          ) : null}
          .
        </>
      ) : (
        <>
          <Muted>A new appointment was made for </Muted>
          {Name}
          {Date ? (
            <>
              <Muted> on </Muted>
              {Date}
            </>
          ) : null}
          .
        </>
      );

    case 'appointment_rescheduled':
      // staff:    "Dylan Lane rescheduled Michael Liddle's Denture Repair to …"
      // customer: "Michael Liddle rescheduled their Denture Repair to …"
      // system:   "Michael Liddle's Denture Repair was rescheduled to …"
      if (Actor) {
        return typeKnown ? (
          <>
            {Actor}
            <Muted> rescheduled </Muted>
            {Name}
            <Muted>{`’s `}</Muted>
            {Type}
            {Date ? (
              <>
                <Muted> to </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Actor}
            <Muted> rescheduled </Muted>
            {Name}
            <Muted>{`’s appointment${Date ? ' to ' : ''}`}</Muted>
            {Date}.
          </>
        );
      }
      if (row.actor_role === 'customer') {
        return typeKnown ? (
          <>
            {Name}
            <Muted> rescheduled their </Muted>
            {Type}
            {Date ? (
              <>
                <Muted> to </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Name}
            <Muted> rescheduled their appointment{Date ? ' to ' : ''}</Muted>
            {Date}.
          </>
        );
      }
      return typeKnown ? (
        <>
          {Name}
          <Muted>{`’s `}</Muted>
          {Type}
          <Muted> was rescheduled</Muted>
          {Date ? (
            <>
              <Muted> to </Muted>
              {Date}
            </>
          ) : null}
          .
        </>
      ) : (
        <>
          {Name}
          <Muted>{`’s appointment was rescheduled${Date ? ' to ' : ''}`}</Muted>
          {Date}.
        </>
      );

    case 'appointment_cancelled':
      // staff:    "Dylan Lane cancelled Steve Swann's Click-in veneers scheduled for …"
      // customer: "Steve Swann cancelled their Click-in veneers scheduled for …"
      // system:   "Steve Swann's Click-in veneers was cancelled (scheduled for …)"
      if (Actor) {
        return typeKnown ? (
          <>
            {Actor}
            <Muted> cancelled </Muted>
            {Name}
            <Muted>{`’s `}</Muted>
            {Type}
            {Date ? (
              <>
                <Muted> scheduled for </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Actor}
            <Muted> cancelled </Muted>
            {Name}
            <Muted>{`’s appointment${Date ? ' scheduled for ' : ''}`}</Muted>
            {Date}.
          </>
        );
      }
      if (row.actor_role === 'customer') {
        return typeKnown ? (
          <>
            {Name}
            <Muted> cancelled their </Muted>
            {Type}
            {Date ? (
              <>
                <Muted> scheduled for </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Name}
            <Muted> cancelled their appointment{Date ? ' scheduled for ' : ''}</Muted>
            {Date}.
          </>
        );
      }
      return typeKnown ? (
        <>
          {Name}
          <Muted>{`’s `}</Muted>
          {Type}
          <Muted> was cancelled</Muted>
          {Date ? (
            <>
              <Muted> (scheduled for </Muted>
              {Date}
              <Muted>)</Muted>
            </>
          ) : null}
          .
        </>
      ) : (
        <>
          {Name}
          <Muted>{`’s appointment was cancelled${Date ? ' (scheduled for ' : ''}`}</Muted>
          {Date}
          {Date ? <Muted>)</Muted> : null}
          .
        </>
      );

    case 'visit_ended_early':
      // "Dylan Lane's Denture Repair visit ended early."
      // Type-unknown: "Dylan Lane's visit ended early." — covers walk-ins
      // and appointments where the lookup couldn't resolve a type.
      return typeKnown ? (
        <>
          {Name}
          <Muted>{`’s `}</Muted>
          {Type}
          <Muted> visit ended early</Muted>.
        </>
      ) : (
        <>
          {Name}
          <Muted>{`’s visit ended early`}</Muted>.
        </>
      );

    case 'patient_unsuitable_reversed':
      // Visit was resumed (the in-app "Resume visit" button or an
      // admin reversing an unsuitable verdict). Same name+type
      // shape as visit_ended_early so the two sit visually
      // symmetric in the list.
      return typeKnown ? (
        <>
          {Name}
          <Muted>{`’s `}</Muted>
          {Type}
          <Muted> visit was resumed</Muted>.
        </>
      ) : (
        <>
          {Name}
          <Muted>{`’s visit was resumed`}</Muted>.
        </>
      );

    case 'no_show':
      // staff:  "Dylan Lane marked Nevin Peterson as no show for their Click-in veneers on …"
      // else:   "Nevin Peterson was marked as no show for their Click-in veneers on …"
      if (Actor) {
        return typeKnown ? (
          <>
            {Actor}
            <Muted> marked </Muted>
            {Name}
            <Muted> as no show for their </Muted>
            {Type}
            {Date ? (
              <>
                <Muted> on </Muted>
                {Date}
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            {Actor}
            <Muted> marked </Muted>
            {Name}
            <Muted> as no show{Date ? ' for their appointment on ' : ''}</Muted>
            {Date}.
          </>
        );
      }
      return typeKnown ? (
        <>
          {Name}
          <Muted> was marked as no show for their </Muted>
          {Type}
          {Date ? (
            <>
              <Muted> on </Muted>
              {Date}
            </>
          ) : null}
          .
        </>
      ) : (
        <>
          {Name}
          <Muted> was marked as no show for their appointment{Date ? ' on ' : ''}</Muted>
          {Date}.
        </>
      );

    case 'no_show_reversed':
      // "Dylan Lane's Denture Repair no-show was reversed."
      // Type-unknown: "Dylan Lane's no-show was reversed."
      return typeKnown ? (
        <>
          {Name}
          <Muted>{`’s `}</Muted>
          {Type}
          <Muted> no-show was reversed</Muted>.
        </>
      ) : (
        <>
          {Name}
          <Muted>{`’s no-show was reversed`}</Muted>.
        </>
      );

    case 'refund_issued': {
      // "Dylan Lane was refunded £30.00 on their Denture Repair, partial cash refund."
      // "Dylan Lane was refunded £199.00 on their Denture Repair, full cash refund."
      // Type-unknown: "Dylan Lane was refunded £30.00, partial cash refund."
      const amount =
        typeof row.refund_amount_pence === 'number'
          ? formatPenceForSentence(row.refund_amount_pence)
          : null;
      const fullnessLabel = row.refund_is_full === false ? 'partial' : 'full';
      const methodLabel = humaniseRefundMethod(row.refund_method);
      const tail = `${fullnessLabel}${methodLabel ? ` ${methodLabel}` : ''} refund`;
      if (!amount) {
        // Defensive — every refund_issued payload carries
        // amount_pence; this branch keeps us safe if a legacy row
        // is missing the field.
        return typeKnown ? (
          <>
            {Name}
            <Muted> was refunded on their </Muted>
            {Type}
            <Muted>{`, ${tail}`}</Muted>.
          </>
        ) : (
          <>
            {Name}
            <Muted>{` was refunded, ${tail}`}</Muted>.
          </>
        );
      }
      return typeKnown ? (
        <>
          {Name}
          <Muted> was refunded </Muted>
          <HighlightedText
            text={amount}
            highlight={highlight}
            weight={theme.type.weight.semibold}
          />
          <Muted> on their </Muted>
          {Type}
          <Muted>{`, ${tail}`}</Muted>.
        </>
      ) : (
        <>
          {Name}
          <Muted> was refunded </Muted>
          <HighlightedText
            text={amount}
            highlight={highlight}
            weight={theme.type.weight.semibold}
          />
          <Muted>{`, ${tail}`}</Muted>.
        </>
      );
    }
  }
}

// Locally-scoped helpers — pence formatting + method label. Kept
// here instead of imported from queries/carts so the sentence
// stays self-contained and the helper signature can't accidentally
// drift from the template.
function formatPenceForSentence(pence: number): string {
  const pounds = Math.abs(pence) / 100;
  const formatted = pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `£${formatted}`;
}

function humaniseRefundMethod(method: string | null): string {
  if (!method) return '';
  switch (method) {
    case 'cash':
      return 'cash';
    case 'card_terminal':
      return 'card';
    case 'klarna':
      return 'Klarna';
    case 'clearpay':
      return 'Clearpay';
    default:
      return method;
  }
}

function Muted({ children }: { children: React.ReactNode }) {
  const style: CSSProperties = { color: theme.color.inkMuted };
  return <span style={style}>{children}</span>;
}

// Highlights substrings of `text` matching `highlight` (case-
// insensitive). Used by the search filter to surface which row
// fields matched.
function HighlightedText({
  text,
  highlight,
  weight,
}: {
  text: string;
  highlight?: string;
  weight: number;
}) {
  const baseStyle = { fontWeight: weight };
  const q = highlight?.trim();
  if (!q) return <span style={baseStyle}>{text}</span>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  if (!lower.includes(needle)) return <span style={baseStyle}>{text}</span>;
  const segments: Array<{ value: string; mark: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) {
      segments.push({ value: text.slice(cursor), mark: false });
      break;
    }
    if (idx > cursor) segments.push({ value: text.slice(cursor, idx), mark: false });
    segments.push({ value: text.slice(idx, idx + needle.length), mark: true });
    cursor = idx + needle.length;
  }
  return (
    <span style={baseStyle}>
      {segments.map((s, i) =>
        s.mark ? (
          <mark
            key={i}
            style={{
              background: 'rgba(179, 104, 21, 0.18)',
              color: 'inherit',
              padding: 0,
              borderRadius: 2,
            }}
          >
            {s.value}
          </mark>
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </span>
  );
}
