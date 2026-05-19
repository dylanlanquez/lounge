import { ArrowRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import {
  formatRelativeShort,
  NOTIFICATION_TYPE_LABELS,
  type NotificationRow as NotificationRowData,
} from '../../lib/queries/notifications.ts';
import { NotificationIcon } from './NotificationIcon.tsx';

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
          gap: theme.space[3],
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
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
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
          {/* Top row: short event-type label + relative timestamp */}
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
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.inkMuted,
                letterSpacing: theme.type.tracking.wide,
                textTransform: 'uppercase',
              }}
            >
              {labels.short}
            </span>
            <span
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkSubtle,
                whiteSpace: 'nowrap',
              }}
            >
              {relative}
            </span>
          </div>

          {/* Middle row: the sentence. "[Name] [verb] [type] on [datetime]" */}
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              color: theme.color.ink,
              lineHeight: theme.type.leading.snug,
              // Wrap natural sentences — no clamp so long booking
              // types stay readable.
              wordBreak: 'break-word',
            }}
          >
            <HighlightedText
              text={row.patient_name}
              highlight={highlight}
              weight={theme.type.weight.semibold}
            />{' '}
            <span style={{ color: theme.color.inkMuted }}>{labels.verb}</span>{' '}
            <HighlightedText
              text={row.booking_type}
              highlight={highlight}
              weight={theme.type.weight.semibold}
            />
            {row.scheduled_at_label ? (
              <>
                {' '}
                <span style={{ color: theme.color.inkMuted }}>on</span>{' '}
                <HighlightedText
                  text={row.scheduled_at_label}
                  highlight={highlight}
                  weight={theme.type.weight.medium}
                />
                .
              </>
            ) : (
              '.'
            )}
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
                marginTop: theme.space[1],
              }}
            >
              View appointment <ArrowRight size={14} />
            </span>
          ) : null}
        </div>
      </article>
    </button>
  );
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
