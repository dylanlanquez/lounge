import { describe, expect, it } from 'vitest';
import {
  bucketForVisit,
  formatWaitingTime,
  searchableTextForVisit,
  sortByWaitingDesc,
  waiverStatusForVisit,
  type EnrichedActiveVisit,
} from './clinicBoard.ts';
import type { WaiverSection, WaiverSignatureSummary } from './waiver.ts';

describe('bucketForVisit', () => {
  it('routes walk-ins by service_type', () => {
    expect(bucketForVisit({ event_type_label: null, service_type: 'denture_repair' })).toBe('repair');
    expect(bucketForVisit({ event_type_label: null, service_type: 'same_day_appliance' })).toBe('appliance');
    expect(bucketForVisit({ event_type_label: null, service_type: 'click_in_veneers' })).toBe('sameDay');
  });

  it("falls back to 'consult' for walk-in service_type='other'", () => {
    expect(bucketForVisit({ event_type_label: null, service_type: 'other' })).toBe('consult');
  });

  it('routes booked appointments by event_type_label', () => {
    expect(bucketForVisit({ event_type_label: 'Denture Repairs', service_type: null })).toBe('repair');
    expect(bucketForVisit({ event_type_label: 'Click-in Veneer Fitting', service_type: null })).toBe('sameDay');
    expect(bucketForVisit({ event_type_label: 'Same-day Appliance', service_type: null })).toBe('appliance');
    expect(bucketForVisit({ event_type_label: 'In-person Impression Appointment', service_type: null })).toBe('impression');
  });

  it("falls back to 'consult' for unrecognised labels and null", () => {
    expect(bucketForVisit({ event_type_label: 'Initial Chat', service_type: null })).toBe('consult');
    expect(bucketForVisit({ event_type_label: null, service_type: null })).toBe('consult');
  });

  it('prefers walk-in service_type over event_type_label when both are present', () => {
    // A walk-in with a marker row in lng_appointments shouldn't be
    // re-bucketed by the marker label — the walk-in itself wins.
    expect(
      bucketForVisit({ event_type_label: 'Walk-in', service_type: 'denture_repair' })
    ).toBe('repair');
  });
});

describe('searchableTextForVisit', () => {
  it('joins all the searchable fields lowercased', () => {
    const v = makeVisit({
      patient_first_name: 'Antony',
      patient_last_name: 'Antoniou',
      patient_phone: '07597028509',
      patient_email: 'antony@example.com',
      patient_internal_ref: 'MP-00011',
      appointment_ref: 'LAP-00001',
      jb_ref: '33',
      event_type_label: 'Same-day Appliance',
      service_type: null,
      appliance_type: null,
      descriptor: 'Upper Whitening Trays',
    });
    const s = searchableTextForVisit(v);
    expect(s).toContain('antony');
    expect(s).toContain('antoniou');
    expect(s).toContain('07597028509');
    expect(s).toContain('antony@example.com');
    expect(s).toContain('mp-00011');
    expect(s).toContain('lap-00001');
    expect(s).toContain('jb33');
    expect(s).toContain('same-day appliance');
    expect(s).toContain('upper whitening trays');
  });

  it('skips null fields cleanly', () => {
    const v = makeVisit({ patient_first_name: 'Sarah' });
    const s = searchableTextForVisit(v);
    expect(s).toBe('sarah');
  });
});

describe('sortByWaitingDesc', () => {
  it('puts the longest-waiting visit first', () => {
    const visits = [
      { id: 'a', opened_at: '2026-04-28T10:00:00Z' },
      { id: 'b', opened_at: '2026-04-28T09:00:00Z' },
      { id: 'c', opened_at: '2026-04-28T11:00:00Z' },
    ];
    const sorted = sortByWaitingDesc(visits);
    expect(sorted.map((v) => v.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const visits = [
      { id: 'a', opened_at: '2026-04-28T10:00:00Z' },
      { id: 'b', opened_at: '2026-04-28T09:00:00Z' },
    ];
    const original = [...visits];
    sortByWaitingDesc(visits);
    expect(visits).toEqual(original);
  });
});

describe('waiverStatusForVisit', () => {
  const sections: WaiverSection[] = [
    {
      key: 'general',
      title: 'General',
      terms: ['…'],
      version: 'v1',
      applies_to_service_type: null,
      sort_order: 1,
      active: true,
    },
    {
      key: 'appliance',
      title: 'Appliances',
      terms: ['…'],
      version: 'v1',
      applies_to_service_type: 'same_day_appliance',
      sort_order: 2,
      active: true,
    },
  ];

  it("returns 'not_required' when no sections have been seeded", () => {
    expect(
      waiverStatusForVisit(
        { event_type_label: 'Same-day Appliance', service_type: null },
        [],
        new Map()
      )
    ).toBe('not_required');
  });

  it("returns 'pending' when a required section has not been signed", () => {
    expect(
      waiverStatusForVisit(
        { event_type_label: 'Same-day Appliance', service_type: null },
        sections,
        new Map()
      )
    ).toBe('pending');
  });

  it("returns 'done' when every required section is signed at the current version", () => {
    const sigs = new Map<string, WaiverSignatureSummary>();
    sigs.set('general', { section_key: 'general', section_version: 'v1', signed_at: '2026-04-28T09:00:00Z' });
    sigs.set('appliance', { section_key: 'appliance', section_version: 'v1', signed_at: '2026-04-28T09:00:00Z' });
    expect(
      waiverStatusForVisit(
        { event_type_label: 'Same-day Appliance', service_type: null },
        sections,
        sigs
      )
    ).toBe('done');
  });

  it("returns 'pending' when a signature is on a stale version", () => {
    const sigs = new Map<string, WaiverSignatureSummary>();
    sigs.set('general', { section_key: 'general', section_version: 'v0', signed_at: '2026-01-01T09:00:00Z' });
    sigs.set('appliance', { section_key: 'appliance', section_version: 'v1', signed_at: '2026-04-28T09:00:00Z' });
    expect(
      waiverStatusForVisit(
        { event_type_label: 'Same-day Appliance', service_type: null },
        sections,
        sigs
      )
    ).toBe('pending');
  });

  it('uses walk-in service_type directly without an event_type_label', () => {
    expect(
      waiverStatusForVisit(
        { event_type_label: null, service_type: 'same_day_appliance' },
        sections,
        new Map()
      )
    ).toBe('pending');
  });
});

describe('formatWaitingTime', () => {
  it('formats short waits in minutes', () => {
    expect(formatWaitingTime(0)).toBe('just now');
    expect(formatWaitingTime(1)).toBe('1m');
    expect(formatWaitingTime(47)).toBe('47m');
  });

  it('rounds the hour boundary cleanly', () => {
    expect(formatWaitingTime(60)).toBe('1h');
    expect(formatWaitingTime(120)).toBe('2h');
  });

  it('joins hours and minutes with a space', () => {
    expect(formatWaitingTime(75)).toBe('1h 15m');
    expect(formatWaitingTime(135)).toBe('2h 15m');
  });
});

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function makeVisit(overrides: Partial<EnrichedActiveVisit> = {}): EnrichedActiveVisit {
  return {
    id: 'visit-1',
    patient_id: 'p-1',
    status: 'opened',
    arrival_type: 'walk_in',
    opened_at: '2026-04-28T09:00:00Z',
    patient_first_name: null,
    patient_last_name: null,
    patient_phone: null,
    patient_email: null,
    patient_internal_ref: null,
    patient_avatar_data: null,
    event_type_label: null,
    intake: null,
    appointment_ref: null,
    jb_ref: null,
    service_type: null,
    appliance_type: null,
    bucket: 'consult',
    descriptor: '',
    searchable: '',
    amount_due_pence: null,
    amount_paid_pence: 0,
    paid_status: 'no_charge',
    payment_done: true,
    waiver_status: 'not_required',
    ...overrides,
  };
}
