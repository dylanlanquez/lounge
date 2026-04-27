import { type ReactNode, useEffect, useState } from 'react';
import { theme } from '../../theme/index.ts';

export interface CalendarGridProps {
  // First hour shown (24h, e.g. 8 = 08:00)
  startHour?: number;
  // Last hour shown, exclusive (e.g. 19 = grid ends at 19:00)
  endHour?: number;
  // Pixels per hour. Default 80 per brief §9.4.5.
  pxPerHour?: number;
  // Children are absolutely-positioned <AppointmentCard> elements (or anything),
  // pinned via top/height by their start_at/end_at.
  children?: ReactNode;
  // Show now-indicator if today's date falls in the visible range
  showNowIndicator?: boolean;
  // 'YYYY-MM-DD' — date the grid represents. Now-indicator only shows for today.
  isoDate?: string;
}

const TIME_AXIS_WIDTH = 64;

export function CalendarGrid({
  startHour = 8,
  endHour = 19,
  pxPerHour = 80,
  children,
  showNowIndicator = true,
  isoDate,
}: CalendarGridProps) {
  const totalHours = endHour - startHour;
  const totalHeight = totalHours * pxPerHour;
  const hours = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i);

  const isToday = !isoDate || isoDate === todayIso();
  const nowOffset = useNowOffset(startHour, pxPerHour, isToday);

  return (
    <div style={{ position: 'relative', display: 'flex', width: '100%' }}>
      {/* Time axis */}
      <div style={{ width: TIME_AXIS_WIDTH, flexShrink: 0, position: 'relative', height: totalHeight }}>
        {hours.map((h, i) => (
          <div
            key={h}
            style={{
              position: 'absolute',
              top: i * pxPerHour - 6,
              right: theme.space[3],
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
              fontWeight: theme.type.weight.medium,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatHour(h)}
          </div>
        ))}
      </div>

      {/* Slots column */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          height: totalHeight,
          borderLeft: `1px solid ${theme.color.border}`,
        }}
      >
        {/* Hour grid lines */}
        {hours.map((h, i) => (
          <div
            key={h}
            style={{
              position: 'absolute',
              top: i * pxPerHour,
              left: 0,
              right: 0,
              borderTop: `1px solid ${theme.color.border}`,
              opacity: i === 0 || i === totalHours ? 0 : 1,
            }}
          />
        ))}

        {/* Half-hour grid lines (subtle) */}
        {hours.slice(0, -1).map((h, i) => (
          <div
            key={`half-${h}`}
            style={{
              position: 'absolute',
              top: i * pxPerHour + pxPerHour / 2,
              left: 0,
              right: 0,
              borderTop: `1px dashed ${theme.color.border}`,
              opacity: 0.5,
            }}
          />
        ))}

        {/* Children (appointment cards) */}
        {children}

        {/* Now-indicator */}
        {showNowIndicator && nowOffset !== null ? (
          <NowIndicator offset={nowOffset} />
        ) : null}
      </div>
    </div>
  );
}

function NowIndicator({ offset }: { offset: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: offset,
        left: -4,
        right: 0,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: theme.color.accent,
          }}
        />
        <div style={{ flex: 1, height: 2, background: theme.color.accent }} />
      </div>
    </div>
  );
}

// Helpers

export function offsetForTime(iso: string, startHour: number, pxPerHour: number): number {
  const d = new Date(iso);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const startMinutes = startHour * 60;
  return ((minutes - startMinutes) / 60) * pxPerHour;
}

export function heightForDuration(startIso: string, endIso: string, pxPerHour: number): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const hours = (end - start) / (1000 * 60 * 60);
  return Math.max(28, hours * pxPerHour);
}

function formatHour(h: number): string {
  if (h === 0) return '12 am';
  if (h === 12) return 'noon';
  if (h < 12) return `${h} am`;
  return `${h - 12} pm`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function useNowOffset(startHour: number, pxPerHour: number, isToday: boolean) {
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    if (!isToday) {
      setOffset(null);
      return;
    }
    const update = () => {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = startHour * 60;
      const off = ((minutes - startMinutes) / 60) * pxPerHour;
      setOffset(off);
    };
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, [startHour, pxPerHour, isToday]);
  return offset;
}
