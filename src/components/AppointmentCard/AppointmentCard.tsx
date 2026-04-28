import { type CSSProperties } from 'react';
import { theme } from '../../theme/index.ts';
import type { StatusTone } from '../StatusPill/StatusPill.tsx';

export interface AppointmentCardProps {
  patientName: string;
  startAt: string; // ISO
  endAt: string;
  staffName?: string;
  status?: AppointmentStatus;
  serviceLabel?: string;
  // Layout — provided by the parent CalendarGrid:
  top: number;
  height: number;
  // Overlap layout. Default lane=0, lanesInGroup=1 = full-width.
  // Compute via assignAppointmentLanes() before rendering.
  lane?: number;
  lanesInGroup?: number;
  // Optional event-type accent for the left bar. Only applies when
  // status='booked' — once the patient arrives the status color takes over.
  barColor?: string;
  onClick?: () => void;
}

export type AppointmentStatus =
  | 'booked'
  | 'arrived'
  | 'in_progress'
  | 'complete'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';

const STATUS_TO_TONE: Record<AppointmentStatus, StatusTone> = {
  booked: 'neutral',
  arrived: 'arrived',
  in_progress: 'in_progress',
  complete: 'complete',
  no_show: 'no_show',
  cancelled: 'cancelled',
  rescheduled: 'cancelled',
};

const BAR_COLOR: Record<AppointmentStatus, string> = {
  booked: theme.color.ink,
  arrived: theme.color.accent,
  in_progress: theme.color.accent,
  complete: theme.color.inkSubtle,
  no_show: theme.color.alert,
  cancelled: theme.color.inkSubtle,
  rescheduled: theme.color.inkSubtle,
};

const FILL_COLOR: Record<AppointmentStatus, string> = {
  booked: theme.color.surface,
  arrived: theme.color.accentBg,
  in_progress: theme.color.surface,
  complete: theme.color.surface,
  no_show: theme.color.surface,
  cancelled: theme.color.surface,
  rescheduled: theme.color.surface,
};

export function AppointmentCard({
  patientName,
  startAt,
  endAt,
  staffName,
  status = 'booked',
  serviceLabel,
  top,
  height,
  lane = 0,
  lanesInGroup = 1,
  barColor,
  onClick,
}: AppointmentCardProps) {
  const isInteractive = Boolean(onClick);
  const lanePct = 100 / lanesInGroup;
  // Sit above the now-indicator line; below the now-time pill.
  const styles: CSSProperties = {
    position: 'absolute',
    top,
    left: `calc(${lane * lanePct}% + 2px)`,
    width: `calc(${lanePct}% - 4px)`,
    height,
    background: FILL_COLOR[status],
    borderRadius: 12,
    boxShadow: theme.shadow.card,
    overflow: 'hidden',
    display: 'flex',
    cursor: isInteractive ? 'pointer' : 'default',
    transition: `box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}`,
    textDecoration: status === 'cancelled' ? 'line-through' : 'none',
    zIndex: 1,
  };
  const effectiveBarColor = status === 'booked' && barColor ? barColor : BAR_COLOR[status];

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
      aria-label={`${patientName}, ${formatTimeRange(startAt, endAt)}${staffName ? `, with ${staffName}` : ''}`}
    >
      <div
        style={{
          width: 4,
          background: effectiveBarColor,
          flexShrink: 0,
        }}
        aria-hidden
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${theme.space[2]}px ${theme.space[3]}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          color: status === 'complete' || status === 'cancelled' ? theme.color.inkMuted : theme.color.ink,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: theme.type.leading.snug,
          }}
        >
          {patientName}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: theme.type.leading.snug,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTime(startAt)}
          {serviceLabel ? ` · ${serviceLabel}` : staffName ? ` · ${staffName}` : ''}
        </p>
      </div>
    </div>
  );
}

function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)} to ${formatTime(endIso)}`;
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

// Re-export the tone mapping so other surfaces can show consistent badges.
export { STATUS_TO_TONE };
