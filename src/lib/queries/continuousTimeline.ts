import { useMemo } from 'react';
import { useAppointmentTimeline } from './appointmentTimeline.ts';
import { useVisitTimeline, type TimelineEvent } from './visitTimeline.ts';

// useContinuousTimeline — single timeline stream covering the full
// appointment lifecycle: booking placed → reminders → deposit → arrival
// → cart edits → waiver signing → payments → visit closed.
//
// AppointmentDetail and VisitDetail historically each owned a separate
// hook (appointment-only patient_events vs. visit-only synthesis). The
// patient's audit trail visually reset when they were marked arrived,
// even though it's conceptually one continuous record. This hook
// merges both feeds so both surfaces render the SAME events with the
// SAME order — the only thing that differs is whether visit-side
// events exist yet.
//
// Behaviour:
//   • Always reads the appointment timeline.
//   • Reads the visit timeline only when visitId is non-null. When the
//     patient is still pre-arrival (visitId null), the visit fetch is
//     skipped entirely and the result mirrors the legacy
//     useAppointmentTimeline call.
//   • Deduplicates by event id. The two hooks may synthesise the same
//     underlying row twice (e.g. the appointment_booked patient_events
//     row surfaces in both); the merger keeps the FIRST occurrence,
//     which is the visit-side render whenever both hooks are active —
//     visit-side carries richer cart context.
//   • Sorts descending by timestamp so the newest event is at the top,
//     matching both legacy hooks.
//
// Loading + error fields are unioned (any underlying loading → loading;
// any underlying error → error). The hook is otherwise a pure merge —
// it adds no fetch of its own and stays cheap to call.

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
    const seen = new Set<string>();
    const merged: TimelineEvent[] = [];
    // Visit events first — when both hooks emit the same underlying
    // row (id collision), the visit-side version wins because it
    // carries cart / waiver / payment context the appointment hook
    // doesn't synthesise.
    for (const ev of visitResult.events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.push(ev);
    }
    for (const ev of apptResult.events) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.push(ev);
    }
    // Final sort — visit and appointment hooks each pre-sort their own
    // events, but a merged stream needs a single ordering pass.
    merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return {
      events: merged,
      loading: apptResult.loading || visitResult.loading,
      error: apptResult.error ?? visitResult.error ?? null,
    };
  }, [apptResult.events, apptResult.loading, apptResult.error, visitResult.events, visitResult.loading, visitResult.error]);
}
