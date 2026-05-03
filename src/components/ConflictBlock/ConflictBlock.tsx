import { theme } from '../../theme/index.ts';
import { StatusBanner } from '../StatusBanner/StatusBanner.tsx';
import { type RescheduleConflict } from '../../lib/queries/rescheduleAppointment.ts';

// Booking-conflict status block used by both new-booking and
// reschedule sheets. Reads the live result of the
// lng_booking_check_conflict RPC and renders one of four states:
//
//   not yet checkable    — slot isn't valid (no service / no time
//                          / outside hours), so we render nothing
//                          and let upstream banners speak.
//   checking             — debounced server round-trip in flight.
//                          Surfaces the current duration so the
//                          user knows what's being checked.
//   free                 — solid green. The customisable `freeBody`
//                          lets each consumer phrase it for their
//                          own action ("add it to the schedule" vs
//                          "move the appointment").
//   conflicts (>= 1)     — error banner listing each conflict in
//                          plain English (pool at capacity, service
//                          at max-concurrent).
//
// The conflict-check error case (RPC failure) is its own treatment
// so a failed availability lookup doesn't masquerade as "slot is
// free".

export interface ConflictBlockProps {
  checking: boolean;
  conflicts: RescheduleConflict[];
  // Non-null when the RPC itself failed (network / DB error).
  // Renders distinctly from the "slot is conflicted" case.
  error: string | null;
  // True when the slot has both a date and a time and they're
  // inside the service's working hours. When false the block
  // renders nothing — outside-hours and missing-input cases are
  // upstream banners' job.
  slotIsValid: boolean;
  durationMinutes: number | null;
  // Body text shown when the slot is free. Differs by consumer:
  // new-booking reads "Saving will add it to the schedule.";
  // reschedule reads "Saving will move the appointment and email
  // the patient.". Centralising the visual pattern but letting
  // each sheet phrase its own commit-action keeps the copy
  // accurate to what's about to happen.
  freeBody: string;
}

export function ConflictBlock({
  checking,
  conflicts,
  error,
  slotIsValid,
  durationMinutes,
  freeBody,
}: ConflictBlockProps) {
  if (error) {
    return (
      <StatusBanner tone="error" title="Couldn't check the slot">
        {error}
      </StatusBanner>
    );
  }
  if (!slotIsValid) return null;
  if (checking) {
    return (
      <StatusBanner tone="info">
        Checking availability… ({durationMinutes ?? '–'} min slot)
      </StatusBanner>
    );
  }
  if (conflicts.length === 0) {
    return <StatusBanner tone="success">{freeBody}</StatusBanner>;
  }
  return (
    <StatusBanner tone="error" title="Slot conflicts">
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[1],
        }}
      >
        {conflicts.map((c, i) => (
          <li key={i} style={{ fontSize: theme.type.size.sm, lineHeight: theme.type.leading.snug }}>
            {describeConflict(c)}
          </li>
        ))}
      </ul>
    </StatusBanner>
  );
}

// Operator-language conflict copy. Reads the phase-aware fields when
// present (pool busy in a specific phase, time window known) and
// falls back to the legacy "pool at capacity" sentence otherwise.
function describeConflict(c: RescheduleConflict): string {
  if (c.conflict_kind === 'max_concurrent') {
    return `Service is at its concurrent-bookings cap (${c.current_count}/${c.pool_capacity} already booked).`;
  }
  const poolName = c.pool_id ? humanisePoolId(c.pool_id) : 'Resource';
  const window = c.conflict_start_at && c.conflict_end_at
    ? `${formatTime(c.conflict_start_at)} to ${formatTime(c.conflict_end_at)}`
    : null;
  const phase = c.phase_label ? ` (${c.phase_label})` : '';
  if (window) {
    return `${poolName} busy ${window}${phase}, ${c.current_count}/${c.pool_capacity} already booked.`;
  }
  return `${poolName} is at capacity${phase}, ${c.current_count}/${c.pool_capacity} already booked.`;
}

// "lab-bench" → "Lab bench". Pool ids are slugged so the display
// form is the slug with the first letter uppercased and hyphens
// turned into spaces. When admins rename pools, the slug stays
// (per the booking-resource-pools migration's check constraint),
// so this stays correct without lookup.
function humanisePoolId(id: string): string {
  const spaced = id.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
