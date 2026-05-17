import { Hourglass, Pencil, Plus, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../../theme/index.ts';

// PhaseRibbon — horizontal proportional ribbon showing the phases
// of a booking type. Active phases (patient_required=true) render
// as a solid accent block; passive phases (patient_required=false)
// render in the same accent at lower opacity with a diagonal-hatch
// pattern overlay so the operator can immediately tell "patient is
// here" from "patient may leave" by glance.
//
// The ribbon is the primary "I get the booking shape" surface for
// the booking-types admin tab. ADR-006 / slice docs/booking-phases.md.
//
// Three sums are surfaced above the ribbon:
//   Operational   — sum of all phase durations (the calendar block).
//   Patient in    — sum of active-phase durations (the time the
//                   patient is physically here).
//   Telling patient — what the confirmation says. Defaults to
//                     operational; can be overridden per-config.
//
// When a phase is too short to fit its label inside the chip, the
// chip just shows the duration; tap/hover reveals the label via
// the Tooltip wrapper that consumers attach.

export interface PhaseRibbonPhase {
  // Stable key for React. Use the DB id when editing, or
  // `${phase_index}` for read-only previews.
  key: string;
  phase_index: number;
  label: string;
  patient_required: boolean;
  // Duration shown on the chip and used to size it proportionally.
  duration_minutes: number;
  // Optional pool ids to show as a small subscript chip-set.
  pool_ids?: string[];
}

export interface PhaseRibbonProps {
  phases: PhaseRibbonPhase[];
  // Operational and patient-facing totals. The component does NOT
  // sum these itself — the caller knows whether a child override
  // changes them and is the source of truth. Pass null for the
  // patient-facing min to hide the chip entirely. Set max to surface
  // a range ("30 to 45 min" / "1 to 2 hours") rather than a fixed
  // value.
  operational_minutes: number;
  patient_in_minutes: number;
  patient_facing_min_minutes: number | null;
  patient_facing_max_minutes: number | null;
  // Optional per-phase tap handler — opens the editor in the admin.
  // When omitted, chips are not interactive.
  onPhaseClick?: (key: string) => void;
  // Optional "+ Add phase" handler — appends a chip at the end with
  // a plus icon; tap fires this. Omit for read-only ribbons.
  onAddPhase?: () => void;
  // Optional handler for tapping the "Telling patient" summary chip.
  // When provided, the chip renders with a pencil affordance and is
  // a button. When omitted the chip stays plain text.
  onEditPatientFacing?: () => void;
  // Optional drag-and-drop reorder handler. Receives the new order
  // as an array of phase keys (matching `phases[].key`). Caller is
  // responsible for persisting the new sequence. When omitted, the
  // chips are not draggable. Wiring this on enables pointer/touch
  // reorder of the ribbon — long-ish press + drag a chip onto its
  // new slot; surrounding chips animate aside.
  onReorder?: (orderedKeys: string[]) => void;
  // Compact mode shrinks chips and hides the summary line. Used when
  // the ribbon needs to fit inside a tight admin row.
  compact?: boolean;
}

export function PhaseRibbon({
  phases,
  operational_minutes,
  patient_in_minutes,
  patient_facing_min_minutes,
  patient_facing_max_minutes,
  onPhaseClick,
  onAddPhase,
  onEditPatientFacing,
  onReorder,
  compact = false,
}: PhaseRibbonProps) {
  const totalMin = phases.reduce((acc, p) => acc + Math.max(p.duration_minutes, 1), 0);
  const drag = usePhaseDrag(phases, onReorder);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? theme.space[1] : theme.space[2],
      }}
    >
      {!compact && (
        <SummaryLine
          operational={operational_minutes}
          patient_in={patient_in_minutes}
          patient_facing_min={patient_facing_min_minutes}
          patient_facing_max={patient_facing_max_minutes}
          onEditPatientFacing={onEditPatientFacing}
        />
      )}

      <div
        ref={drag.containerRef}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          minHeight: compact ? 32 : 44,
          background: 'rgba(14,20,20,0.04)',
          borderRadius: theme.radius.input,
          padding: 2,
          // Defensive: if a service has many short phases or the
          // container is narrower than the sum of chip min-widths,
          // let the ribbon scroll horizontally instead of forcing
          // every chip to compress past readability.
          // While dragging, hide overflow so the lifted chip can
          // float above the ribbon without being clipped.
          overflowX: drag.isDragging ? 'visible' : 'auto',
          flexWrap: 'nowrap',
          position: 'relative',
          // Prevent the browser from interpreting horizontal touch
          // drags on the chip as page scroll — the drag handler
          // owns those gestures.
          touchAction: onReorder ? 'pan-y' : undefined,
        }}
        role="group"
        aria-label="Booking phase ribbon"
      >
        {phases.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: theme.space[2],
              color: theme.color.inkMuted,
              fontSize: theme.type.size.sm,
            }}
          >
            No phases yet. Add the first one to define the booking shape.
          </div>
        )}

        {phases.map((p, i) => (
          <PhaseChip
            key={p.key}
            phase={p}
            // grow proportional to its share of the total
            flexBasis={`${(Math.max(p.duration_minutes, 1) / totalMin) * 100}%`}
            compact={compact}
            onClick={onPhaseClick ? () => onPhaseClick(p.key) : undefined}
            draggable={!!onReorder}
            isDragging={drag.draggingKey === p.key}
            translateX={drag.translates[i] ?? 0}
            floatOffset={drag.draggingKey === p.key ? drag.floatOffset : null}
            onPointerDown={
              onReorder
                ? (e, rect) => drag.start(p.key, i, e, rect)
                : undefined
            }
          />
        ))}

        {onAddPhase && (
          <button
            type="button"
            onClick={onAddPhase}
            aria-label="Add phase"
            style={{
              border: 'none',
              background: 'transparent',
              padding: `0 ${theme.space[3]}px`,
              borderRadius: theme.radius.input - 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.space[1],
              color: theme.color.inkMuted,
              cursor: 'pointer',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.medium,
              minWidth: 64,
            }}
          >
            <Plus size={16} strokeWidth={2.25} />
            <span>{compact ? '' : 'Add'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Drag-and-drop hook
// ─────────────────────────────────────────────────────────────────
//
// Pointer-based reorder so the same code path covers mouse, touch,
// and pen on iPad. Lifts the grabbed chip via translate (still in
// the layout — keeps width stable for proportional sizing), shifts
// neighbouring chips aside via translateX so the operator can see
// where the chip will land, and commits via onReorder on pointerup.
//
// State is intentionally kept tiny: only the index the chip would
// CURRENTLY land at is tracked. Width-based math reads chip rects
// once per drag start so subsequent moves are cheap (no DOM measure
// on every pointermove).
//
// Cancellation: pointercancel + Escape both abort the drag and
// restore positions without firing onReorder.

interface PhaseDragApi {
  containerRef: React.RefObject<HTMLDivElement | null>;
  draggingKey: string | null;
  /** Translate offset for the floating drag clone, relative to its
   *  resting position inside the flex row. null when not dragging. */
  floatOffset: { x: number; y: number } | null;
  /** Per-index translateX values that animate non-dragged chips
   *  aside to reveal the drop slot. */
  translates: number[];
  isDragging: boolean;
  start: (
    key: string,
    index: number,
    e: React.PointerEvent<HTMLButtonElement>,
    rect: DOMRect,
  ) => void;
}

function usePhaseDrag(
  phases: PhaseRibbonPhase[],
  onReorder: ((orderedKeys: string[]) => void) | undefined,
): PhaseDragApi {
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [floatOffset, setFloatOffset] = useState<{ x: number; y: number } | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);

  // Snapshot of chip layout at drag start — left edge + width for
  // each phase, in container-relative coordinates. Reading these
  // once avoids getBoundingClientRect() per pointermove (which
  // forces layout on every move).
  const layoutRef = useRef<{
    sourceIndex: number;
    startX: number;
    startY: number;
    sourceLeft: number;
    sourceWidth: number;
    centers: number[]; // each chip's centre X, container-relative
  } | null>(null);

  const cancel = useCallback(() => {
    setDraggingKey(null);
    setFloatOffset(null);
    setTargetIndex(null);
    layoutRef.current = null;
  }, []);

  const start = useCallback(
    (
      key: string,
      index: number,
      e: React.PointerEvent<HTMLButtonElement>,
      rect: DOMRect,
    ) => {
      if (!onReorder) return;
      // Only left mouse button / primary pointer.
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();

      // Snapshot every chip's centre and the source chip's bounds in
      // container-relative coords. Read once per drag.
      const chips = Array.from(
        container.querySelectorAll<HTMLElement>('[data-phase-chip]'),
      );
      const centers = chips.map((c) => {
        const r = c.getBoundingClientRect();
        return r.left + r.width / 2 - containerRect.left;
      });

      layoutRef.current = {
        sourceIndex: index,
        startX: e.clientX,
        startY: e.clientY,
        sourceLeft: rect.left - containerRect.left,
        sourceWidth: rect.width,
        centers,
      };

      setDraggingKey(key);
      setFloatOffset({ x: 0, y: 0 });
      setTargetIndex(index);

      // Don't preventDefault inside React's onPointerDown — that can
      // swallow click events on neighbouring controls if the user
      // doesn't actually drag.
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [onReorder],
  );

  // Document-level move / up handlers. Wired only while dragging so
  // we're not paying for them on every render.
  useEffect(() => {
    if (!draggingKey || !layoutRef.current) return;

    const onMove = (e: PointerEvent) => {
      const lay = layoutRef.current;
      if (!lay) return;
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();

      const dx = e.clientX - lay.startX;
      const dy = e.clientY - lay.startY;
      setFloatOffset({ x: dx, y: dy });

      // Find the target slot — the index whose centre is nearest to
      // the dragged chip's centre (sourceLeft + width/2 + dx).
      const draggedCentre =
        lay.sourceLeft + lay.sourceWidth / 2 + (e.clientX - lay.startX);
      let nearest = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < lay.centers.length; i++) {
        const d = Math.abs(lay.centers[i]! - draggedCentre);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = i;
        }
      }
      // Clamp so the operator can't drop outside the container.
      if (e.clientX < containerRect.left) nearest = 0;
      else if (e.clientX > containerRect.right) nearest = lay.centers.length - 1;
      setTargetIndex(nearest);
    };

    const onUp = () => {
      const lay = layoutRef.current;
      if (!lay) {
        cancel();
        return;
      }
      const from = lay.sourceIndex;
      const to = targetIndex ?? from;
      if (from !== to && onReorder) {
        const next = [...phases];
        const [moved] = next.splice(from, 1);
        if (moved) next.splice(to, 0, moved);
        onReorder(next.map((p) => p.key));
      }
      cancel();
    };

    const onCancel = () => cancel();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey);
    };
  }, [draggingKey, cancel, onReorder, phases, targetIndex]);

  // Per-index translateX values for the non-dragged chips so the
  // operator sees the drop slot open up. When a chip would land at
  // a slot AFTER its origin, every chip between origin+1 and target
  // shifts LEFT by approximately a chip's width. When the chip
  // would land BEFORE its origin, every chip between target and
  // origin-1 shifts RIGHT.
  const translates = phases.map((_, i) => {
    const lay = layoutRef.current;
    if (!lay || targetIndex == null || draggingKey == null) return 0;
    const from = lay.sourceIndex;
    const to = targetIndex;
    if (i === from) return 0; // source chip stays put (its own translate is floatOffset)
    if (from < to && i > from && i <= to) return -lay.sourceWidth;
    if (from > to && i < from && i >= to) return lay.sourceWidth;
    return 0;
  });

  return {
    containerRef,
    draggingKey,
    floatOffset,
    translates,
    isDragging: draggingKey !== null,
    start,
  };
}

// One chip in the ribbon. Solid for active, hatched for passive.
function PhaseChip({
  phase,
  flexBasis,
  compact,
  onClick,
  draggable = false,
  isDragging = false,
  translateX = 0,
  floatOffset,
  onPointerDown,
}: {
  phase: PhaseRibbonPhase;
  flexBasis: string;
  compact: boolean;
  onClick?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  translateX?: number;
  floatOffset?: { x: number; y: number } | null;
  onPointerDown?: (
    e: React.PointerEvent<HTMLButtonElement>,
    rect: DOMRect,
  ) => void;
}) {
  const passive = !phase.patient_required;
  const Icon = phase.patient_required ? UserRound : Hourglass;

  const interactive = !!onClick;
  // Track the pointer-down position so we can distinguish a click
  // (pointer barely moved) from a drag (pointer moved past 4px).
  // Without this every chip drag would also fire onClick on release.
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  // Resolve final transform — the source chip translates by the
  // pointer delta (floatOffset); neighbours translate by translateX
  // to open the drop slot. Slight scale + shadow on the lifted chip
  // distinguishes it visually from the others.
  const sourceTransform = isDragging && floatOffset
    ? `translate(${floatOffset.x}px, ${floatOffset.y}px) scale(1.04)`
    : translateX !== 0
      ? `translateX(${translateX}px)`
      : undefined;

  return (
    <button
      type="button"
      data-phase-chip
      onClick={(e) => {
        if (!interactive) return;
        // Suppress the click that would otherwise follow a drag —
        // a real click moves the pointer < ~4px between down and up.
        const down = downPosRef.current;
        if (down) {
          const dx = e.clientX - down.x;
          const dy = e.clientY - down.y;
          if (Math.hypot(dx, dy) > 4) return;
        }
        onClick?.();
      }}
      disabled={!interactive && !draggable}
      aria-label={`${phase.label}, ${phase.duration_minutes} minutes, ${
        phase.patient_required ? 'patient required' : 'patient may leave'
      }`}
      style={{
        flex: `1 1 ${flexBasis}`,
        // Min-width floor so short phases stay readable even when
        // proportional sizing would otherwise crush them. Click-in
        // Veneers' 30m / 4h / 10m split was previously dropping the
        // 10-min "Try In" chip down to ~50px wide and truncating
        // the label to a single letter. 96px in full mode fits any
        // reasonable label + duration with breathing room; 48px in
        // compact mode (no label, just duration) is enough.
        minWidth: compact ? 48 : 96,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: compact ? `0 ${theme.space[2]}px` : `${theme.space[1]}px ${theme.space[2]}px`,
        borderRadius: theme.radius.input - 4,
        border: 'none',
        cursor: isDragging
          ? 'grabbing'
          : draggable
            ? 'grab'
            : interactive
              ? 'pointer'
              : 'default',
        // Solid accent for active; pale accent fill for passive.
        // Same colour family signals "still part of this booking";
        // lower saturation signals "patient not here right now".
        // No diagonal hatch — that pattern reads as "pending /
        // warning state" rather than "wait time".
        backgroundColor: passive ? theme.color.accentBg : theme.color.accent,
        // Text colour flips for legibility on the pale background.
        color: passive ? theme.color.accent : '#FFFFFF',
        textAlign: 'center',
        gap: 2,
        // Snappier spring while idle, but skip the transition on the
        // dragged chip so it tracks the pointer 1:1 without latency.
        transition: isDragging
          ? 'none'
          : `transform ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        outline: 'none',
        transform: sourceTransform,
        zIndex: isDragging ? 10 : undefined,
        boxShadow: isDragging
          ? '0 8px 24px rgba(14,20,20,0.18), 0 2px 6px rgba(14,20,20,0.12)'
          : undefined,
        opacity: isDragging ? 0.96 : undefined,
        // Stop touch scroll while initiating a drag so the iPad
        // doesn't try to pan the page mid-grab.
        touchAction: draggable ? 'none' : undefined,
        userSelect: 'none',
      }}
      onPointerDown={(e) => {
        downPosRef.current = { x: e.clientX, y: e.clientY };
        if (draggable && onPointerDown) {
          onPointerDown(e, e.currentTarget.getBoundingClientRect());
        }
      }}
      onMouseDown={(e) => {
        if (!interactive || isDragging) return;
        (e.currentTarget as HTMLButtonElement).dataset.pressed = '1';
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).dataset.pressed = '';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).dataset.pressed = '';
      }}
    >
      {!compact && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.medium,
            opacity: 0.95,
            maxWidth: '100%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <Icon size={12} strokeWidth={2.25} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{phase.label}</span>
        </div>
      )}
      <div
        style={{
          fontSize: compact ? theme.type.size.xs : theme.type.size.sm,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: 0.2,
        }}
      >
        {formatMinutes(phase.duration_minutes)}
      </div>
    </button>
  );
}

function SummaryLine({
  operational,
  patient_in,
  patient_facing_min,
  patient_facing_max,
  onEditPatientFacing,
}: {
  operational: number;
  patient_in: number;
  patient_facing_min: number | null;
  patient_facing_max: number | null;
  onEditPatientFacing?: () => void;
}) {
  const facingLabel = formatPatientFacing(patient_facing_min, patient_facing_max);
  // "Attention" tone fires when the patient-facing line meaningfully
  // diverges from the operational total. Range counts as divergent
  // (it's never equal to a single operational number); fixed values
  // count when min differs from operational.
  const isRange =
    patient_facing_max !== null &&
    patient_facing_min !== null &&
    patient_facing_max > patient_facing_min;
  const fixedDiverges =
    patient_facing_min !== null &&
    !isRange &&
    patient_facing_min !== operational;
  const tone = isRange || fixedDiverges ? 'attention' : 'default';

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: theme.space[3],
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
      }}
    >
      <SummaryItem label="Operational" value={formatMinutes(operational)} />
      <SummaryItem label="Patient in" value={formatMinutes(patient_in)} />
      {facingLabel && (
        <SummaryItem
          label="Telling patient"
          value={facingLabel}
          tone={tone}
          onClick={onEditPatientFacing}
        />
      )}
    </div>
  );
}

// Compact format for the ribbon summary. Single value or range,
// short-form ("30 min" / "1 h 30") to match the operational and
// patient-in pills next to it. Empty when min isn't set.
function formatPatientFacing(
  min: number | null,
  max: number | null,
): string {
  if (!min || min <= 0) return '';
  if (!max || max <= min) return formatMinutes(min);
  return `${formatMinutes(min)} to ${formatMinutes(max)}`;
}

function SummaryItem({
  label,
  value,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'attention';
  onClick?: () => void;
}) {
  const valueStyle = {
    fontWeight: theme.type.weight.semibold,
    color: tone === 'attention' ? theme.color.alert : theme.color.ink,
  } as const;

  if (!onClick) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: theme.space[1] }}>
        <span>{label}</span>
        <span style={valueStyle}>{value}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit ${label.toLowerCase()}`}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        padding: `${theme.space[1]}px ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        cursor: 'pointer',
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <span style={valueStyle}>{value}</span>
      <Pencil size={11} strokeWidth={2.25} aria-hidden style={{ color: theme.color.inkMuted }} />
    </button>
  );
}

// Format minutes as a compact human string. 35 → "35 min";
// 240 → "4 h"; 270 → "4 h 30"; 60 → "1 h". Used by the ribbon and
// summary line.
function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (m === 0) return `${h} h`;
  return `${h} h ${m}`;
}
