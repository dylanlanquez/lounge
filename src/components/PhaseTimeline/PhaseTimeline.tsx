import { Fragment, type ReactNode } from 'react';
import { Flag, Hourglass, UserRound } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { fmtTzAbbr, formatTime, formatTimeNoZone } from '../../lib/dateFormat.ts';
import type { AppointmentPhaseSummary } from '../../lib/queries/appointments.ts';

// PhaseTimeline — vertical timeline of the materialised phases for
// one appointment. Sourced from lng_appointment_phases (snapshotted
// from the booking type's phases at booking time) so the timeline
// reflects what the patient was actually told, even after the admin
// edits the booking type later.
//
// Visual language inherits PhaseRibbon's two-tone semantic:
//   • Active phase (patient_required = true)
//       — solid accent dot
//       — UserRound icon
//       — solid accent connector line beneath
//       — "You're with us" subtle annotation
//   • Passive phase (patient_required = false)
//       — hollow accent dot
//       — Hourglass icon
//       — dotted accent connector line beneath
//       — "You can leave, we'll text when ready" subtle annotation
//
// Linear / Stripe-quality vertical timeline: time column on the left
// (tabular-nums for vertical alignment), a 14px rail in the middle
// with dots + connector segments, content on the right. The rail
// terminates on the final phase (no trailing line below the last
// dot) so the timeline reads as bounded rather than open-ended.
//
// Empty state: callers that load this with phases.length === 0
// should NOT render the component — the AppointmentDetail / VisitDetail
// hero falls back to the legacy single-block "Booked for HH:MM — HH:MM"
// line in that case (legacy rows pre-dating the materialisation
// trigger). The component renders an explicit fallback paragraph
// anyway so it's safe to mount, but the cleaner behaviour is to
// gate on the array length upstream.

export interface PhaseTimelineProps {
  phases: ReadonlyArray<AppointmentPhaseSummary>;
}

export function PhaseTimeline({ phases }: PhaseTimelineProps) {
  if (phases.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          color: theme.color.inkMuted,
          fontSize: theme.type.size.sm,
          lineHeight: theme.type.leading.snug,
        }}
      >
        This appointment doesn't have a phase breakdown on file. We'll
        walk you through it when you arrive.
      </p>
    );
  }

  // The estimated finish is rendered as a separate trailing event
  // below the last phase rather than as a tilde-prefix on the last
  // phase's time column. Reads as "the visit ends here" with its
  // own dot + label, which staff said was easier to scan than a
  // small sub-label under the time.
  const finishAt = phases[phases.length - 1]?.end_at ?? null;

  return (
    <ol
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
      aria-label="Estimated appointment timeline"
    >
      {phases.map((phase) => (
        // The last phase is no longer "the end of the timeline" — the
        // EstimatedFinishRow below is. Render a connector under every
        // phase row, including the last one, so the rail flows
        // continuously down to the finish dot.
        <Fragment key={phase.phase_index}>
          <PhaseRow phase={phase} isLast={false} />
        </Fragment>
      ))}
      {finishAt ? <EstimatedFinishRow finishAt={finishAt} /> : null}
    </ol>
  );
}

// Trailing event marking the appointment's estimated end. Same grid
// shape as PhaseRow so it lines up with the rail above, but with a
// hollow dot, no connector below, and a muted label so it doesn't
// compete with the actual phases.
function EstimatedFinishRow({ finishAt }: { finishAt: string }) {
  const finishStr = formatTime(finishAt);
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: '64px 14px 1fr',
        gap: theme.space[4],
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          paddingTop: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.2,
          }}
          aria-label={`Estimated finish ${finishStr}`}
        >
          {/* Tilde stays so it still reads as an estimate, not a
              hard close — same convention the inline sub-label used. */}
          ~{formatTimeNoZone(finishAt)}
        </span>
        <span
          style={{
            marginTop: 1,
            fontSize: 10,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkSubtle,
            letterSpacing: theme.type.tracking.wide,
            lineHeight: 1,
          }}
          aria-hidden
        >
          {fmtTzAbbr(finishAt)}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}
        aria-hidden
      >
        <FinishDot />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
              flexShrink: 0,
            }}
          >
            <Flag size={14} strokeWidth={2.25} />
          </span>
          <h4
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1.25,
            }}
          >
            Estimated finish
          </h4>
        </div>
        <div
          style={{
            paddingLeft: 34,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.4,
          }}
        >
          Patient leaves
        </div>
      </div>
    </li>
  );
}

// Hollow dot used only by the EstimatedFinishRow. Same diameter as
// PhaseDot so it sits on the rail at the right size, but unfilled
// so it reads as the closing tick of the timeline, not another
// phase.
function FinishDot() {
  return (
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: theme.color.surface,
        border: `2px solid ${theme.color.accent}`,
        flexShrink: 0,
        marginTop: 4,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────
// Row primitives
// ─────────────────────────────────────────────────────────────────

function PhaseRow({
  phase,
  isLast,
}: {
  phase: AppointmentPhaseSummary;
  isLast: boolean;
}) {
  const active = phase.patient_required;
  const Icon = active ? UserRound : Hourglass;
  const endStr = formatTime(phase.end_at);
  const durationMin = Math.max(
    Math.round(
      (new Date(phase.end_at).getTime() - new Date(phase.start_at).getTime()) /
        60_000,
    ),
    1,
  );
  return (
    <li
      style={{
        display: 'grid',
        // Three columns: time | rail | content. Fixed-width time
        // column keeps the rail vertically aligned regardless of
        // how wide the labels grow. Rail column hosts the 14px-wide
        // dot + connector lane.
        gridTemplateColumns: '64px 14px 1fr',
        gap: theme.space[4],
        // Bottom gap controls the visible space between rows. The
        // rail-segment owns the line continuity; the row gap below
        // is empty, so the connector inside the rail column extends
        // through it visually.
        minHeight: isLast ? 0 : 64,
      }}
    >
      {/* Time column */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          paddingTop: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span
          style={{
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
            lineHeight: 1.2,
          }}
        >
          {formatTimeNoZone(phase.start_at)}
        </span>
        <span
          style={{
            marginTop: 1,
            fontSize: 10,
            fontWeight: theme.type.weight.medium,
            color: theme.color.inkSubtle,
            letterSpacing: theme.type.tracking.wide,
            lineHeight: 1,
          }}
        >
          {fmtTzAbbr(phase.start_at)}
        </span>
        {/* No end-time sub-label here — the EstimatedFinishRow at
            the bottom of the timeline owns that information now. */}
      </div>

      {/* Rail — dot at the top, connector segment beneath */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}
        aria-hidden
      >
        <PhaseDot active={active} />
        {!isLast ? <PhaseConnector active={active} /> : null}
      </div>

      {/* Content column */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          // Bottom padding only when there's a next row; the
          // connector visually carries through this empty space.
          paddingBottom: isLast ? 0 : theme.space[4],
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: theme.radius.pill,
              background: active ? theme.color.accent : theme.color.accentBg,
              color: active ? '#FFFFFF' : theme.color.accent,
              flexShrink: 0,
            }}
          >
            <Icon size={14} strokeWidth={2.25} />
          </span>
          <h4
            style={{
              margin: 0,
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1.25,
            }}
          >
            {phase.label}
          </h4>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: theme.space[2],
            paddingLeft: 34, // align under the icon's label
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: 1.4,
          }}
        >
          <span style={{ fontWeight: theme.type.weight.medium }}>
            {formatMinutes(durationMin)}
          </span>
          <Dot />
          <PresenceNote active={active} endStr={endStr} />
        </div>
      </div>
    </li>
  );
}

function PhaseDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: active ? theme.color.accent : theme.color.surface,
        border: `2px solid ${theme.color.accent}`,
        flexShrink: 0,
        // Pop the active dot fractionally above the rail so the
        // solid fill reads first.
        marginTop: 4,
      }}
    />
  );
}

function PhaseConnector({ active }: { active: boolean }) {
  // Solid line for an active → next gap (the patient stays on-site
  // continuously). Dotted line for a passive → next gap (the patient
  // is free to leave). Dotted reads as "time discontinuity" without
  // breaking the visual rhythm.
  return (
    <span
      style={{
        flex: 1,
        width: 2,
        borderLeft: active
          ? `2px solid ${theme.color.accent}`
          : `2px dashed ${theme.color.accent}`,
        opacity: 0.4,
        minHeight: 32,
      }}
    />
  );
}

function Dot() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 3,
        height: 3,
        borderRadius: '50%',
        background: theme.color.inkSubtle,
      }}
    />
  );
}

function PresenceNote({
  active,
  endStr,
}: {
  active: boolean;
  endStr: string;
}): ReactNode {
  // Staff register — the PhaseTimeline is only rendered on the
  // Appointment Detail + Visit Detail hero sheets, both staff-only
  // surfaces. Copy describes the patient's state from the
  // receptionist's POV ("Patient required" / "Patient back by
  // 16:20"), not addressing the patient directly.
  if (active) {
    return <span>Patient required</span>;
  }
  return <span>Patient back by {endStr}</span>;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

// Compact "n min" / "n h" / "n h m" format, matching PhaseRibbon's
// formatMinutes() so the timeline and the admin ribbon read identically.
function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`;
  return `${h} h ${m} min`;
}
