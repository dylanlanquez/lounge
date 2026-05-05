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
  // Optional empty-slot handler. When provided, taps on empty calendar
  // space fire with an ISO datetime composed from the grid's `isoDate`
  // and the y-coordinate (snapped to the nearest 15 minutes). Children
  // sit on top of the empty-tap layer in the DOM, so taps that land on
  // an AppointmentCard hit its onClick instead of bubbling here.
  onEmptyTap?: (iso: string) => void;
}

const TIME_AXIS_WIDTH = 64;

export function CalendarGrid({
  startHour = 8,
  endHour = 19,
  pxPerHour = 80,
  children,
  showNowIndicator = true,
  isoDate,
  onEmptyTap,
}: CalendarGridProps) {
  const totalHours = endHour - startHour;
  const totalHeight = totalHours * pxPerHour;
  const hours = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i);

  const isToday = !isoDate || isoDate === todayIso();
  const now = useNowOffset(startHour, endHour, pxPerHour, isToday);

  const showNow = showNowIndicator && now !== null;

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
        {/* Now-time pill — lives on the time axis so it never overlaps cards. */}
        {showNow ? <NowPill offset={now!.offset} beforeStart={now!.beforeStart} /> : null}
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

        {/* Empty-slot tap layer. Sits below children in DOM order so
            absolute-positioned cards naturally take the click in their
            own bounds; taps on empty space fall through to here. */}
        {onEmptyTap ? (
          <button
            type="button"
            aria-label="Book a new appointment at this time"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const y = e.clientY - rect.top;
              const iso = isoForY(y, startHour, pxPerHour, totalHeight, isoDate);
              if (iso) onEmptyTap(iso);
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: totalHeight,
              border: 'none',
              padding: 0,
              margin: 0,
              background: 'transparent',
              cursor: 'pointer',
              // No outline ring — the cursor change is the affordance,
              // and a focus ring on the whole grid would be visually
              // overwhelming.
              WebkitTapHighlightColor: 'transparent',
            }}
          />
        ) : null}

        {/* Children (appointment cards) */}
        {children}

        {/* Now-line — full-width across slot column at low opacity. */}
        {showNow ? <NowLine offset={now!.offset} beforeStart={now!.beforeStart} /> : null}
      </div>
    </div>
  );
}

function NowLine({ offset, beforeStart }: { offset: number; beforeStart: boolean }) {
  // Extend 5px past both edges of the slot column. Left side meets the
  // right edge of the NowPill on the time axis; right side mirrors that
  // overhang so the line reads as a balanced horizontal stroke.
  // Before start: line lifts above the grid edge to stay aligned with
  // the pill's centre, so the indicator reads as a single unit.
  const top = beforeStart ? -22 : offset;
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: -5,
        right: -5,
        height: 1,
        background: theme.color.accent,
        opacity: 0.35,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  );
}

function NowPill({ offset, beforeStart }: { offset: number; beforeStart: boolean }) {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? 'am' : 'pm';
  const label = `${hh}:${String(m).padStart(2, '0')} ${ampm}`;

  // Anchor to the right edge of the time-axis column so the pill ends just
  // before the slot column starts — never overlaps appointment cards.
  // Default: vertically centred on the now-line. Before the first visible
  // hour, perch the pill above the top edge so it doesn't cover the
  // first hour label (which sits at top: -6). The line lifts to top: -22
  // alongside it so both stay vertically aligned as one unit.
  const top = beforeStart ? -32 : offset - 10;
  return (
    <div
      style={{
        position: 'absolute',
        top,
        right: 4,
        padding: '2px 8px',
        background: theme.color.accent,
        color: theme.color.surface,
        borderRadius: 999,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: theme.type.tracking.wide,
        boxShadow: theme.shadow.card,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </div>
  );
}

// Helpers

// 6px breathing room above and below each card so back-to-back
// appointments don't visually slam into the hour gridlines. The card
// represents the duration to scale; we just inset it inside the slot.
const CARD_TOP_GAP = 6;
const CARD_BOTTOM_GAP = 6;

export function offsetForTime(iso: string, startHour: number, pxPerHour: number): number {
  const d = new Date(iso);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const startMinutes = startHour * 60;
  return ((minutes - startMinutes) / 60) * pxPerHour + CARD_TOP_GAP;
}

export function heightForDuration(startIso: string, endIso: string, pxPerHour: number): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const hours = (end - start) / (1000 * 60 * 60);
  // Min 56px so a 30-min appointment in a half-width lane still fits the
  // patient name + time without clipping.
  return Math.max(56, hours * pxPerHour - CARD_TOP_GAP - CARD_BOTTOM_GAP);
}

// Threshold above which an overlap cluster collapses into a single
// ClusterCard. ≤ this number renders as side-by-side lanes.
//
// Why 2: at half-width on a tablet the patient name still reads clearly
// (~280px). At 1/3 width it cramps. Cluster cards scale to any count.
export const LANE_CAP = 2;

export type LayoutItem<T> =
  | { kind: 'card'; data: T; lane: number; lanesInGroup: number }
  | { kind: 'cluster'; rows: T[]; startAt: string; endAt: string; key: string };

// Lays out appointments for the calendar grid. Non-overlapping rows render as
// full-width cards. 2-overlap renders as side-by-side lanes. 3+ overlap
// collapses into a single cluster card spanning the union time range — the
// caller renders it with onClick → expand into a sheet.
//
// Algorithm: sort by start, walk forward grouping by overlap (running max
// end_at). For each cluster: if size ≤ LANE_CAP greedy-assign lanes; else
// emit one cluster item.
export function layoutAppointments<T extends { id: string; start_at: string; end_at: string }>(
  rows: T[]
): Array<LayoutItem<T>> {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) =>
    a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0
  );

  const out: Array<LayoutItem<T>> = [];
  let clusterStart = 0;
  let clusterEnd = sorted[0]!.end_at;

  const emitCluster = (endIdx: number) => {
    const cluster = sorted.slice(clusterStart, endIdx);
    if (cluster.length === 0) return;
    if (cluster.length <= LANE_CAP) {
      const laneEndsAt: string[] = [];
      const sized: Array<{ row: T; lane: number }> = [];
      for (const row of cluster) {
        let laneIdx = laneEndsAt.findIndex((endAt) => endAt <= row.start_at);
        if (laneIdx === -1) {
          laneIdx = laneEndsAt.length;
          laneEndsAt.push(row.end_at);
        } else {
          laneEndsAt[laneIdx] = row.end_at;
        }
        sized.push({ row, lane: laneIdx });
      }
      const lanesInGroup = laneEndsAt.length;
      for (const { row, lane } of sized) {
        out.push({ kind: 'card', data: row, lane, lanesInGroup });
      }
    } else {
      let earliest = cluster[0]!.start_at;
      let latest = cluster[0]!.end_at;
      for (const r of cluster) {
        if (r.start_at < earliest) earliest = r.start_at;
        if (r.end_at > latest) latest = r.end_at;
      }
      out.push({
        kind: 'cluster',
        rows: cluster,
        startAt: earliest,
        endAt: latest,
        key: `cluster-${cluster.map((r) => r.id).join('-')}`,
      });
    }
  };

  for (let i = 0; i < sorted.length; i++) {
    const appt = sorted[i]!;
    if (i === clusterStart || appt.start_at < clusterEnd) {
      if (appt.end_at > clusterEnd) clusterEnd = appt.end_at;
    } else {
      emitCluster(i);
      clusterStart = i;
      clusterEnd = appt.end_at;
    }
  }
  emitCluster(sorted.length);

  return out;
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

// Convert a y-coordinate (relative to the slot column) into a
// datetime ISO string snapped to the nearest 15 minutes. Used by
// the empty-slot tap handler. Returns null if the grid has no
// isoDate or the y is outside the visible range.
const SNAP_MINUTES = 15;
function isoForY(
  y: number,
  startHour: number,
  pxPerHour: number,
  totalHeight: number,
  isoDate?: string,
): string | null {
  if (!isoDate) return null;
  const clampedY = Math.max(0, Math.min(y, totalHeight - 1));
  const minutesFromStart = (clampedY / pxPerHour) * 60;
  const snapped = Math.round(minutesFromStart / SNAP_MINUTES) * SNAP_MINUTES;
  const totalMinutes = startHour * 60 + snapped;
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  // Local time on the grid's date. Composing as "YYYY-MM-DDTHH:MM:00"
  // lets the Date parser interpret it as local — same convention
  // used by the reschedule sheet's composeIso.
  const d = new Date(`${isoDate}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type NowState = { offset: number; beforeStart: boolean };

function useNowOffset(startHour: number, endHour: number, pxPerHour: number, isToday: boolean) {
  const [state, setState] = useState<NowState | null>(null);
  useEffect(() => {
    if (!isToday) {
      setState(null);
      return;
    }
    const update = () => {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = startHour * 60;
      const endMinutes = endHour * 60;
      // Past the last visible hour, drop the indicator entirely so it
      // doesn't dangle below the grid.
      if (minutes >= endMinutes) {
        setState(null);
        return;
      }
      const raw = ((minutes - startMinutes) / 60) * pxPerHour;
      // Before the first visible hour, clamp the line to the top edge.
      // The pill positions itself separately based on `beforeStart`.
      setState({ offset: Math.max(0, raw), beforeStart: raw < 0 });
    };
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, [startHour, endHour, pxPerHour, isToday]);
  return state;
}
