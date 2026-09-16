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
  isVirtual: false,
  isVoiceCall: false,
};

describe('availableActions', () => {
  it('always includes view_patient_profile', () => {
    const statuses: AvailableActionsInput['status'][] = [
      'booked',
      'arrived',
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
    it('native + email: arrival/no-show + reschedule/cancel + resend (no edit — notes edit inline)', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'native', hasPatientEmail: true });
      expect(out).toEqual([
        'view_patient_profile',
        'mark_arrived',
        'mark_no_show',
        'reschedule',
        'cancel',
        'resend_confirmation',
      ]);
    });

    it('native without email: drops resend only', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'native', hasPatientEmail: false });
      expect(out).not.toContain('resend_confirmation');
      expect(out).toContain('reschedule');
      expect(out).toContain('cancel');
    });

    it('calendly: arrival/no-show only — reschedule/cancel live on Calendly', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'calendly' });
      expect(out).toEqual(['view_patient_profile', 'mark_arrived', 'mark_no_show']);
    });

    it('manual is treated as native (non-Calendly)', () => {
      const out = availableActions({ ...base, status: 'booked', source: 'manual' });
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

    it('complete + has visit: view_visit', () => {
      const out = availableActions({ ...base, status: 'complete', hasVisit: true });
      expect(out).toContain('view_visit');
    });

    it('arrived without a visit row: no view_visit (data-integrity edge — page redirects via the loader before this fires)', () => {
      const out = availableActions({ ...base, status: 'arrived', hasVisit: false });
      expect(out).not.toContain('view_visit');
    });
  });

  describe('virtual: reschedule is always available regardless of source', () => {
    // Once a virtual call is in motion, staff is the only person in a
    // position to act on a mid-call rebook request. Reschedule stays
    // on the action list at booked + joined for every source —
    // including Calendly, which is normally blocked from Lounge-side
    // rescheduling for in-person bookings.

    it('booked + calendly + virtual: reschedule + mark_virtual_complete offered', () => {
      const out = availableActions({
        ...base,
        status: 'booked',
        source: 'calendly',
        isVirtual: true,
      });
      expect(out).toContain('reschedule');
      expect(out).toContain('mark_virtual_complete');
    });

    it('joined + calendly + virtual: reschedule is offered alongside rejoin', () => {
      const out = availableActions({
        ...base,
        status: 'joined',
        source: 'calendly',
        isVirtual: true,
      });
      expect(out).toContain('reschedule');
      expect(out).toContain('rejoin_meeting');
      expect(out).toContain('mark_virtual_complete');
    });

    it('booked + calendly + in-person (non-virtual): reschedule still blocked', () => {
      // Sanity check — Calendly in-person bookings keep the original
      // gate so this change doesn't leak.
      const out = availableActions({
        ...base,
        status: 'booked',
        source: 'calendly',
        isVirtual: false,
      });
      expect(out).not.toContain('reschedule');
    });

    it('joined + native + virtual: reschedule is offered (existing behaviour)', () => {
      const out = availableActions({
        ...base,
        status: 'joined',
        source: 'native',
        isVirtual: true,
      });
      expect(out).toContain('reschedule');
    });
  });

  describe('voice call', () => {
    // A voice call replaces the arrival/no-show pair with a single
    // "log this call" action and never offers Join/Rejoin/Mark-
    // complete — there is no join_url and no visit for it.

    it('booked + voice call: log_call_outcome replaces mark_arrived/mark_no_show', () => {
      const out = availableActions({ ...base, status: 'booked', isVoiceCall: true });
      expect(out).toEqual([
        'view_patient_profile',
        'log_call_outcome',
        'reschedule',
        'cancel',
        'resend_confirmation',
      ]);
    });

    it('booked + voice call: mark_arrived and mark_no_show are never offered', () => {
      const out = availableActions({ ...base, status: 'booked', isVoiceCall: true });
      expect(out).not.toContain('mark_arrived');
      expect(out).not.toContain('mark_no_show');
    });

    it('no_show + voice call: reverse_call_outcome replaces reverse_no_show', () => {
      const out = availableActions({ ...base, status: 'no_show', isVoiceCall: true });
      expect(out).toEqual(['view_patient_profile', 'reverse_call_outcome']);
    });

    it('complete + voice call: reverse_call_outcome is offered (a mistaken "Answered" can be undone)', () => {
      const out = availableActions({ ...base, status: 'complete', isVoiceCall: true });
      expect(out).toEqual(['view_patient_profile', 'reverse_call_outcome']);
    });

    it('arrived + voice call: no view_visit, no reverse_call_outcome (a voice call cannot reach "arrived")', () => {
      const out = availableActions({ ...base, status: 'arrived', isVoiceCall: true });
      expect(out).toEqual(['view_patient_profile']);
    });

    it('booked + voice call: never offers join_meeting, rejoin_meeting, or mark_virtual_complete', () => {
      const out = availableActions({ ...base, status: 'booked', isVoiceCall: true, isVirtual: false });
      expect(out).not.toContain('join_meeting');
      expect(out).not.toContain('rejoin_meeting');
      expect(out).not.toContain('mark_virtual_complete');
    });
  });

  describe('virtual: mark_virtual_complete', () => {
    it('joined + virtual: mark_virtual_complete is offered', () => {
      const out = availableActions({
        ...base,
        status: 'joined',
        source: 'native',
        isVirtual: true,
      });
      expect(out).toContain('mark_virtual_complete');
    });

    it('booked + virtual: mark_virtual_complete IS offered', () => {
      const out = availableActions({
        ...base,
        status: 'booked',
        source: 'native',
        isVirtual: true,
      });
      expect(out).toContain('mark_virtual_complete');
    });

    it('booked + in-person: mark_virtual_complete is NOT offered', () => {
      const out = availableActions({
        ...base,
        status: 'booked',
        source: 'native',
        isVirtual: false,
      });
      expect(out).not.toContain('mark_virtual_complete');
    });

    it('complete + virtual: mark_virtual_complete is NOT offered (already done)', () => {
      const out = availableActions({
        ...base,
        status: 'complete',
        isVirtual: true,
      });
      expect(out).not.toContain('mark_virtual_complete');
    });
  });
});
