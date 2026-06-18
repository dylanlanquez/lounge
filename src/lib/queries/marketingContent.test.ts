import { describe, expect, it } from 'vitest';
import {
  aggregateMarketingContent,
  type McAppointmentRow,
  type McFileRow,
  type McPatientRow,
} from './marketingContent.ts';

function file(
  id: string,
  apptId: string,
  labelKey: string,
  uploadedAt: string,
  patientId: string | null = 'p1',
): McFileRow {
  return {
    id,
    file_url: `case-files/${id}.jpg`,
    file_name: `${id}.jpg`,
    uploaded_at: uploadedAt,
    source_appointment_id: apptId,
    patient_id: patientId,
    labelKey,
  };
}

const appts: McAppointmentRow[] = [
  { id: 'a1', appointment_ref: 'LAP-1', start_at: '2026-06-10T09:00:00Z', event_type_label: 'Same-day veneers', service_type: null, arch: 'both' },
  { id: 'a2', appointment_ref: 'LAP-2', start_at: '2026-06-12T09:00:00Z', event_type_label: null, service_type: 'denture_repair', arch: null },
];
const patients: McPatientRow[] = [{ id: 'p1', first_name: 'flora', last_name: 'sawers' }];

describe('aggregateMarketingContent', () => {
  it('groups by appointment, orders before/after/marketing, and totals', () => {
    const files = [
      file('m1', 'a1', 'marketing_content', '2026-06-10T12:00:00Z'),
      file('b1', 'a1', 'before_photo', '2026-06-10T10:00:00Z'),
      file('af1', 'a1', 'after_photo', '2026-06-10T11:00:00Z'),
      file('b2', 'a2', 'before_photo', '2026-06-12T10:00:00Z'),
    ];
    const data = aggregateMarketingContent(files, appts, patients);

    expect(data.totalAppointments).toBe(2);
    expect(data.totalPhotos).toBe(4);
    expect(data.beforeAfterPhotos).toBe(3);
    expect(data.marketingPhotos).toBe(1);

    const a1row = data.appointments.find((a) => a.appointmentId === 'a1')!;
    const a2row = data.appointments.find((a) => a.appointmentId === 'a2')!;

    // a2's photo (Jun 12) is the most recent upload, so a2 sorts first.
    expect(data.appointments[0]!.appointmentId).toBe('a2');
    // Within a1: before, after, marketing.
    expect(a1row.photos.map((p) => p.kind)).toEqual(['before', 'after', 'marketing']);
    expect(a1row.patientName).toBe('Flora Sawers');
    expect(a1row.serviceLabel).toBe('Same-day veneers');
    // a2 falls back to service_type for its label.
    expect(a2row.serviceLabel).toBe('denture_repair');
  });

  it('features the single most recent photo across all appointments', () => {
    const files = [
      file('old', 'a1', 'before_photo', '2026-06-10T10:00:00Z'),
      file('new', 'a2', 'marketing_content', '2026-06-15T10:00:00Z'),
    ];
    const data = aggregateMarketingContent(files, appts, patients);
    expect(data.featured?.photo.id).toBe('new');
    expect(data.featured?.appointment.appointmentId).toBe('a2');
  });

  it('drops files whose appointment is not in range and unknown labels', () => {
    const files = [
      file('x', 'missing-appt', 'before_photo', '2026-06-10T10:00:00Z'),
      file('y', 'a1', 'xray_panoramic', '2026-06-10T10:00:00Z'), // not a marketing label
    ];
    const data = aggregateMarketingContent(files, appts, patients);
    expect(data.totalPhotos).toBe(0);
    expect(data.appointments).toHaveLength(0);
    expect(data.featured).toBeNull();
  });

  it('falls back to the appointment ref when no patient is found', () => {
    const files = [file('b', 'a1', 'before_photo', '2026-06-10T10:00:00Z', null)];
    const data = aggregateMarketingContent(files, appts, []);
    expect(data.appointments[0]!.patientName).toBe('LAP-1');
  });

  it('handles an empty gallery', () => {
    const data = aggregateMarketingContent([], [], []);
    expect(data.totalPhotos).toBe(0);
    expect(data.featured).toBeNull();
  });
});
