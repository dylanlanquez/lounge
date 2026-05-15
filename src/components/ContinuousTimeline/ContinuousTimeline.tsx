import { TimelineCard } from '../TimelineCard/TimelineCard.tsx';
import { useContinuousTimeline } from '../../lib/queries/continuousTimeline.ts';

// ContinuousTimeline — single audit trail covering the appointment's
// full lifecycle from booking to visit close. Mounted on both
// AppointmentDetail (visitId=null, pre-arrival) and VisitDetail
// (visitId set, post-arrival) so the patient's history reads as one
// stream regardless of which surface staff happen to be on. Replaces
// the legacy AppointmentTimeline / VisitTimeline pair, which read
// from different sources and made the timeline visually reset at the
// arrival boundary.

export interface ContinuousTimelineProps {
  appointmentId: string | null;
  visitId: string | null;
}

export function ContinuousTimeline({
  appointmentId,
  visitId,
}: ContinuousTimelineProps) {
  const { events, loading, error } = useContinuousTimeline(appointmentId, visitId);
  return (
    <TimelineCard
      events={events}
      loading={loading}
      error={error}
      emptyMessage={
        visitId
          ? undefined
          : "Nothing in the audit trail yet — the booking creation event will appear here when the next sweep runs."
      }
    />
  );
}
