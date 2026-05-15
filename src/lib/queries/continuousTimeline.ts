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

// Event types that fire AT MOST ONCE per booking lifecycle: the
// booking row, the deposit row, the visit open + close. The two
// hooks each surface them from a different source (visit hook
// synthesises from raw tables, appointment hook surfaces the
// patient_events row), so the merger sees both copies. We dedupe
// to the single richest occurrence per type.
//
// Timestamp is intentionally NOT part of the bucket key. The two
// sources can disagree on time by minutes or even days — for
// Calendly bookings, lng_appointments.deposit_paid_at is the
// Stripe charge time (could be days before the booking is created)
// while patient_events.deposit_paid.created_at is the webhook
// processing time. A minute-window key collapsed only when the
// timestamps lined up by accident; ignoring time entirely is the
// only way to catch every collision.
//
// Outside this set every event passes through independently —
// cart edits, emails, waiver signatures legitimately fire many
// times per booking and must not collapse.
const SEMANTIC_DEDUPE_TYPES = new Set<TimelineEvent['type']>([
  'appointment_created',
  'deposit_paid',
  'visit_opened',
  'visit_closed',
]);

function collapseSemantically(events: TimelineEvent[]): TimelineEvent[] {
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
    // Singleton-per-booking types: bucket on type alone so every
    // duplicate (regardless of timestamp gap) collapses into one.
    const key = ev.type;
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
