// ─────────────────────────────────────────────────────────────────────────────
// Card model for PatientFilesGrid.
//
// Pure functions, no React, no Supabase. Split out of
// PatientFilesGrid.tsx so the slot-derivation and file-bucketing rules
// can be unit tested against plain rows, the same way
// aggregateMarketingContent is tested without a live response.
//
// Two steps, in order:
//   deriveSlotDefs(labels)      Meridian's file_labels catalogue → the
//                               fixed slot cards the grid offers.
//   buildCards(files, slotDefs) patient_files rows → the cards actually
//                               rendered, filled first, empties tailing.
// ─────────────────────────────────────────────────────────────────────────────

import type { PatientFileLabelRow } from '../../lib/queries/patientFiles.ts';
import type { PatientFileEntry } from '../../lib/queries/patientProfile.ts';

export interface SlotDef {
  group: string;
  label: string;
  subLabelKeys: string[];
  // The four photo slots are uploadable from Lounge — staff can take
  // or pick a photo on the kiosk and the row writes a fresh
  // patient_files row at the slot's primary label_key. The lab-derived
  // slots (arch scans, bite, x-ray) stay view-only; those uploads
  // happen via Meridian / scanner equipment.
  uploadable?: boolean;
  // Primary label_key used when uploading from Lounge.
  primaryKey: string;
}

// Label keys that belong on the kiosk's capture-from-camera path. Every
// other label is lab-derived (Meridian uploads it via scanners). When
// Meridian adds a brand-new photo slot, drop the key here too so the
// kiosk's CapturePopup can fill it.
export const UPLOADABLE_KEYS = new Set([
  'full_face_photo',
  'smile_photo_front',
  'smile_photo_left',
  'smile_photo_right',
]);

// Label keys owned by the galleries further up the patient profile:
// before/after photos render in BeforeAfterGallery, marketing assets
// in MarketingGallery. Both galleries receive the SAME unfiltered
// files array this grid does, so these keys have to be suppressed on
// two axes, not one:
//
//   * no fixed slot card (handled via LABELS_RENDERED_ELSEWHERE), and
//   * no dynamic 'other_*' card either — buildCards buckets any file
//     whose label has no slot into an other_<key> group and renders
//     it, which would show every before/after photo twice on the
//     profile once the labels exist in the catalogue.
//
// 'after_photo' was missing from the original suppression list. It
// went unnoticed because the label was absent from file_labels
// entirely, so no after photo could ever be uploaded.
export const LABELS_OWNED_BY_GALLERIES = new Set([
  'before_photo',
  'after_photo',
  'marketing_content',
]);

// Label keys that never render as a fixed slot in the grid. The
// gallery-owned keys plus "other", the catch-all bucket the dynamic
// fall-through in buildCards manages on its own.
export const LABELS_RENDERED_ELSEWHERE = new Set([...LABELS_OWNED_BY_GALLERIES, 'other']);

// Existing slot groupings that historically bundled multiple file_label
// keys under a single card (e.g. "Upper Arch" shows both upper_arch
// scans AND upper_arch_opposing reference files). The key in this map
// is a file_label.key, the value is the group the slot lives under.
// Anything not in the map gets its own dedicated slot, which means
// when Meridian adds a fresh label (Bite Scan Second, etc) it shows
// up automatically as its own card without code changes here.
export const GROUP_ALIASES: Record<string, string> = {
  upper_arch_opposing: 'upper_arch',
  lower_arch_opposing: 'lower_arch',
  both_arches: 'bite_registration',
  xray_periapical: 'xray_panoramic',
  reference_previous_work: 'xray_panoramic',
  patient_reference_image: 'xray_panoramic',
};

// Build the slot list from Meridian's file_labels catalogue. Order
// follows file_labels.sort_order, with photo / uploadable slots pulled
// to the front so the receptionist's tap-to-add targets are the first
// cards in the horizontal row. Labels grouped via GROUP_ALIASES
// collapse into their canonical slot rather than rendering separately.
export function deriveSlotDefs(labels: ReadonlyArray<PatientFileLabelRow>): SlotDef[] {
  const byGroup = new Map<string, SlotDef>();
  // First pass: every canonical (non-aliased) label gets a slot.
  for (const lbl of labels) {
    if (LABELS_RENDERED_ELSEWHERE.has(lbl.key)) continue;
    if (GROUP_ALIASES[lbl.key]) continue;
    byGroup.set(lbl.key, {
      group: lbl.key,
      label: lbl.label,
      subLabelKeys: [lbl.key],
      primaryKey: lbl.key,
      uploadable: UPLOADABLE_KEYS.has(lbl.key),
    });
  }
  // Second pass: alias labels attach to their canonical slot. If the
  // canonical slot isn't in the catalogue yet (e.g. only the alias is
  // active), the alias is promoted to its own slot so the file still
  // surfaces.
  for (const lbl of labels) {
    if (LABELS_RENDERED_ELSEWHERE.has(lbl.key)) continue;
    const alias = GROUP_ALIASES[lbl.key];
    if (!alias) continue;
    const canonical = byGroup.get(alias);
    if (canonical) {
      canonical.subLabelKeys.push(lbl.key);
    } else {
      byGroup.set(lbl.key, {
        group: lbl.key,
        label: lbl.label,
        subLabelKeys: [lbl.key],
        primaryKey: lbl.key,
        uploadable: UPLOADABLE_KEYS.has(lbl.key),
      });
    }
  }
  const out = Array.from(byGroup.values());
  // Sort: uploadable photo slots first (receptionist-actionable),
  // then everything else by the catalogue's sort_order. Falls back
  // to alphabetical when sort_order is missing.
  const sortOrderByKey = new Map<string, number>();
  for (const lbl of labels) sortOrderByKey.set(lbl.key, lbl.sort_order ?? 9999);
  out.sort((a, b) => {
    if (!!a.uploadable !== !!b.uploadable) return a.uploadable ? -1 : 1;
    const ao = sortOrderByKey.get(a.primaryKey) ?? 9999;
    const bo = sortOrderByKey.get(b.primaryKey) ?? 9999;
    if (ao !== bo) return ao - bo;
    return a.label.localeCompare(b.label);
  });
  return out;
}

export interface FileCardModel {
  group: string;
  label: string;
  // The file shown on the card face. Null for empty slots.
  file: PatientFileEntry | null;
  // Total number of versions for this slot (counts every file mapped to
  // the slot's labels, not just the visible one).
  versionCount: number;
  // Every version, newest first. Powers the History modal.
  versions: PatientFileEntry[];
  // Set on slots staff can fill from the kiosk (the four photo slots).
  // Drives the empty-card upload affordance + click handler. Includes
  // the canonical primary label_key so the upload writes to the right
  // bucket.
  uploadable?: { primaryKey: string };
}

// The subset of a patient's files this grid is responsible for.
//
// The patient profile hands the same unfiltered array to
// BeforeAfterGallery, MarketingGallery and this grid, so callers need
// this to keep a visible file count honest: without it the "Patient
// files" header counts photos that render in a gallery further up the
// page and never appear as a card down here.
export function filesForGrid(files: PatientFileEntry[]): PatientFileEntry[] {
  return files.filter((f) => !LABELS_OWNED_BY_GALLERIES.has(f.label_key ?? ''));
}

export function buildCards(
  files: PatientFileEntry[],
  slotDefs: ReadonlyArray<SlotDef>,
): FileCardModel[] {
  // Rebuild the label-key → group lookup each render against the live
  // slot list. The map collapses every sub-label key (upper_arch_opposing
  // → upper_arch) onto the slot that owns it so files bucket correctly.
  const labelToGroup: Record<string, string> = {};
  for (const def of slotDefs) {
    for (const k of def.subLabelKeys) labelToGroup[k] = def.group;
  }

  // Group every file by slot group via its label_key. Files whose label
  // doesn't map to a fixed slot end up in dynamic 'other_*' groups.
  const byGroup = new Map<string, PatientFileEntry[]>();
  const labelDisplayByGroup = new Map<string, string>();

  for (const f of files) {
    const labelKey = f.label_key ?? '';
    // Owned by BeforeAfterGallery / MarketingGallery. Skipped here so
    // the photo does not appear a second time as a dynamic card.
    if (LABELS_OWNED_BY_GALLERIES.has(labelKey)) continue;
    let group = labelToGroup[labelKey];
    let label = f.label_display ?? f.custom_label ?? 'Other';

    if (!group) {
      const customSlug = (f.custom_label ?? '').trim().toLowerCase();
      group = `other_${labelKey || 'unlabelled'}_${customSlug}`;
      label = (f.custom_label && f.custom_label.trim()) || f.label_display || 'Other';
    } else {
      const def = slotDefs.find((d) => d.group === group)!;
      label = def.label;
    }
    labelDisplayByGroup.set(group, label);
    const list = byGroup.get(group) ?? [];
    list.push(f);
    byGroup.set(group, list);
  }

  for (const list of byGroup.values()) {
    list.sort((a, b) => {
      const av = a.version ?? 0;
      const bv = b.version ?? 0;
      if (bv !== av) return bv - av;
      return b.uploaded_at.localeCompare(a.uploaded_at);
    });
  }

  // Build cards in two passes so we can render filled ones first
  // (sorted by latest upload, regardless of slot type) and tuck empty
  // ones at the tail in canonical slot order. The receptionist's eye
  // lands on what's actually on file before the placeholders.
  const filled: FileCardModel[] = [];
  const empty: FileCardModel[] = [];

  for (const def of slotDefs) {
    const versions = byGroup.get(def.group) ?? [];
    const card: FileCardModel = {
      group: def.group,
      label: def.label,
      file: versions[0] ?? null,
      versionCount: versions.length,
      versions,
      uploadable: def.uploadable ? { primaryKey: def.primaryKey } : undefined,
    };
    if (versions.length > 0) filled.push(card);
    else empty.push(card);
  }

  for (const [group, versions] of byGroup.entries()) {
    if (slotDefs.some((d) => d.group === group)) continue;
    if (versions.length === 0) continue;
    filled.push({
      group,
      label: labelDisplayByGroup.get(group) ?? 'Other',
      file: versions[0]!,
      versionCount: versions.length,
      versions,
    });
  }

  filled.sort((a, b) =>
    (b.file?.uploaded_at ?? '').localeCompare(a.file?.uploaded_at ?? '')
  );

  return [...filled, ...empty];
}
