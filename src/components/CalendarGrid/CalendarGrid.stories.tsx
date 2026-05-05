import type { Meta, StoryObj } from '@storybook/react';
import { CalendarGrid, offsetForTime, heightForDuration } from './CalendarGrid.tsx';
import { AppointmentCard } from '../AppointmentCard/AppointmentCard.tsx';
import { theme } from '../../theme/index.ts';

const meta: Meta<typeof CalendarGrid> = {
  title: 'Primitives/CalendarGrid',
  component: CalendarGrid,
  parameters: { layout: 'fullscreen' },
};
export default meta;

const today = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const TodayWithThreeAppointments: StoryObj = {
  render: () => (
    <div style={{ background: theme.color.bg, padding: theme.space[6], minHeight: '100dvh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: theme.type.size.xl, fontWeight: theme.type.weight.semibold }}>
          Today
        </h1>
        <p style={{ color: theme.color.inkMuted, marginTop: theme.space[2], marginBottom: theme.space[6] }}>
          Three appointments. The green now-indicator updates every minute.
        </p>
        <div style={{ background: theme.color.surface, borderRadius: theme.radius.card, padding: theme.space[4], boxShadow: theme.shadow.card }}>
          <CalendarGrid>
            <AppointmentCard
              patientName="Sarah H."
              startAt={today(9, 0)}
              endAt={today(9, 30)}
              staffName="Mark"
              status="complete"
              serviceLabel="Denture repair"
              top={offsetForTime(today(9, 0), 8, 80)}
              height={heightForDuration(today(9, 0), today(9, 30), 80)}
            />
            <AppointmentCard
              patientName="Rajiv P."
              startAt={today(10, 30)}
              endAt={today(11, 0)}
              staffName="Mark"
              status="arrived"
              serviceLabel="Click-in veneers"
              top={offsetForTime(today(10, 30), 8, 80)}
              height={heightForDuration(today(10, 30), today(11, 0), 80)}
            />
            <AppointmentCard
              patientName="Olu A."
              startAt={today(14, 0)}
              endAt={today(14, 45)}
              status="booked"
              serviceLabel="Whitening top-up"
              top={offsetForTime(today(14, 0), 8, 80)}
              height={heightForDuration(today(14, 0), today(14, 45), 80)}
            />
          </CalendarGrid>
        </div>
      </div>
    </div>
  ),
};

export const StatusGallery: StoryObj = {
  render: () => (
    <div style={{ background: theme.color.bg, padding: theme.space[6], minHeight: '100dvh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: theme.type.size.xl, fontWeight: theme.type.weight.semibold }}>
          All status tones
        </h1>
        <p style={{ color: theme.color.inkMuted, marginTop: theme.space[2], marginBottom: theme.space[6] }}>
          Six rows showing each status in turn. Mostly black and white per design preference; only "arrived" gets the green fill.
        </p>
        <div style={{ background: theme.color.surface, borderRadius: theme.radius.card, padding: theme.space[4], boxShadow: theme.shadow.card }}>
          <CalendarGrid showNowIndicator={false}>
            {(['booked', 'arrived', 'complete', 'no_show', 'cancelled'] as const).map((status, i) => {
              const start = today(8 + i + 1, 0);
              const end = today(8 + i + 1, 45);
              const labels: Record<string, string> = {
                booked: 'Sarah H.',
                arrived: 'Rajiv P.',
                complete: 'Marta K.',
                no_show: 'Tom B.',
                cancelled: 'Jay W.',
              };
              return (
                <AppointmentCard
                  key={status}
                  patientName={labels[status]!}
                  startAt={start}
                  endAt={end}
                  status={status}
                  serviceLabel={status.replace('_', ' ')}
                  top={offsetForTime(start, 8, 80)}
                  height={heightForDuration(start, end, 80)}
                />
              );
            })}
          </CalendarGrid>
        </div>
      </div>
    </div>
  ),
};
