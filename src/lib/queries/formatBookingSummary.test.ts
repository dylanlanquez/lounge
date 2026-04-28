import { describe, expect, it } from 'vitest';
import { archToAnatomy, eventTypeCategory, formatBookingSummary } from './appointments.ts';
import type { AppointmentRow, IntakeAnswer } from './appointments.ts';

const makeRow = (
  event_type_label: string | null,
  intake: IntakeAnswer[] | null
): AppointmentRow => ({
  id: 'a',
  patient_id: 'p',
  location_id: 'l',
  start_at: '2026-04-28T09:00:00Z',
  end_at: '2026-04-28T10:00:00Z',
  status: 'booked',
  event_type_label,
  staff_account_id: null,
  intake,
  join_url: null,
  patient_first_name: null,
  patient_last_name: null,
  patient_email: null,
  patient_phone: null,
  staff_first_name: null,
  staff_last_name: null,
});

describe('archToAnatomy', () => {
  it('maps Top → Upper', () => expect(archToAnatomy('Top')).toBe('Upper'));
  it('maps Bottom → Lower', () => expect(archToAnatomy('Bottom')).toBe('Lower'));
  it('maps Upper → Upper', () => expect(archToAnatomy('Upper')).toBe('Upper'));
  it('maps Lower → Lower', () => expect(archToAnatomy('Lower')).toBe('Lower'));
  it('maps Both → Upper and Lower', () => expect(archToAnatomy('Both')).toBe('Upper and Lower'));
  it('maps Full Mouth → Upper and Lower', () => expect(archToAnatomy('Full mouth')).toBe('Upper and Lower'));
  it('maps "Top, Bottom" → Upper and Lower', () => expect(archToAnatomy('Top, Bottom')).toBe('Upper and Lower'));
  it('maps "Upper and Lower" → Upper and Lower', () => expect(archToAnatomy('Upper and Lower')).toBe('Upper and Lower'));
  it('handles null/empty', () => {
    expect(archToAnatomy(null)).toBeUndefined();
    expect(archToAnatomy('')).toBeUndefined();
    expect(archToAnatomy('   ')).toBeUndefined();
  });
});

describe('formatBookingSummary', () => {
  it('Denture Repairs + Snapped Denture → "Snapped Denture"', () => {
    expect(
      formatBookingSummary(makeRow('Denture Repairs', [{ question: 'Repair Type', answer: 'Snapped Denture' }]))
    ).toBe('Snapped Denture');
  });

  it('Same-day Appliances + Missing Tooth Retainer + Top → "Upper Missing Tooth Retainer"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Missing Tooth Retainer' },
          { question: 'Which Arch?', answer: 'Top' },
        ])
      )
    ).toBe('Upper Missing Tooth Retainer');
  });

  it('Same-day Appliances + Bottom → "Lower Night Guard"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Night Guard' },
          { question: 'Arch', answer: 'Bottom' },
        ])
      )
    ).toBe('Lower Night Guard');
  });

  it('Same-day Click-in Veneers + Top → "Upper Click-in Veneers" (strips Same-day prefix)', () => {
    expect(
      formatBookingSummary(makeRow('Same-day Click-in Veneers', [{ question: 'Arch', answer: 'Top' }]))
    ).toBe('Upper Click-in Veneers');
  });

  it('Same-day Click-in Veneers + Both → "Upper and Lower Click-in Veneers"', () => {
    expect(
      formatBookingSummary(makeRow('Same-day Click-in Veneers', [{ question: 'Arch', answer: 'Both' }]))
    ).toBe('Upper and Lower Click-in Veneers');
  });

  it('Virtual Impression with no intake → full event label', () => {
    expect(formatBookingSummary(makeRow('Virtual Impression Appointment', null))).toBe(
      'Virtual Impression Appointment'
    );
  });

  it('In-person Impression with empty intake → full event label', () => {
    expect(formatBookingSummary(makeRow('In-person Impression Appointment', []))).toBe(
      'In-person Impression Appointment'
    );
  });

  it('Virtual Impression + product → "Virtual Impression Appointment for Whitening Trays"', () => {
    expect(
      formatBookingSummary(
        makeRow('Virtual Impression Appointment', [
          { question: 'What product is the impression for?', answer: 'Whitening Trays' },
        ])
      )
    ).toBe('Virtual Impression Appointment for Whitening Trays');
  });

  it('In-person Impression + product → "In-person Impression Appointment for Retainers"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [
          { question: 'What product is the impression for?', answer: 'Retainers' },
        ])
      )
    ).toBe('In-person Impression Appointment for Retainers');
  });

  it('Impression event keeps the impression label even when product question is generic', () => {
    expect(
      formatBookingSummary(
        makeRow('Virtual Impression Appointment', [
          { question: 'Service', answer: 'Bleaching trays' },
        ])
      )
    ).toBe('Virtual Impression Appointment for Bleaching trays');
  });

  it('ignores contact-only intake fields', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Cracked Denture' },
          { question: 'Contact Number', answer: '+44 7700 900123' },
          { question: 'Email', answer: 'a@b.com' },
        ])
      )
    ).toBe('Cracked Denture');
  });

  it('falls back to joining all answers when no recognised question', () => {
    expect(
      formatBookingSummary(
        makeRow('Custom Event', [{ question: 'Notes', answer: 'Special prep needed' }])
      )
    ).toBe('Special prep needed');
  });

  it('returns empty string when nothing usable', () => {
    expect(formatBookingSummary(makeRow(null, null))).toBe('');
  });

  it('matches arch when question is "Upper or Lower?"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Night Guard' },
          { question: 'Upper or Lower?', answer: 'Top' },
        ])
      )
    ).toBe('Upper Night Guard');
  });

  it('matches arch when question is "Top or Bottom?"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Click-in Veneers', [{ question: 'Top or Bottom?', answer: 'Bottom' }])
      )
    ).toBe('Lower Click-in Veneers');
  });

  it('matches arch when question is "Which jaw?"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Sports guard' },
          { question: 'Which jaw?', answer: 'Both' },
        ])
      )
    ).toBe('Upper and Lower Sports guard');
  });

  it('falls back to answer-pattern arch detection when question is unrecognised', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance type', answer: 'Retainer' },
          { question: 'Anything else?', answer: 'Top' }, // unrecognised question, but answer is clearly arch
        ])
      )
    ).toBe('Upper Retainer');
  });

  it('handles multi-line "Top\\nBottom" answers as Upper and Lower', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Retainer' },
          { question: 'Which Arch?', answer: 'Top\nBottom' },
        ])
      )
    ).toBe('Upper and Lower Retainer');
  });

  it('comma-joins multi-select repair-type answers', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Broken Tooth/Teeth\nRelining (Upper or Lower)' },
        ])
      )
    ).toBe('Broken Tooth/Teeth, Relining (Upper or Lower)');
  });

  it('comma-joins multi-select appliances with arch', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Retainer\nNight Guard' },
          { question: 'Which Arch?', answer: 'Top' },
        ])
      )
    ).toBe('Upper Retainer, Night Guard');
  });

  it('strips empty lines and extra whitespace from multi-select', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: '  Cracked Denture\n\n  Snapped Denture  \n' },
        ])
      )
    ).toBe('Cracked Denture, Snapped Denture');
  });
});

describe('eventTypeCategory', () => {
  it.each([
    ['Denture Repairs', 'repair'],
    ['Same-day Click-in Veneers', 'sameDay'],
    ['Same-day Appliances', 'appliance'],
    ['Virtual Impression Appointment', 'impression'],
    ['In-person Impression Appointment', 'impression'],
    ['Initial Consultation', 'consult'],
    [null, 'consult'],
    [undefined, 'consult'],
    ['', 'consult'],
  ] as const)('maps "%s" → %s', (label, expected) => {
    expect(eventTypeCategory(label)).toBe(expected);
  });
});
