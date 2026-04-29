import { type ReactNode, useMemo } from 'react';
import {
  CalendarCheck,
  CreditCard,
  FileSignature,
  Flag,
  ShoppingBag,
  UserCheck,
} from 'lucide-react';
import { CollapsibleCard } from '../CollapsibleCard/CollapsibleCard.tsx';
import { Skeleton } from '../Skeleton/Skeleton.tsx';
import { theme } from '../../theme/index.ts';
import {
  type TimelineEvent,
  useVisitTimeline,
} from '../../lib/queries/visitTimeline.ts';

// ─────────────────────────────────────────────────────────────────────────────
// VisitTimeline — vertical audit trail rendered as a CollapsibleCard
// on the visit page. Stripe-Dashboard timeline pattern: each event
// gets a small icon dot on the left + a connector line, with the
// title and detail aligned to the right of the line.
//
// Empty state: a single "No events yet." line. Loading: three
// skeleton rows. Errors render as a quiet inline message; unlike a
// payment or upload, a missing timeline is non-fatal — the rest of
// the visit page still works.
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
    <CollapsibleCard
      icon={<Flag size={18} />}
      title="Timeline"
      meta={meta}
    >
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
    </CollapsibleCard>
  );
}

function Row({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const icon = iconFor(event);
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
          background: theme.color.accentBg,
          color: theme.color.accent,
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
            title={absoluteTimestamp(event.timestamp)}
          >
            {relativeTimestamp(event.timestamp)}
          </span>
        </div>
        {event.detail ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              lineHeight: 1.5,
            }}
          >
            {event.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
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

function absoluteTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
