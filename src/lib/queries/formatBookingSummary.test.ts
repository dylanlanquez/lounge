import { describe, expect, it } from 'vitest';
import {
  archToAnatomy,
  eventTypeCategory,
  formatArchedAppliance,
  formatBookingSummary,
  formatNativeBookingSummary,
  normaliseArchKey,
  properCase,
} from './appointments.ts';
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
  source: 'calendly',
  event_type_label,
  service_type: null,
  product_key: null,
  repair_variant: null,
  arch: null,
  brand_id: null,
  staff_account_id: null,
  notes: null,
  intake,
  join_url: null,
  deposit_pence: null,
  deposit_currency: null,
  deposit_provider: null,
  deposit_status: null,
  paid_in_full_at_booking: false,
  patient_first_name: null,
  patient_last_name: null,
  patient_email: null,
  patient_phone: null,
  staff_first_name: null,
  staff_last_name: null,
  phases: [],
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
  it('Denture Repairs + Snapped Denture → "Snapped Denture" (denture word already present)', () => {
    expect(
      formatBookingSummary(makeRow('Denture Repairs', [{ question: 'Repair Type', answer: 'Snapped Denture' }]))
    ).toBe('Snapped Denture');
  });

  it('Denture Repairs + Broken Tooth → "Denture Broken Tooth" (prefix added)', () => {
    expect(
      formatBookingSummary(makeRow('Denture Repairs', [{ question: 'Repair Type', answer: 'Broken Tooth' }]))
    ).toBe('Denture Broken Tooth');
  });

  it('Denture Repairs + Broken Tooth + Top → "Upper Denture Broken Tooth"', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Broken Tooth' },
          { question: 'Arch', answer: 'Top' },
        ])
      )
    ).toBe('Upper Denture Broken Tooth');
  });

  it('Denture Repairs + Cracked Denture + Both → "Upper & Lower Cracked Denture" (repair branch keeps singular)', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Cracked Denture' },
          { question: 'Arch', answer: 'Both' },
        ])
      )
    ).toBe('Upper & Lower Cracked Denture');
  });

  it('Denture Repairs + Broken Tooth + Both → "Upper & Lower Denture Broken Tooth" (irregular plural skipped)', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Broken Tooth' },
          { question: 'Arch', answer: 'Both' },
        ])
      )
    ).toBe('Upper & Lower Denture Broken Tooth');
  });

  it('Same-day Appliances + Missing Tooth Retainer + Top → "Same-day upper missing tooth retainer"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Missing Tooth Retainer' },
          { question: 'Which Arch?', answer: 'Top' },
        ])
      )
    ).toBe('Same-day upper missing tooth retainer');
  });

  it('Same-day Appliances + Bottom → "Same-day lower night guard"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Night Guard' },
          { question: 'Arch', answer: 'Bottom' },
        ])
      )
    ).toBe('Same-day lower night guard');
  });

  it('Same-day Click-in Veneers + Top → "Upper Click-in Veneers" (strips Same-day prefix)', () => {
    expect(
      formatBookingSummary(makeRow('Same-day Click-in Veneers', [{ question: 'Arch', answer: 'Top' }]))
    ).toBe('Upper Click-in Veneers');
  });

  it('Same-day Click-in Veneers + Both → "Upper & Lower Click-in Veneers"', () => {
    expect(
      formatBookingSummary(makeRow('Same-day Click-in Veneers', [{ question: 'Arch', answer: 'Both' }]))
    ).toBe('Upper & Lower Click-in Veneers');
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

  it('Virtual Impression + product → "Virtual Impression Appointment for whitening trays"', () => {
    expect(
      formatBookingSummary(
        makeRow('Virtual Impression Appointment', [
          { question: 'What product is the impression for?', answer: 'Whitening Trays' },
        ])
      )
    ).toBe('Virtual Impression Appointment for whitening trays');
  });

  it('In-person Impression + product → "In-person Impression Appointment for retainers"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [
          { question: 'What product is the impression for?', answer: 'Retainers' },
        ])
      )
    ).toBe('In-person Impression Appointment for retainers');
  });

  it('Impression event keeps the impression label even when product question is generic', () => {
    expect(
      formatBookingSummary(
        makeRow('Virtual Impression Appointment', [
          { question: 'Service', answer: 'Bleaching trays' },
        ])
      )
    ).toBe('Virtual Impression Appointment for bleaching trays');
  });

  // Arch phrasing on impression appointments — Dylan flagged the bare
  // "for upper" / "for lower" / "for upper and lower" the previous
  // formatter produced. The natural-English forms are "for upper arch"
  // / "for lower arch" / "for both arches".
  it('In-person Impression + Upper arch (no item) → "...for upper arch"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [{ question: 'Arch', answer: 'Top' }]),
      ),
    ).toBe('In-person Impression Appointment for upper arch');
  });

  it('In-person Impression + Lower arch (no item) → "...for lower arch"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [{ question: 'Arch', answer: 'Bottom' }]),
      ),
    ).toBe('In-person Impression Appointment for lower arch');
  });

  it('In-person Impression + Both arches (no item) → "...for both arches"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [{ question: 'Arch', answer: 'Both' }]),
      ),
    ).toBe('In-person Impression Appointment for both arches');
  });

  it('In-person Impression + Upper + product → "...for upper arch, whitening trays"', () => {
    expect(
      formatBookingSummary(
        makeRow('In-person Impression Appointment', [
          { question: 'Arch', answer: 'Top' },
          { question: 'What product is the impression for?', answer: 'Whitening Trays' },
        ]),
      ),
    ).toBe('In-person Impression Appointment for upper arch, whitening trays');
  });

  it('Virtual Impression + Both + product → "...for both arches, retainers"', () => {
    expect(
      formatBookingSummary(
        makeRow('Virtual Impression Appointment', [
          { question: 'Arch', answer: 'Both' },
          { question: 'What product is the impression for?', answer: 'Retainers' },
        ]),
      ),
    ).toBe('Virtual Impression Appointment for both arches, retainers');
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
    ).toBe('Same-day upper night guard');
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
    ).toBe('Same-day upper & lower sports guards');
  });

  it('falls back to answer-pattern arch detection when question is unrecognised', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance type', answer: 'Retainer' },
          { question: 'Anything else?', answer: 'Top' }, // unrecognised question, but answer is clearly arch
        ])
      )
    ).toBe('Same-day upper retainer');
  });

  it('handles multi-line "Top\\nBottom" answers as "Same-day upper & lower retainers"', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Retainer' },
          { question: 'Which Arch?', answer: 'Top\nBottom' },
        ])
      )
    ).toBe('Same-day upper & lower retainers');
  });

  it('comma-joins multi-select repair-type answers and prepends Denture', () => {
    expect(
      formatBookingSummary(
        makeRow('Denture Repairs', [
          { question: 'Repair Type', answer: 'Broken Tooth/Teeth\nRelining (Upper or Lower)' },
        ])
      )
    ).toBe('Denture Broken Tooth/Teeth, Relining (Upper or Lower)');
  });

  it('comma-joins multi-select appliances with arch', () => {
    expect(
      formatBookingSummary(
        makeRow('Same-day Appliances', [
          { question: 'Appliance', answer: 'Retainer\nNight Guard' },
          { question: 'Which Arch?', answer: 'Top' },
        ])
      )
    ).toBe('Same-day upper retainer, night guard');
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

describe('properCase', () => {
  it.each([
    ['amanda bryce', 'Amanda Bryce'],
    ['naheem shafiq', 'Naheem Shafiq'],
    ['stephen green', 'Stephen Green'],
    ['John Smith', 'John Smith'],
    ['AMANDA SOLANKE', 'Amanda Solanke'],
    ['MARK WRIGLEY', 'Mark Wrigley'],
    ['DARREN WINTER', 'Darren Winter'],
    ['Micheal DPD', 'Micheal Dpd'],          // short all-caps surnames are SHOUTED data, fix them
    ['McDonald', 'McDonald'],                 // mixed-case preserved
    ['mary-jane', 'Mary-Jane'],
    ["o'brien", "O'Brien"],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ] as const)('properCase("%s") → "%s"', (input, expected) => {
    expect(properCase(input)).toBe(expected);
  });
});

describe('eventTypeCategory', () => {
  it.each([
    ['Denture Repairs', 'repair'],
    ['Same-day Click-in Veneers', 'sameDay'],
    ['Same-day Appliances', 'appliance'],
    ['Virtual Impression Appointment', 'virtualImpression'],
    ['In-person Impression Appointment', 'impression'],
    ['Initial Consultation', 'consult'],
    [null, 'consult'],
    [undefined, 'consult'],
    ['', 'consult'],
  ] as const)('maps "%s" → %s', (label, expected) => {
    expect(eventTypeCategory(label)).toBe(expected);
  });
});

describe('normaliseArchKey', () => {
  it.each([
    ['upper', 'upper'],
    ['Upper', 'upper'],
    ['Top', 'upper'],
    ['lower', 'lower'],
    ['Bottom', 'lower'],
    ['both', 'both'],
    ['Both', 'both'],
    ['Full mouth', 'both'],
    ['Upper and Lower', 'both'],
    ['Top\nBottom', 'both'],
    [null, null],
    ['', null],
  ] as const)('maps "%s" → %s', (input, expected) => {
    expect(normaliseArchKey(input)).toBe(expected);
  });
});

describe('formatArchedAppliance', () => {
  it('upper → "Upper retainer"', () => {
    expect(formatArchedAppliance('upper', 'retainer')).toBe('Upper retainer');
  });
  it('lower → "Lower night guard"', () => {
    expect(formatArchedAppliance('lower', 'night guard')).toBe('Lower night guard');
  });
  it('both + retainer → "Upper & lower retainers" (sentence, pluralised)', () => {
    expect(formatArchedAppliance('both', 'retainer')).toBe('Upper & lower retainers');
  });
  it('both + night guard → "Upper & lower night guards"', () => {
    expect(formatArchedAppliance('both', 'night guard')).toBe('Upper & lower night guards');
  });
  it('both + click-in veneers → "Upper & lower click-in veneers" (already plural)', () => {
    expect(formatArchedAppliance('both', 'click-in veneers')).toBe(
      'Upper & lower click-in veneers',
    );
  });
  it('both + Retainer title case → "Upper & Lower Retainers"', () => {
    expect(formatArchedAppliance('both', 'Retainer', 'title')).toBe('Upper & Lower Retainers');
  });
  it('both + Click-in Veneers title case → "Upper & Lower Click-in Veneers"', () => {
    expect(formatArchedAppliance('both', 'Click-in Veneers', 'title')).toBe(
      'Upper & Lower Click-in Veneers',
    );
  });
  it('both + Broken Tooth + no plural → "Upper & Lower Broken Tooth"', () => {
    expect(
      formatArchedAppliance('both', 'Broken Tooth', 'title', { pluraliseForBoth: false }),
    ).toBe('Upper & Lower Broken Tooth');
  });
  it('null arch → noun unchanged', () => {
    expect(formatArchedAppliance(null, 'retainer')).toBe('retainer');
  });
});

describe('formatNativeBookingSummary', () => {
  const makeNative = (
    service_type: string | null,
    arch: string | null,
    product_key: string | null,
    event_type_label: string | null = null,
  ) => ({ service_type, arch, product_key, event_type_label });

  it('same_day_appliance + retainer + upper → "Same-day upper retainer"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'upper', 'retainer')),
    ).toBe('Same-day upper retainer');
  });

  it('same_day_appliance + retainer + lower → "Same-day lower retainer"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'lower', 'retainer')),
    ).toBe('Same-day lower retainer');
  });

  it('same_day_appliance + retainer + both → "Same-day upper & lower retainers"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'both', 'retainer')),
    ).toBe('Same-day upper & lower retainers');
  });

  it('same_day_appliance + night_guard + both → "Same-day upper & lower night guards"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'both', 'night_guard')),
    ).toBe('Same-day upper & lower night guards');
  });

  it('same_day_appliance + missing_tooth + both → "Same-day upper & lower missing tooth retainers"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'both', 'missing_tooth')),
    ).toBe('Same-day upper & lower missing tooth retainers');
  });

  it('same_day_appliance + whitening_kit (no arch) → "Same-day whitening kit"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', null, 'whitening_kit')),
    ).toBe('Same-day whitening kit');
  });

  it('same_day_appliance + whitening_tray + upper → "Same-day upper whitening tray"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'upper', 'whitening_tray')),
    ).toBe('Same-day upper whitening tray');
  });

  it('same_day_appliance + aligner + lower → "Same-day lower replacement aligner"', () => {
    expect(
      formatNativeBookingSummary(makeNative('same_day_appliance', 'lower', 'aligner')),
    ).toBe('Same-day lower replacement aligner');
  });

  it('click_in_veneers + upper → "Upper Click-in veneers" (no Same-day prefix)', () => {
    expect(
      formatNativeBookingSummary(makeNative('click_in_veneers', 'upper', null)),
    ).toBe('Upper Click-in veneers');
  });

  it('click_in_veneers + both → "Upper & lower Click-in veneers" (no Same-day prefix)', () => {
    expect(
      formatNativeBookingSummary(makeNative('click_in_veneers', 'both', null)),
    ).toBe('Upper & lower Click-in veneers');
  });

  it('denture_repair (no arch) → "Denture repair"', () => {
    expect(
      formatNativeBookingSummary(makeNative('denture_repair', null, null)),
    ).toBe('Denture repair');
  });

  it('in_person_impression_appointment + retainer + both → impression-style "for both arches, retainers"', () => {
    expect(
      formatNativeBookingSummary(
        makeNative('in_person_impression_appointment', 'both', 'retainer'),
      ),
    ).toBe('In-person impression appointment for both arches, retainers');
  });

  it('virtual_impression_appointment + upper (no product) → "for upper arch"', () => {
    expect(
      formatNativeBookingSummary(
        makeNative('virtual_impression_appointment', 'upper', null),
      ),
    ).toBe('Virtual impression appointment for upper arch');
  });

  it('falls back to event_type_label when service_type is unrecognised', () => {
    expect(
      formatNativeBookingSummary(
        makeNative('exotic_new_service', 'lower', null, 'Exotic new service'),
      ),
    ).toBe('Lower Exotic new service');
  });
});
