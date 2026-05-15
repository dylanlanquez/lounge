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
    // Semantic dedupe pass. Some facts (the booking row, the deposit
    // capture) are surfaced by BOTH hooks via different ids — the
    // visit hook synthesises from raw tables, the appointment hook
    // surfaces the matching patient_events row. ID-only dedupe above
    // misses these because the ids differ. For each known collision
    // type we keep ONE event per (type, timestamp-rounded-to-minute)
    // bucket, scored by richness so the more informative version wins
    // (the appointment hook's "Appointment created · Click-in
    // veneers · scheduled Fri 15 May · LAP-00281" beats the visit
    // hook's "Booking placed · via venneir.com").
    const collapsed = collapseSemantically(merged);
    // Final sort — visit and appointment hooks each pre-sort their own
    // events, but a merged stream needs a single ordering pass.
    collapsed.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return {
      events: collapsed,
      loading: apptResult.loading || visitResult.loading,
      error: apptResult.error ?? visitResult.error ?? null,
    };
  }, [apptResult.events, apptResult.loading, apptResult.error, visitResult.events, visitResult.loading, visitResult.error]);
}

// Event types where each underlying fact may be surfaced multiple
// times across the two hooks (visit synth + appointment patient_events
// + lng_payments). Outside this set every event is treated as
// independent — patient_events of cart/waiver/email types legitimately
// fire many times in a single minute and must not collapse.
const SEMANTIC_DEDUPE_TYPES = new Set<TimelineEvent['type']>([
  'appointment_created',
  'deposit_paid',
  'visit_opened',
  'visit_closed',
]);

function collapseSemantically(events: TimelineEvent[]): TimelineEvent[] {
  // Bucket key: type + the minute the event landed in. A 60-second
  // window catches the small write-order skew between the appointment
  // INSERT and the patient_events INSERT (always <1s in practice)
  // without bleeding into legitimately separate events that happen
  // an hour apart.
  const bestByKey = new Map<string, TimelineEvent>();
  const order: string[] = []; // preserves first-seen order so the final sort is stable
  for (const ev of events) {
    if (!SEMANTIC_DEDUPE_TYPES.has(ev.type)) {
      // Non-collapsing types pass through with a unique-by-id key so
      // they never accidentally evict each other.
      const key = `__pass__${ev.id}`;
      bestByKey.set(key, ev);
      order.push(key);
      continue;
    }
    const minute = Math.floor(new Date(ev.timestamp).getTime() / 60_000);
    const key = `${ev.type}|${minute}`;
    const incumbent = bestByKey.get(key);
    if (!incumbent) {
      bestByKey.set(key, ev);
      order.push(key);
      continue;
    }
    if (richness(ev) > richness(incumbent)) {
      bestByKey.set(key, ev);
    }
  }
  // De-duplicate the order list (passes through types push the same
  // key once; collapsing types push it once per encounter) and emit
  // the surviving events.
  const seenOrder = new Set<string>();
  const out: TimelineEvent[] = [];
  for (const key of order) {
    if (seenOrder.has(key)) continue;
    seenOrder.add(key);
    const ev = bestByKey.get(key);
    if (ev) out.push(ev);
  }
  return out;
}

// Higher score = more informative event. Facts dominate (each fact
// is a structured booking field), then detail text length (the appt
// hook's "Click-in veneers · scheduled Fri 15 May · LAP-00281" beats
// the synth's "via venneir.com"), then title length as a tiebreaker.
function richness(ev: TimelineEvent): number {
  return (
    (ev.facts?.length ?? 0) * 100
    + (ev.detail?.length ?? 0)
    + (ev.title.length ?? 0) / 100
  );
}
