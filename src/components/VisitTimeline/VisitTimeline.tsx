import { type ReactNode, useMemo } from 'react';
import {
  Box,
  CalendarCheck,
  CreditCard,
  FileSignature,
  Flag,
  ShoppingBag,
  UserCheck,
} from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import {
  type TimelineEvent,
  useVisitTimeline,
} from '../../lib/queries/visitTimeline.ts';

// ─────────────────────────────────────────────────────────────────────────────
// VisitTimeline — the visit page's audit trail. Always-visible card,
// not collapsed behind a toggle: this surface IS the receptionist's
// reference for what's happened on the visit, and a chevron-to-
// reveal pattern would treat it as ancillary detail when it isn't.
//
// Each row:
//   • icon dot on the left, connected by a vertical line to the next
//   • title (bold) on the right
//   • detail line (muted) summarising the event's facts
//   • optional "by Dylan Lane" suffix when the source row carries a
//     staff actor (lng_visits.receptionist_id, lng_payments.taken_by,
//     lng_waiver_signatures.witnessed_by, patient_events.actor_account_id)
// ─────────────────────────────────────────────────────────────────────────────

export interface VisitTimelineProps {
  visitId: string | null;
}

export function VisitTimeline({ visitId }: VisitTimelineProps) {
  const { events, loading, error } = useVisitTimeline(visitId);

  const meta = useMemo(() => {
    if (loading) return 'Loading';
    if (error) return 'Error';
    return `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  }, [loading, error, events.length]);

  return (
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
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.alert,
          }}
        >
          Could not load the timeline: {error}
        </p>
      ) : events.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
          }}
        >
          No events yet.
        </p>
      ) : (
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            position: 'relative',
          }}
        >
          {events.map((ev, i) => {
            const isLast = i === events.length - 1;
            return <Row key={ev.id} event={ev} isLast={isLast} />;
          })}
        </ol>
      )}
    </Card>
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
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[2],
          minWidth: 0,
        }}
      >
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

function Row({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
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
      {/* Connector line — the dot sits on top of it. */}
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
              <span style={{ color: theme.color.inkSubtle }}>by {event.actor}</span>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// Per-event tone for the icon dot. Keeps to the existing palette
// (accent / warn / alert / neutral) so the timeline reads as a
// quick scan: green = positive milestone, amber = soft-terminal /
// caution, red = failure, grey = neutral activity.
//
// Granular dispatch: type='patient_event' covers many event_types
// (registration / unsuitable / ended_early / deposit_failed). We
// disambiguate by the title string set in HUMAN_PATIENT_EVENT.
type EventTone = { bg: string; fg: string };
const TONE: Record<'accent' | 'warn' | 'alert' | 'neutral', EventTone> = {
  accent: { bg: theme.color.accentBg, fg: theme.color.accent },
  warn: { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn },
  alert: { bg: 'rgba(184, 58, 42, 0.10)', fg: theme.color.alert },
  neutral: { bg: 'rgba(14, 20, 20, 0.05)', fg: theme.color.inkMuted },
};

function toneFor(event: TimelineEvent): EventTone {
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
      // Patient-event titles come from HUMAN_PATIENT_EVENT in
      // visitTimeline.ts. Tone follows the semantic weight:
      //   - reversal / re-open = positive (accent)
      //   - terminal-but-soft = warn
      //   - failure = alert
      //   - everything else = neutral
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
    case 'box':
      return <Box size={size} />;
    case 'flag':
    default:
      return <Flag size={size} />;
  }
}

// Relative timestamp formatting for the right-hand column. Falls
// back to a date for anything older than a week so the timeline
// stays scannable.
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
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
  });
}

// Compact absolute timestamp for the right column. Format depends
// on how recent the event is so the column stays scannable:
//   today          → "18:30"
//   this year      → "30 Apr · 18:30"
//   earlier years  → "30 Apr 2025 · 18:30"
// 24-hour clock throughout (en-GB).
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

