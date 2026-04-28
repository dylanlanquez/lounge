import { describe, expect, it } from 'vitest';
import { filterCareIntake, intakeSummary } from './appointments.ts';
import type { AppointmentRow } from './appointments.ts';

const makeRow = (intake: AppointmentRow['intake']): AppointmentRow => ({
  id: 'a',
  patient_id: 'p',
  location_id: 'l',
  start_at: '2026-04-28T09:00:00Z',
  end_at: '2026-04-28T10:00:00Z',
  status: 'booked',
  event_type_label: 'Denture Repairs',
  staff_account_id: null,
  intake,
  join_url: null,
  deposit_pence: null,
  deposit_currency: null,
  deposit_provider: null,
  patient_first_name: 'Sandra',
  patient_last_name: 'Denyer',
  patient_email: null,
  patient_phone: null,
  staff_first_name: null,
  staff_last_name: null,
});

describe('intakeSummary / filterCareIntake', () => {
  it('returns undefined when intake is null', () => {
    expect(intakeSummary(makeRow(null))).toBeUndefined();
  });

  it('returns undefined when intake is empty', () => {
    expect(intakeSummary(makeRow([]))).toBeUndefined();
  });

  it('returns the answer for a single care question', () => {
    expect(intakeSummary(makeRow([{ question: 'Repair Type', answer: 'Snapped Denture' }]))).toBe(
      'Snapped Denture'
    );
  });

  it('joins multiple care answers with a middle dot', () => {
    expect(
      intakeSummary(
        makeRow([
          { question: 'Appliance', answer: 'Night guard' },
          { question: 'Arch', answer: 'Upper' },
        ])
      )
    ).toBe('Night guard · Upper');
  });

  it('strips contact-only fields (phone / email / time zone)', () => {
    const result = intakeSummary(
      makeRow([
        { question: 'Repair Type', answer: 'Snapped Denture' },
        { question: 'Contact Number', answer: '+44 7874 037109' },
        { question: 'Email', answer: 'a@b.com' },
        { question: 'Invitee Time Zone', answer: 'UK, Ireland, Lisbon' },
      ])
    );
    expect(result).toBe('Snapped Denture');
  });

  it('skips empty answers', () => {
    expect(
      intakeSummary(
        makeRow([
          { question: 'Repair Type', answer: 'Snapped Denture' },
          { question: 'Notes', answer: '' },
          { question: 'Comment', answer: '   ' },
        ])
      )
    ).toBe('Snapped Denture');
  });

  it('filterCareIntake preserves order of care answers', () => {
    const filtered = filterCareIntake([
      { question: 'Contact Number', answer: '+44...' },
      { question: 'Appliance', answer: 'Retainer' },
      { question: 'Phone', answer: '+44...' },
      { question: 'Arch', answer: 'Lower' },
    ]);
    expect(filtered).toEqual([
      { question: 'Appliance', answer: 'Retainer' },
      { question: 'Arch', answer: 'Lower' },
    ]);
  });
});
