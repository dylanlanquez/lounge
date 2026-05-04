import { describe, expect, it } from 'vitest';
import {
  inferServiceTypeFromEventLabel,
  requiredSectionsForServiceTypes,
  sectionSignatureState,
  suggestNextVersion,
  summariseWaiverFlag,
  type WaiverSection,
  type WaiverSignatureSummary,
} from './waiver.ts';

const sections: WaiverSection[] = [
  {
    key: 'general',
    title: 'Privacy and consent',
    terms: ['…'],
    version: '2026-04-28-v1',
    applies_to_service_type: null,
    sort_order: 10,
    active: true,
  },
  {
    key: 'denture',
    title: 'Denture services',
    terms: ['…'],
    version: '2026-04-28-v1',
    applies_to_service_type: 'denture_repair',
    sort_order: 20,
    active: true,
  },
  {
    key: 'appliance',
    title: 'Appliances',
    terms: ['…'],
    version: '2026-04-28-v1',
    applies_to_service_type: 'same_day_appliance',
    sort_order: 30,
    active: true,
  },
  {
    key: 'click_in_veneers',
    title: 'Click-in veneers',
    terms: ['…'],
    version: '2026-04-28-v1',
    applies_to_service_type: 'click_in_veneers',
    sort_order: 40,
    active: true,
  },
];

describe('requiredSectionsForServiceTypes', () => {
  it('always includes the general section even with no services', () => {
    expect(requiredSectionsForServiceTypes([], sections).map((s) => s.key)).toEqual(['general']);
  });

  it('adds denture when denture_repair is in the cart', () => {
    expect(
      requiredSectionsForServiceTypes(['denture_repair'], sections).map((s) => s.key)
    ).toEqual(['general', 'denture']);
  });

  it('adds appliance and click_in_veneers when both are in the cart', () => {
    expect(
      requiredSectionsForServiceTypes(
        ['same_day_appliance', 'click_in_veneers'],
        sections
      ).map((s) => s.key)
    ).toEqual(['general', 'appliance', 'click_in_veneers']);
  });

  it('deduplicates repeated service types', () => {
    expect(
      requiredSectionsForServiceTypes(
        ['denture_repair', 'denture_repair'],
        sections
      ).map((s) => s.key)
    ).toEqual(['general', 'denture']);
  });

  it('sorts the output by sort_order ascending', () => {
    const out = requiredSectionsForServiceTypes(
      ['click_in_veneers', 'denture_repair'],
      sections
    );
    expect(out.map((s) => s.sort_order)).toEqual([10, 20, 40]);
  });

  it('skips inactive sections', () => {
    const inactive = sections.map((s) =>
      s.key === 'denture' ? { ...s, active: false } : s
    );
    expect(
      requiredSectionsForServiceTypes(['denture_repair'], inactive).map((s) => s.key)
    ).toEqual(['general']);
  });

  it('ignores null/undefined service types', () => {
    expect(
      requiredSectionsForServiceTypes([null, undefined, 'denture_repair'], sections).map(
        (s) => s.key
      )
    ).toEqual(['general', 'denture']);
  });
});

describe('inferServiceTypeFromEventLabel', () => {
  it('maps denture-repair-like labels to denture_repair', () => {
    expect(inferServiceTypeFromEventLabel('Denture Repairs')).toBe('denture_repair');
    expect(inferServiceTypeFromEventLabel('Virtual Denture Repair')).toBe('denture_repair');
  });

  it('maps appliance-related labels to same_day_appliance', () => {
    expect(inferServiceTypeFromEventLabel('Same-day Appliance')).toBe('same_day_appliance');
    expect(inferServiceTypeFromEventLabel('Whitening trays')).toBe('same_day_appliance');
    expect(inferServiceTypeFromEventLabel('Night guard fitting')).toBe('same_day_appliance');
  });

  it('maps in-person impression labels to impression_appointment (own waiver bucket)', () => {
    expect(inferServiceTypeFromEventLabel('In-person Impression Appointment')).toBe(
      'impression_appointment'
    );
    expect(inferServiceTypeFromEventLabel('Impression Appointment')).toBe(
      'impression_appointment'
    );
  });

  it('maps virtual impression labels to virtual_impression_appointment', () => {
    expect(inferServiceTypeFromEventLabel('Virtual Impression Appointment')).toBe(
      'virtual_impression_appointment'
    );
    expect(inferServiceTypeFromEventLabel('Impression — Virtual')).toBe(
      'virtual_impression_appointment'
    );
  });

  it('maps click-in-veneers labels to click_in_veneers', () => {
    expect(inferServiceTypeFromEventLabel('Click-in Veneers')).toBe('click_in_veneers');
  });

  it('returns null for unrecognised or empty labels', () => {
    expect(inferServiceTypeFromEventLabel(null)).toBeNull();
    expect(inferServiceTypeFromEventLabel('')).toBeNull();
    expect(inferServiceTypeFromEventLabel('Consultation')).toBeNull();
  });
});

describe('sectionSignatureState', () => {
  const denture = sections.find((s) => s.key === 'denture')!;

  it('returns "missing" when patient has never signed', () => {
    expect(sectionSignatureState(denture, new Map())).toBe('missing');
  });

  it('returns "current" when latest signature matches the section version', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['denture', { section_key: 'denture', section_version: '2026-04-28-v1', signed_at: '2026-04-28T10:00:00Z' }],
    ]);
    expect(sectionSignatureState(denture, latest)).toBe('current');
  });

  it('returns "stale" when latest signature is at an older version', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['denture', { section_key: 'denture', section_version: '2025-01-01-v1', signed_at: '2025-02-01T10:00:00Z' }],
    ]);
    expect(sectionSignatureState(denture, latest)).toBe('stale');
  });
});

describe('summariseWaiverFlag', () => {
  const required = requiredSectionsForServiceTypes(['denture_repair'], sections);

  it('returns "ready" when every required section is current', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['general', { section_key: 'general', section_version: '2026-04-28-v1', signed_at: '2026-04-28T10:00:00Z' }],
      ['denture', { section_key: 'denture', section_version: '2026-04-28-v1', signed_at: '2026-04-28T10:00:00Z' }],
    ]);
    const out = summariseWaiverFlag(required, latest);
    expect(out.status).toBe('ready');
    expect(out.missingSections).toHaveLength(0);
    expect(out.staleSections).toHaveLength(0);
  });

  it('returns "none" when nothing has been signed', () => {
    const out = summariseWaiverFlag(required, new Map());
    expect(out.status).toBe('none');
    expect(out.missingSections.map((s) => s.key)).toEqual(['general', 'denture']);
  });

  it('returns "stale" when all required sections are signed but version-stale', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['general', { section_key: 'general', section_version: 'old', signed_at: '2025-01-01T10:00:00Z' }],
      ['denture', { section_key: 'denture', section_version: 'old', signed_at: '2025-01-01T10:00:00Z' }],
    ]);
    const out = summariseWaiverFlag(required, latest);
    expect(out.status).toBe('stale');
    expect(out.staleSections.map((s) => s.key)).toEqual(['general', 'denture']);
  });

  it('returns "partial" when one section is current and another is missing', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['general', { section_key: 'general', section_version: '2026-04-28-v1', signed_at: '2026-04-28T10:00:00Z' }],
    ]);
    const out = summariseWaiverFlag(required, latest);
    expect(out.status).toBe('partial');
    expect(out.missingSections.map((s) => s.key)).toEqual(['denture']);
  });

  it('returns "partial" when some are stale and others current', () => {
    const latest = new Map<string, WaiverSignatureSummary>([
      ['general', { section_key: 'general', section_version: '2026-04-28-v1', signed_at: '2026-04-28T10:00:00Z' }],
      ['denture', { section_key: 'denture', section_version: 'old', signed_at: '2025-01-01T10:00:00Z' }],
    ]);
    const out = summariseWaiverFlag(required, latest);
    expect(out.status).toBe('partial');
    expect(out.staleSections.map((s) => s.key)).toEqual(['denture']);
    expect(out.missingSections).toHaveLength(0);
  });
});

describe('suggestNextVersion', () => {
  it('increments the suffix when current version is from today', () => {
    const today = new Date('2026-04-28T10:00:00Z');
    expect(suggestNextVersion('2026-04-28-v1', today)).toBe('2026-04-28-v2');
    expect(suggestNextVersion('2026-04-28-v9', today)).toBe('2026-04-28-v10');
  });

  it('resets to v1 under today when current version is from a previous day', () => {
    const today = new Date('2026-04-28T10:00:00Z');
    expect(suggestNextVersion('2026-04-15-v3', today)).toBe('2026-04-28-v1');
  });

  it('falls back to today + v1 for empty or non-conforming strings', () => {
    const today = new Date('2026-04-28T10:00:00Z');
    expect(suggestNextVersion('', today)).toBe('2026-04-28-v1');
    expect(suggestNextVersion('arbitrary', today)).toBe('2026-04-28-v1');
  });
});
