import { type CSSProperties } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface ClusterCardProps {
  count: number;
  startAt: string;
  endAt: string;
  // Up to ~3 first names to surface in the card. The rest get rolled into
  // a "+N" suffix.
  firstNames: string[];
  // Layout — provided by the parent CalendarGrid:
  top: number;
  height: number;
  onClick?: () => void;
}

export function ClusterCard({
  count,
  startAt,
  endAt,
  firstNames,
  top,
  height,
  onClick,
}: ClusterCardProps) {
  const isInteractive = Boolean(onClick);
  const visible = firstNames.slice(0, 3);
  const overflow = count - visible.length;
  const namesText = visible.join(', ') + (overflow > 0 ? `, +${overflow}` : '');

  const styles: CSSProperties = {
    position: 'absolute',
    top,
    left: 2,
    width: 'calc(100% - 4px)',
    height,
    background: theme.color.accentBg,
    borderRadius: 12,
    border: `1px solid ${theme.color.accent}`,
    boxShadow: theme.shadow.card,
    overflow: 'hidden',
    display: 'flex',
    cursor: isInteractive ? 'pointer' : 'default',
    transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
  };

  return (
    <div
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={styles}
      aria-label={`${count} appointments from ${formatTime(startAt)} to ${formatTime(endAt)}, expand to see all`}
    >
      <div
        style={{
          width: 4,
          background: theme.color.accent,
          flexShrink: 0,
        }}
        aria-hidden
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          color: theme.color.ink,
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: theme.radius.pill,
            background: theme.color.accent,
            color: theme.color.surface,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          aria-hidden
        >
          <Users size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              lineHeight: theme.type.leading.snug,
              color: theme.color.ink,
            }}
          >
            {count} appointments
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatTime(startAt)} to {formatTime(endAt)} · {namesText}
          </p>
        </div>
        <ChevronRight size={18} color={theme.color.accent} aria-hidden />
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${hh}${mm}${ampm}`;
}
