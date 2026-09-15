import { describe, expect, it } from 'vitest';
import { isVoiceCall, telHref, voiceCallIsLive, VOICE_CALL_CATEGORY } from './voiceCall.ts';
import {
  APPOINTMENT_CATEGORY_LABELS,
  APPOINTMENT_CATEGORY_ORDER,
  appointmentCategory,
  formatAppointmentSummary,
  formatCustomerServiceTitleLabel,
} from './queries/appointments.ts';
import { theme } from '../theme/index.ts';

describe('voice call vocabulary', () => {
  it('recognises a voice call by service_type only', () => {
    expect(isVoiceCall({ service_type: 'voice_call' })).toBe(true);
    expect(isVoiceCall({ service_type: 'virtual_impression_appointment' })).toBe(false);
    expect(isVoiceCall({ service_type: null })).toBe(false);
  });

  it('lands voice calls in their own schedule category, with a colour and a label', () => {
    const cat = appointmentCategory({ service_type: 'voice_call', event_type_label: null });
    expect(cat).toBe(VOICE_CALL_CATEGORY);
    expect(APPOINTMENT_CATEGORY_ORDER).toContain(cat);
    expect(APPOINTMENT_CATEGORY_LABELS[cat]).toBe('Voice calls');
    expect(theme.category[cat]).toMatch(/^#/);
  });

  it('falls back to the label for legacy rows with no service_type', () => {
    expect(appointmentCategory({ service_type: null, event_type_label: 'Voice call' })).toBe('voiceCall');
    expect(appointmentCategory({ service_type: null, event_type_label: 'Phone call with Sarah' })).toBe('voiceCall');
    expect(appointmentCategory({ service_type: null, event_type_label: 'Impression Appointment' })).toBe('impression');
  });

  it('reads as "Voice Call" on every summary surface', () => {
    const row = { service_type: 'voice_call', event_type_label: 'Voice call', arch: null, product_key: null, intake: null };
    expect(formatAppointmentSummary(row)).toBe('Voice Call');
    expect(
      formatCustomerServiceTitleLabel({ service_type: 'voice_call', event_type_label: 'Voice call', arch: null, product_key: null }),
    ).toBe('Voice Call');
  });

  it('knows which statuses a call can still be dialled from', () => {
    expect(voiceCallIsLive('booked')).toBe(true);
    expect(voiceCallIsLive('arrived')).toBe(true);
    expect(voiceCallIsLive('joined')).toBe(true);
    expect(voiceCallIsLive('complete')).toBe(false);
    expect(voiceCallIsLive('no_show')).toBe(false);
    expect(voiceCallIsLive('cancelled')).toBe(false);
  });
});

describe('telHref', () => {
  it('keeps digits and a leading plus', () => {
    expect(telHref('+44 7700 900123')).toBe('tel:+447700900123');
    expect(telHref('07700 900123')).toBe('tel:07700900123');
    expect(telHref('(0141) 555-0199')).toBe('tel:01415550199');
  });

  it('refuses nothing dialable so the button can hide', () => {
    expect(telHref(null)).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref('n/a')).toBeNull();
    expect(telHref('12345')).toBeNull();
  });
});
