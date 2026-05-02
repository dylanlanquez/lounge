import { TimelineCard } from '../TimelineCard/TimelineCard.tsx';
import { useAppointmentTimeline } from '../../lib/queries/appointmentTimeline.ts';

// AppointmentTimeline — audit trail rendered on the AppointmentDetail
// page. Thin wrapper that pulls events from useAppointmentTimeline
// (which curates patient_events + lng_system_failures scoped to the
// appointment) and hands them to the shared TimelineCard renderer.
// Visual parity with VisitTimeline is structural, not coincidental:
// both go through the same component.

export interface AppointmentTimelineProps {
  appointmentId: string | null;
}

export function AppointmentTimeline({ appointmentId }: AppointmentTimelineProps) {
  const { events, loading, error } = useAppointmentTimeline(appointmentId);
  return (
    <TimelineCard
      events={events}
      loading={loading}
      error={error}
      emptyMessage="Nothing in the audit trail yet — the booking creation event will appear here when the next sweep runs."
    />
  );
}
