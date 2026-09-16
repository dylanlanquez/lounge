import { PhoneCall } from 'lucide-react';
import { Card, Skeleton } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { useVoiceCallLog } from '../../lib/queries/voiceCallLog.ts';
import { OutcomeBadge } from '../CallOutcomeSheet/OutcomeBadge.tsx';
import { formatRelativeShort } from '../../lib/queries/notifications.ts';

// The call record — the bottom-of-page log Dylan asked for, built to
// read like a call centre's disposition history: every attempt this
// booking has had, outcome first, note underneath, who and when.
// Usually one row (a call is logged once), but supports more — a
// reversed and re-logged call keeps its earlier attempt on the
// record rather than erasing it.
export function CallRecordCard({ appointmentId }: { appointmentId: string }) {
  const { data, loading, error } = useVoiceCallLog(appointmentId);

  return (
    <Card padding="lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginBottom: theme.space[4] }}>
        <span
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: theme.radius.pill,
            background: `${theme.category.voiceCall}1F`,
            color: theme.category.voiceCall,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <PhoneCall size={15} aria-hidden />
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          Call record
        </h3>
      </div>

      {loading ? (
        <Skeleton height={18} radius={theme.radius.input} />
      ) : error ? (
        <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>
          Couldn't load the call record: {error}
        </p>
      ) : data.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
            padding: `${theme.space[3]}px ${theme.space[4]}px`,
            borderRadius: theme.radius.input,
            border: `1px dashed ${theme.color.border}`,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
          }}
        >
          <PhoneCall size={16} color={theme.color.inkSubtle} aria-hidden />
          No call logged yet. Once you log this call, the outcome and any note land here.
        </div>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {data.map((entry, i) => (
            <li
              key={entry.id}
              style={{
                position: 'relative',
                paddingLeft: theme.space[5],
                borderLeft: i === 0 ? `2px solid ${theme.category.voiceCall}` : `2px solid ${theme.color.border}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -5,
                  top: 4,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: i === 0 ? theme.category.voiceCall : theme.color.border,
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
                <OutcomeBadge outcome={entry.outcome} />
                <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                  {formatRelativeShort(entry.created_at)}
                  {entry.author_name ? ` · ${entry.author_name}` : ''}
                </span>
              </div>
              {entry.note ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    fontSize: theme.type.size.sm,
                    color: theme.color.ink,
                    lineHeight: theme.type.leading.relaxed,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {entry.note}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
