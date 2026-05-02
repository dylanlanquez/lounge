import { TimelineCard } from '../TimelineCard/TimelineCard.tsx';
import { useVisitTimeline } from '../../lib/queries/visitTimeline.ts';

// VisitTimeline — visit-page audit trail. Thin wrapper that pulls
// the events from useVisitTimeline (which aggregates patient_events
// + lng_visits + lng_payments + waiver signatures) and hands them
// to the shared TimelineCard renderer. The same renderer powers
// AppointmentTimeline, so visual changes flow to both surfaces in
// one place.

export interface VisitTimelineProps {
  visitId: string | null;
}

export function VisitTimeline({ visitId }: VisitTimelineProps) {
  const { events, loading, error } = useVisitTimeline(visitId);
  return <TimelineCard events={events} loading={loading} error={error} />;
}
