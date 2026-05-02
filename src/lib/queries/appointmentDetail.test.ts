import { describe, expect, it } from 'vitest';
import { availableActions, type AvailableActionsInput } from './appointmentDetail.ts';

// Single source of truth for the action gate on the AppointmentDetail
// page. Every status × source × condition combination that maps to a
// distinct action set gets a test here so a regression in the gate
// surfaces as a red test, not as a missing button on the kiosk.

const base: AvailableActionsInput = {
  status: 'booked',
  source: 'native',
  hasPatientEmail: true,
  hasVisit: false,
  hasRescheduleTarget: false,
};

describe('availableActions', () => {
  it('always includes view_patient_profile', () => {
    const statuses: AvailableActionsInput['status'][] = [
      'booked',
      'arrived',
      'in_progress',
      'complete',
      'no_show',
      'cancelled',
      'rescheduled',
    ];
    for (const status of statuses) {
      const out = availableActions({ ...base, status });
      expect(out).toContain('view_patient_profile');
    }
  });

  describe('booked', () => {
    it('native + email: arrival/no-show + edit/reschedule/cancel + resend', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'native', hasPatientEmail: true });
      expect(out).toEqual([
        'view_patient_profile',
        'mark_arrived',
        'mark_no_show',
        'edit',
        'reschedule',
        'cancel',
        'resend_confirmation',
      ]);
    });

    it('native without email: drops resend only', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'native', hasPatientEmail: false });
      expect(out).not.toContain('resend_confirmation');
      expect(out).toContain('edit');
      expect(out).toContain('reschedule');
      expect(out).toContain('cancel');
    });

    it('calendly: arrival/no-show only — edit/reschedule/cancel live on Calendly', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'calendly' });
      expect(out).toEqual(['view_patient_profile', 'mark_arrived', 'mark_no_show']);
    });

    it('manual is treated as native (non-Calendly)', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'manual' });
      expect(out).toContain('edit');
      expect(out).toContain('reschedule');
      expect(out).toContain('cancel');
    });
  });

  describe('cancelled', () => {
    it('exposes reverse_cancellation only', () => {
      const out = availableActions({ ...base, status: 'cancelled' });
      expect(out).toEqual(['view_patient_profile', 'reverse_cancellation']);
    });

    it('source does not affect the cancelled action set', () => {
      const native = availableActions({ ...base, status: 'cancelled', source: 'native' });
      const calendly = availableActions({ ...base, status: 'cancelled', source: 'calendly' });
      expect(native).toEqual(calendly);
    });
  });

  describe('no_show', () => {
    it('exposes reverse_no_show only', () => {
      const out = availableActions({ ...base, status: 'no_show' });
      expect(out).toEqual(['view_patient_profile', 'reverse_no_show']);
    });
  });

  describe('rescheduled', () => {
    it('with a target offers view_rescheduled_to', () => {
      const out = availableActions({ ...base, status: 'rescheduled', hasRescheduleTarget: true });
      expect(out).toContain('view_rescheduled_to');
    });

    it('without a target shows no extra action (Calendly leaves the field null sometimes)', () => {
      const out = availableActions({ ...base, status: 'rescheduled', hasRescheduleTarget: false });
      expect(out).toEqual(['view_patient_profile']);
    });
  });

  describe('post-arrival visit-bound statuses', () => {
    it('arrived + has visit: view_visit', () => {
      const out = availableActions({ ...base, status: 'arrived', hasVisit: true });
      expect(out).toEqual(['view_patient_profile', 'view_visit']);
    });

    it('in_progress + has visit: view_visit', () => {
      const out = availableActions({ ...base, status: 'in_progress', hasVisit: true });
      expect(out).toContain('view_visit');
    });

    it('complete + has visit: view_visit', () => {
      const out = availableActions({ ...base, status: 'complete', hasVisit: true });
      expect(out).toContain('view_visit');
    });

    it('arrived without a visit row: no view_visit (data-integrity edge — page redirects via the loader before this fires)', () => {
      const out = availableActions({ ...base, status: 'arrived', hasVisit: false });
      expect(out).not.toContain('view_visit');
    });
  });
});
