import { useMemo } from 'react';
import { useAppointmentTimeline } from './appointmentTimeline.ts';
import { useVisitTimeline, type TimelineEvent } from './visitTimeline.ts';

// useContinuousTimeline — single timeline stream covering the full
// appointment lifecycle: booking placed → reminders → deposit → arrival
// → cart edits → waiver signing → payments → visit closed.
//
// Single source of truth per event. The two underlying hooks emit
// disjoint streams:
//
//   useAppointmentTimeline → appointment-scoped events:
//     booking placed, deposit / paid in full, edited, rescheduled,
//     cancelled, no-show, virtual meeting, confirmation /
//     cancellation / reminder emails, system failures.
//
//   useVisitTimeline → visit-scoped events:
//     visit opened, cart edits, payments, waiver signatures,
//     receipts, dispatch, tech notes, visit ended early, walk-in
//     creation, visit closed.
//
// No event is produced by both hooks. The earlier "two writers + a
// dedupe layer pick the richer one" arrangement was fragile: when the
// two writers disagreed on title or facts you could never tell which
// version was authoritative. Now each event has exactly one author.
//
// This hook just runs both queries, concatenates the events, and
// re-sorts so the merged stream is in the correct chronological
// order. Loading + error are unioned across the two hooks. Walk-in
// visits have null appointmentId, so the appointment hook short-
// circuits and the visit hook alone drives the timeline.

export interface UseContinuousTimelineResult {
  events: TimelineEvent[];
  loading: boolean;
  error: string | null;
}

export function useContinuousTimeline(
  appointmentId: string | null | undefined,
  visitId: string | null | undefined,
): UseContinuousTimelineResult {
  const apptResult = useAppointmentTimeline(appointmentId);
  // Pass `null` (not undefined) when there's no visit yet so the visit
  // hook short-circuits cleanly. Walk-in visits have null
  // appointmentId; in that case the appointment hook short-circuits
  // and the visit feed alone drives the timeline.
  const visitResult = useVisitTimeline(visitId ?? null);

  return useMemo(() => {
    const merged: TimelineEvent[] = [
      ...apptResult.events,
      ...visitResult.events,
    ];
    merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return {
      events: merged,
      loading: apptResult.loading || visitResult.loading,
      error: apptResult.error ?? visitResult.error ?? null,
    };
  }, [apptResult.events, apptResult.loading, apptResult.error, visitResult.events, visitResult.loading, visitResult.error]);
}
