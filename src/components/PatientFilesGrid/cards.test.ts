// Cover for the patient files grid's slot derivation and file
// bucketing, with the before/after + marketing labels present in the
// catalogue.
//
// Those three labels were absent from file_labels until
// 20260907000001_lng_marketing_file_labels_seed.sql, which masked two
// bugs: 'after_photo' was missing from the suppression list, and even
// a suppressed key still rendered its FILES through buildCards' dynamic
// 'other_*' fall-through. Both surfaced only once a before/after photo
// could exist, so they get explicit cover here.

import { describe, expect, it } from 'vitest';
import type { PatientFileLabelRow } from '../../lib/queries/patientFiles.ts';
import type { PatientFileEntry } from '../../lib/queries/patientProfile.ts';
import { buildCards, deriveSlotDefs, filesForGrid } from './cards.ts';

function label(
  key: string,
  labelText: string,
  sort_order: number,
): PatientFileLabelRow {
  return { id: `lbl-${key}`, key, label: labelText, scope: 'patient_file', active: true, sort_order };
}

function file(key: string, id: string, uploaded_at: string): PatientFileEntry {
  return {
    id,
    patient_id: 'p1',
    label_key: key,
    label_display: key,
    custom_label: null,
    file_url: `patient_x/${key}_${id}.jpg`,
    file_name: `${key}.jpg`,
    file_size_bytes: 1024,
    mime_type: 'image/jpeg',
    status: 'active',
    uploaded_at,
    uploaded_by_name: 'Staff',
    version: 1,
    thumbnail_path: null,
  };
}

// The catalogue as it looks once the seed migration has landed.
const CATALOGUE: PatientFileLabelRow[] = [
  label('upper_arch', 'Upper Arch', 10),
  label('lower_arch', 'Lower Arch', 20),
  label('upper_arch_opposing', 'Upper Arch Opposing', 30),
  label('smile_photo_front', 'Smile Photo Front', 40),
  label('before_photo', 'Before photo', 900),
  label('after_photo', 'After photo', 901),
  label('marketing_content', 'Marketing content', 902),
];

describe('deriveSlotDefs — gallery-owned labels never become slots', () => {
  const slots = deriveSlotDefs(CATALOGUE);
  const groups = slots.map((s) => s.group);

  it('offers no slot for before_photo, after_photo or marketing_content', () => {
    expect(groups).not.toContain('before_photo');
    expect(groups).not.toContain('after_photo');
    expect(groups).not.toContain('marketing_content');
  });

  it('still offers the lab and photo slots from the catalogue', () => {
    expect(groups).toContain('upper_arch');
    expect(groups).toContain('lower_arch');
    expect(groups).toContain('smile_photo_front');
  });

  it('keeps alias labels folded into their canonical slot', () => {
    const upper = slots.find((s) => s.group === 'upper_arch');
    expect(upper?.subLabelKeys).toEqual(['upper_arch', 'upper_arch_opposing']);
  });

  it('marks only the kiosk photo slots uploadable', () => {
    expect(slots.find((s) => s.group === 'smile_photo_front')?.uploadable).toBe(true);
    expect(slots.find((s) => s.group === 'upper_arch')?.uploadable).toBe(false);
  });
});

describe('buildCards — gallery photos are not carded twice', () => {
  const slots = deriveSlotDefs(CATALOGUE);

  it('drops before/after/marketing files instead of bucketing them as other_*', () => {
    const cards = buildCards(
      [
        file('before_photo', 'f1', '2026-09-01T10:00:00Z'),
        file('after_photo', 'f2', '2026-09-02T10:00:00Z'),
        file('marketing_content', 'f3', '2026-09-03T10:00:00Z'),
      ],
      slots,
    );
    expect(cards.some((c) => c.group.startsWith('other_'))).toBe(false);
    expect(cards.every((c) => c.file === null)).toBe(true);
  });

  it('still buckets a genuinely unslotted label into an other_* card', () => {
    const cards = buildCards([file('other', 'f4', '2026-09-04T10:00:00Z')], slots);
    const other = cards.filter((c) => c.group.startsWith('other_'));
    expect(other).toHaveLength(1);
    expect(other[0]!.file?.id).toBe('f4');
  });

  it('fills the slot a lab file belongs to, aliases included', () => {
    const cards = buildCards(
      [
        file('upper_arch', 'f5', '2026-09-05T10:00:00Z'),
        file('upper_arch_opposing', 'f6', '2026-09-06T10:00:00Z'),
      ],
      slots,
    );
    const upper = cards.find((c) => c.group === 'upper_arch');
    expect(upper?.versionCount).toBe(2);
    // Newest first: same version number, so uploaded_at decides.
    expect(upper?.file?.id).toBe('f6');
  });

  it('puts filled cards ahead of empty ones', () => {
    const cards = buildCards([file('lower_arch', 'f7', '2026-09-07T10:00:00Z')], slots);
    const firstEmpty = cards.findIndex((c) => c.file === null);
    const lastFilled = cards.map((c) => c.file !== null).lastIndexOf(true);
    expect(lastFilled).toBeLessThan(firstEmpty);
  });
});

describe('filesForGrid — the count the Patient files header shows', () => {
  it('excludes the photos that render in the galleries above', () => {
    const files = [
      file('before_photo', 'f1', '2026-09-01T10:00:00Z'),
      file('after_photo', 'f2', '2026-09-02T10:00:00Z'),
      file('marketing_content', 'f3', '2026-09-03T10:00:00Z'),
      file('upper_arch', 'f4', '2026-09-04T10:00:00Z'),
    ];
    expect(filesForGrid(files).map((f) => f.id)).toEqual(['f4']);
  });

  it('keeps a file whose label_key is null', () => {
    const orphan = { ...file('other', 'f5', '2026-09-05T10:00:00Z'), label_key: null };
    expect(filesForGrid([orphan])).toHaveLength(1);
  });
});
