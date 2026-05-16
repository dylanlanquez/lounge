import { signIntakePhotoUrl } from './bookingIntakePhotos.ts';
import { uploadPatientFile } from './patientFiles.ts';

// Promote a booking's intake smile photos (front / left / right)
// uploaded via the widget into the patient's canonical Smile Photo
// slots on the patient profile.
//
// Flow per kind:
//   1. Sign a temporary URL against lng-booking-intake-photos.
//   2. Fetch the image as a Blob, wrap in a File so the existing
//      uploadPatientFile helper can stream it into case-files.
//   3. Insert a fresh patient_files row at label_key smile_photo_<kind>
//      (Meridian's PatientProfileFiles slot). The slot uses the latest
//      version automatically — re-running this overwrites the canonical
//      photo with the freshest intake image.
//
// Storage semantics: COPY, not reference. The intake bucket may be
// pruned later; the patient profile must keep its own record.
//
// All-or-some semantics: every kind is attempted; per-kind failures are
// captured and returned alongside the success count rather than aborting
// the whole batch. The CLAUDE.md "no silent fallbacks" rule still
// applies — callers MUST surface non-empty `errors` to the user.

export type IntakePhotoKindForPromotion = 'front' | 'left' | 'right';

const KIND_TO_LABEL_KEY: Record<IntakePhotoKindForPromotion, string> = {
  front: 'smile_photo_front',
  left: 'smile_photo_left',
  right: 'smile_photo_right',
};

const KIND_TO_DISPLAY_NAME: Record<IntakePhotoKindForPromotion, string> = {
  front: 'Smile Photo Front',
  left: 'Smile Photo Left',
  right: 'Smile Photo Right',
};

export interface IntakePhotoSource {
  kind: IntakePhotoKindForPromotion;
  filePath: string;
  mimeType: string | null;
}

export interface PromoteResult {
  promoted: IntakePhotoKindForPromotion[];
  errors: Array<{ kind: IntakePhotoKindForPromotion; message: string }>;
}

export async function promoteIntakePhotosToPatientProfile(args: {
  patientId: string;
  patientName: string;
  uploaderAccountId: string | null;
  sources: IntakePhotoSource[];
  /** The Lounge appointment these intake photos came from. Threaded
   *  through to patient_files.source_appointment_id so the
   *  SmilePhotosCard predicate can ask "did THIS appointment promote
   *  a row for this label?" instead of the previous coarse
   *  "is there any row with this label on the patient?" — which
   *  inherited a stale 'Added to patients profile' state any time a
   *  PRIOR appointment had been promoted on the same patient. */
  sourceAppointmentId: string;
}): Promise<PromoteResult> {
  const promoted: IntakePhotoKindForPromotion[] = [];
  const errors: PromoteResult['errors'] = [];

  for (const src of args.sources) {
    try {
      const file = await fetchIntakePhotoAsFile(src);
      await uploadPatientFile({
        patientId: args.patientId,
        patientName: args.patientName,
        file,
        labelKey: KIND_TO_LABEL_KEY[src.kind],
        labelDisplayName: KIND_TO_DISPLAY_NAME[src.kind],
        uploaderAccountId: args.uploaderAccountId,
        sourceAppointmentId: args.sourceAppointmentId,
      });
      promoted.push(src.kind);
    } catch (e) {
      errors.push({
        kind: src.kind,
        message: e instanceof Error ? e.message : 'Unknown failure copying photo.',
      });
    }
  }

  return { promoted, errors };
}

async function fetchIntakePhotoAsFile(src: IntakePhotoSource): Promise<File> {
  const url = await signIntakePhotoUrl(src.filePath, 300);
  if (!url) {
    throw new Error(`Could not sign intake photo URL for ${src.kind}.`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not download ${src.kind} intake photo (HTTP ${response.status}).`,
    );
  }
  const blob = await response.blob();
  // Pick a stable filename so the patient_files row has a sensible
  // file_name for the staff UI ("smile_photo_front.jpg" reads better
  // than a random uuid).
  const ext = pickExtension(src.mimeType, src.filePath, blob.type);
  const filename = `${KIND_TO_LABEL_KEY[src.kind]}.${ext}`;
  // Browsers expose `File` everywhere the staff app runs; this constructor
  // is the canonical way to convert a fetched Blob into a File so the
  // existing uploadPatientFile helper can stamp file_name + size + type.
  return new File([blob], filename, {
    type: blob.type || src.mimeType || 'image/jpeg',
  });
}

function pickExtension(
  mimeType: string | null,
  filePath: string,
  blobType: string,
): string {
  // Prefer the source's stored mime, then the blob's reported mime,
  // then the file path's extension. Falls back to jpg — every widget
  // upload pipes through the browser's image encoder which defaults to
  // jpg, so a missing hint is still safe.
  const mime = mimeType ?? blobType;
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  if (mime === 'image/jpeg') return 'jpg';
  const dot = filePath.lastIndexOf('.');
  if (dot > -1 && dot < filePath.length - 1) {
    return filePath.slice(dot + 1).toLowerCase();
  }
  return 'jpg';
}
