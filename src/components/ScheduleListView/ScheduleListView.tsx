import { ChevronRight } from 'lucide-react';
import { StatusPill } from '../StatusPill/StatusPill.tsx';
import { theme } from '../../theme/index.ts';
import {
  type AppointmentRow,
  patientDisplayName,
  staffDisplayName,
} from '../../lib/queries/appointments.ts';

export interface ScheduleListViewProps {
  rows: AppointmentRow[];
  onPick: (row: AppointmentRow) => void;
}

export function ScheduleListView({ rows, onPick }: ScheduleListViewProps) {
  const sorted = [...rows].sort((a, b) =>
    a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0
  );
  const morning = sorted.filter((r) => new Date(r.start_at).getHours() < 12);
  const afternoon = sorted.filter((r) => new Date(r.start_at).getHours() >= 12);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {morning.length > 0 ? <Section label="Morning" rows={morning} onPick={onPick} /> : null}
      {afternoon.length > 0 ? <Section label="Afternoon" rows={afternoon} onPick={onPick} /> : null}
    </div>
  );
}

function Section({ label, rows, onPick }: { label: string; rows: AppointmentRow[]; onPick: (r: AppointmentRow) => void }) {
  return (
    <div>
      <p
        style={{
          margin: `0 0 ${theme.space[2]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          fontWeight: theme.type.weight.medium,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {label}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        {rows.map((r) => (
          <ListRow key={r.id} row={r} onPick={() => onPick(r)} />
        ))}
      </ul>
    </div>
  );
}

function ListRow({ row, onPick }: { row: AppointmentRow; onPick: () => void }) {
  const tone = statusToTone(row.status);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        style={{
          appearance: 'none',
          width: '100%',
          textAlign: 'left',
          padding: theme.space[4],
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: 14,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[4],
          minHeight: 64,
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = theme.color.accent;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = theme.color.border;
        }}
      >
        <div style={{ width: 80, flexShrink: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              fontVariantNumeric: 'tabular-nums',
              color: theme.color.ink,
            }}
          >
            {formatTime(row.start_at)}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {durationLabel(row.start_at, row.end_at)}
          </p>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {patientDisplayName(row)}
          </p>
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {[row.event_type_label, staffDisplayName(row)].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <StatusPill tone={tone} size="sm">
          {row.status.replace(/_/g, ' ')}
        </StatusPill>
        <ChevronRight size={18} color={theme.color.inkSubtle} aria-hidden />
      </button>
    </li>
  );
}

function statusToTone(s: AppointmentRow['status']) {
  switch (s) {
    case 'arrived':
    case 'in_progress':
      return 'arrived' as const;
    case 'complete':
      return 'complete' as const;
    case 'no_show':
    case 'cancelled':
      return 'no_show' as const;
    case 'rescheduled':
      return 'cancelled' as const;
    default:
      return 'neutral' as const;
  }
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

function durationLabel(startIso: string, endIso: string): string {
  const minutes = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
