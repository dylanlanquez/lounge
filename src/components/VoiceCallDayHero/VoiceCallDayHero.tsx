import type { ReactNode } from 'react';
import { ChevronRight, PhoneCall, PhoneMissed, PhoneOff } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentRow,
  isBookingLate,
  minutesPastStart,
  patientDisplayName,
} from '../../lib/queries/appointments.ts';
import { fmtTzAbbr } from '../../lib/dateFormat.ts';
import { voiceCallIsLive } from '../../lib/voiceCall.ts';

// The Voice call mode hero above the day's list.
//
// A voice call agent has one question all day: who am I calling next?
// The clinic toolbar (Filter, Down time) is replaced by this card,
// which answers it in one glance and keeps the day's shape beside it:
//
//   [phone]  NEXT CALL                       Calls  Done  Missed  Left
//            Kerry Lane                        6     2      1      3
//            2:30 pm BST · in 12 min      >
//
// Today, the headline is the next call still to make (or the one that
// is late, in alert red). A future day reads "First call"; a past day
// or a finished day reads a plain summary. Tapping the headline opens
// the same detail sheet as the row in the list.

export interface VoiceCallDayHeroProps {
  /** The day's voice call rows, any status. */
  rows: AppointmentRow[];
  now: Date;
  isToday: boolean;
  isPast: boolean;
  onOpen: (row: AppointmentRow) => void;
}

const VOICE = theme.category.voiceCall;
const VOICE_TINT = 'rgba(94, 87, 165, 0.12)';

export function VoiceCallDayHero({ rows, now, isToday, isPast, onOpen }: VoiceCallDayHeroProps) {
  const sorted = [...rows].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const done = sorted.filter((r) => r.status === 'complete').length;
  const missed = sorted.filter((r) => r.status === 'no_show').length;
  const off = sorted.filter((r) => r.status === 'cancelled' || r.status === 'rescheduled').length;
  const scheduled = sorted.length - off;
  const remaining = sorted.filter(
    (r) => voiceCallIsLive(r.status) && new Date(r.end_at).getTime() > now.getTime(),
  ).length;

  // Headline: today, the earliest live call whose slot has not ended
  // (so a late one stays on top until it is dealt with); another day,
  // the first live call in it.
  const headline = isToday
    ? sorted.find((r) => voiceCallIsLive(r.status) && new Date(r.end_at).getTime() > now.getTime()) ?? null
    : isPast
      ? null
      : sorted.find((r) => voiceCallIsLive(r.status)) ?? null;

  const late = headline && isToday && headline.status === 'booked' && isBookingLate(headline.start_at, now);
  const onTheLine = headline && (headline.status === 'arrived' || headline.status === 'joined');

  const eyebrow = !headline
    ? 'Calls'
    : late
      ? 'Late'
      : onTheLine
        ? 'On the line'
        : isToday
          ? 'Next call'
          : 'First call';

  const headlineText = headline
    ? patientDisplayName(headline)
    : isPast
      ? `${scheduled} ${scheduled === 1 ? 'call' : 'calls'} on this day`
      : scheduled === 0
        ? 'No calls booked'
        : 'All calls done';

  const detailText = headline
    ? `${formatClock(headline.start_at)} ${fmtTzAbbr(headline.start_at)}${isToday ? ` · ${relativeToNow(headline.start_at, now)}` : ''}`
    : isPast
      ? `${done} answered, ${missed} missed`
      : scheduled === 0
        ? 'Book a voice call to start the day.'
        : `${done} answered, ${missed} missed`;

  const accent = late ? theme.color.alert : VOICE;
  const glyph = late ? <PhoneMissed size={22} aria-hidden /> : headline || !isPast ? <PhoneCall size={22} aria-hidden /> : <PhoneOff size={22} aria-hidden />;

  return (
    <section
      aria-label="Voice calls for the day"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: theme.space[4],
        marginBottom: theme.space[3],
        padding: theme.space[2],
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.card,
        boxShadow: theme.shadow.card,
        flexWrap: 'wrap',
      }}
    >
      <HeadlineBlock
        accent={accent}
        eyebrow={eyebrow}
        title={headlineText}
        detail={detailText}
        glyph={glyph}
        onClick={headline ? () => onOpen(headline) : undefined}
      />
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(56px, 1fr))',
          gap: theme.space[1],
          alignItems: 'center',
          padding: `${theme.space[2]}px ${theme.space[3]}px`,
          flex: '1 1 260px',
        }}
      >
        <Stat label="Calls" value={scheduled} />
        <Stat label="Answered" value={done} tone={done > 0 ? 'accent' : 'muted'} />
        <Stat label="Missed" value={missed} tone={missed > 0 ? 'alert' : 'muted'} />
        <Stat label="Left" value={remaining} tone={remaining > 0 ? 'ink' : 'muted'} />
      </dl>
    </section>
  );
}

function HeadlineBlock({
  accent,
  eyebrow,
  title,
  detail,
  glyph,
  onClick,
}: {
  accent: string;
  eyebrow: string;
  title: string;
  detail: string;
  glyph: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span
        aria-hidden
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          background: accent === theme.color.alert ? 'rgba(184, 58, 42, 0.10)' : VOICE_TINT,
          color: accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            color: accent,
            textTransform: 'uppercase',
            letterSpacing: theme.type.tracking.wide,
          }}
        >
          {eyebrow}
        </span>
        <span
          style={{
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            lineHeight: theme.type.leading.tight,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail}
        </span>
      </span>
      {onClick ? (
        <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden style={{ flexShrink: 0 }} />
      ) : null}
    </>
  );
  const base = {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space[3],
    padding: `${theme.space[2]}px ${theme.space[3]}px`,
    borderRadius: theme.radius.input,
    minHeight: 64,
    flex: '1 1 280px',
    minWidth: 0,
    textAlign: 'left' as const,
  };
  if (!onClick) {
    return <div style={base}>{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${eyebrow}: ${title}, ${detail}. Open`}
      style={{
        ...base,
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        fontFamily: 'inherit',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = theme.color.bg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {inner}
    </button>
  );
}

function Stat({
  label,
  value,
  tone = 'ink',
}: {
  label: string;
  value: number;
  tone?: 'ink' | 'accent' | 'alert' | 'muted';
}) {
  const colour =
    tone === 'accent'
      ? theme.color.accent
      : tone === 'alert'
        ? theme.color.alert
        : tone === 'muted'
          ? theme.color.inkSubtle
          : theme.color.ink;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 0 }}>
      <dd
        style={{
          margin: 0,
          fontSize: theme.type.size.lg,
          fontWeight: theme.type.weight.semibold,
          color: colour,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: theme.type.leading.tight,
        }}
      >
        {value}
      </dd>
      <dt
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          color: theme.color.inkSubtle,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </dt>
    </div>
  );
}

// "in 12 min" / "now" / "4 min ago", clinic-agnostic (instants).
function relativeToNow(startIso: string, now: Date): string {
  const diffMin = Math.round((new Date(startIso).getTime() - now.getTime()) / 60_000);
  if (diffMin <= 0 && diffMin > -1) return 'now';
  if (diffMin < 0) {
    const late = minutesPastStart(startIso, now);
    return late >= 60 ? `started ${Math.floor(late / 60)} h ${late % 60} min ago` : `started ${late} min ago`;
  }
  if (diffMin >= 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  return `in ${diffMin} min`;
}

// 12-hour clinic time, matching the schedule rows.
function formatClock(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  return `${hh}${mm}${h < 12 ? 'am' : 'pm'}`;
}
