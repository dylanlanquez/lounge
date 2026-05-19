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
              {row.event_type === 'visit_ended_early' ? 'View visit' : 'View appointment'}
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

  switch (row.event_type as NotificationEventType) {
    case 'appointment_booked':
      // "Dylan Lane booked for Denture Repair on Tuesday, 19 May 2026 at 11:30 BST."
      // Type-unknown fallback: "Dylan Lane booked a new appointment for Tuesday, 19 May 2026 at 11:30 BST."
      return typeKnown ? (
        <>
          {Name}
          <Muted> booked for </Muted>
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

    case 'appointment_rescheduled':
      // "Michael Liddle rescheduled their Denture Repair to Monday, 25 May 2026 at 13:00 BST."
      // Type-unknown: "Michael Liddle rescheduled their appointment to Monday, 25 May 2026 at 13:00 BST."
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

    case 'appointment_cancelled':
      // "Dylan Lane cancelled their Denture Repair scheduled for Tuesday, 19 May 2026 at 11:30 BST."
      // Type-unknown: "Dylan Lane cancelled their appointment scheduled for Tuesday, 19 May 2026 at 11:30 BST."
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
