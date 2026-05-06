import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

export interface IntakeAnswer {
  question: string;
  answer: string;
}

// Where the appointment row originated. Drives the icon shown on the
// schedule + detail surfaces — Calendly glyph for public-bookings,
// walking-figure for walk-ins / manually added rows.
export type AppointmentSource = 'calendly' | 'manual' | 'native';

// One materialised phase as needed by the schedule grid + appointment
// detail. Subset of lng_appointment_phases — schedule consumers don't
// need pool_ids on every render.
export interface AppointmentPhaseSummary {
  phase_index: number;
  label: string;
  patient_required: boolean;
  start_at: string;
  end_at: string;
  status: 'pending' | 'in_progress' | 'complete' | 'skipped';
  pool_ids: string[];
}

export interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  event_type_label: string | null;
  staff_account_id: string | null;
  notes: string | null;
  intake: IntakeAnswer[] | null;
  join_url: string | null;
  // Deposit captured at booking time via Calendly (PayPal / Stripe).
  // null fields = no deposit info captured. deposit_status reflects the
  // outcome — 'paid' = ready to credit at checkout; 'failed' = receptionist
  // should chase before the patient turns up.
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_email: string | null;
  patient_phone: string | null;
  staff_first_name: string | null;
  staff_last_name: string | null;
  // Materialised phases (ADR-006). Empty array when the appointment
  // has not been materialised yet (legacy data) — consumers should
  // fall back to a single implicit phase covering the whole window.
  phases: AppointmentPhaseSummary[];
}

// Title-cases a name. Lowercase words → "Amanda". All-caps words of any
// length ≥ 2 → "Amanda" / "Doe" (catches both "AMANDA SOLANKE" and
// "JOHN DOE"). Single-letter tokens stay uppercase — they're initials
// (e.g. "A V Sinfield"). Mixed-case is preserved (so "McDonald" /
// "O'Brien" survive). Splits on whitespace, hyphens, and apostrophes
// so "mary-jane" → "Mary-Jane".
//
// Honorifics (Mr/Mrs/Miss/Ms/Dr/Prof) are recognised regardless of
// case so source data like "MRS A V SINFIELD" lands as "Mrs A V
// Sinfield" instead of leaking the SHOUTING through.
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof']);

export function properCase(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .split(/(\s+|-|’|')/)
    .map((part) => {
      if (!part || /^[\s\-'’]+$/.test(part)) return part;
      const lower = part.toLowerCase();
      // Strip a trailing dot for the honorific check ("Mrs." → "mrs")
      // so common written forms still match. Re-apply the dot at the end.
      const dotted = lower.endsWith('.');
      const stem = dotted ? lower.slice(0, -1) : lower;
      if (HONORIFICS.has(stem)) {
        return stem.charAt(0).toUpperCase() + stem.slice(1) + (dotted ? '.' : '');
      }
      // Single-letter tokens are initials — keep them uppercase.
      if (part.length === 1) return part.toUpperCase();
      const isAllLower = lower === part;
      const isAllUpper = part.toUpperCase() === part;
      if (isAllLower) return part.charAt(0).toUpperCase() + part.slice(1);
      if (isAllUpper) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      return part;
    })
    .join('');
}

export function patientDisplayName(row: AppointmentRow): string {
  const first = properCase(row.patient_first_name);
  const last = properCase(row.patient_last_name);
  if (!first && !last) return 'Patient';
  return `${first} ${last.slice(0, 1)}${last.slice(0, 1) ? '.' : ''}`.trim();
}

// Threshold (minutes past start_at) at which a booked appointment is
// flagged as late and the receptionist is nudged to mark it no-show.
export const NO_SHOW_LATE_THRESHOLD_MIN = 15;

// True when a row should render at reduced opacity so the eye lands on
// active and upcoming work. Two ways in:
//   - Terminal status (complete / cancelled / rescheduled) — done, regardless of time.
//   - Past slot (end_at <= now) for any non-active status — booked rows that
//     never got actioned and no_shows from earlier in the day or week.
// Active visits (arrived) stay full-strength even past end_at, because the
// appointment slot may have over-run while the patient is still in the chair.
export function isAppointmentDimmed(
  row: { end_at: string; status: AppointmentStatus },
  now: Date | number
): boolean {
  if (row.status === 'arrived' || row.status === 'joined') return false;
  if (row.status === 'complete' || row.status === 'cancelled' || row.status === 'rescheduled') {
    return true;
  }
  const t = typeof now === 'number' ? now : now.getTime();
  return new Date(row.end_at).getTime() <= t;
}

// Whole minutes elapsed since an appointment's start_at. Negative when the
// appointment is still in the future. Floor'd so a 14:59 elapsed shows as 14.
export function minutesPastStart(startIso: string, now: Date | number): number {
  const start = new Date(startIso).getTime();
  const t = typeof now === 'number' ? now : now.getTime();
  return Math.floor((t - start) / 60_000);
}

// True when a booked row has crossed the late threshold. Caller is responsible
// for gating on status === 'booked' — a no-show'd or arrived row shouldn't be
// flagged again.
export function isBookingLate(startIso: string, now: Date | number): boolean {
  return minutesPastStart(startIso, now) >= NO_SHOW_LATE_THRESHOLD_MIN;
}

// Human-readable late-by string. Scales gracefully from minutes → hours →
// days so the UI doesn't render "1092 mins late" on a row from yesterday.
//   < 60 min      → "5 mins" / "1 min"
//   < 24 hr       → "1 hr" / "1 hr 30 mins"
//   1+ days       → "2 days" / "2 days 5 hr 30 mins"
// Negative or zero inputs return "0 mins" — caller shouldn't normally pass
// these (the late nudge is gated on >= 15) but we handle it safely.
export function formatLateDuration(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  if (m < 60) return `${m} ${m === 1 ? 'min' : 'mins'}`;
  if (m < 1440) {
    const hours = Math.floor(m / 60);
    const mins = m % 60;
    if (mins === 0) return `${hours} hr`;
    return `${hours} hr ${mins} ${mins === 1 ? 'min' : 'mins'}`;
  }
  const days = Math.floor(m / 1440);
  const remainder = m % 1440;
  const hours = Math.floor(remainder / 60);
  const mins = remainder % 60;
  const parts: string[] = [`${days} ${days === 1 ? 'day' : 'days'}`];
  if (hours > 0) parts.push(`${hours} hr`);
  if (mins > 0) parts.push(`${mins} ${mins === 1 ? 'min' : 'mins'}`);
  return parts.join(' ');
}

// Human-readable label for an appointment status. Backed-end enums like
// 'no_show' are not for the receptionist to see.
export function humaniseStatus(status: AppointmentRow['status']): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'joined':
      return 'Joined';
    case 'complete':
      return 'Complete';
    case 'no_show':
      return 'No-show';
    case 'cancelled':
      return 'Cancelled';
    case 'rescheduled':
      return 'Rescheduled';
    default:
      return status;
  }
}

// Full-name version for confirmation surfaces (booking detail sheet).
export function patientFullDisplayName(row: AppointmentRow): string {
  const first = properCase(row.patient_first_name);
  const last = properCase(row.patient_last_name);
  if (!first && !last) return 'Patient';
  return `${first} ${last}`.trim();
}

export function staffDisplayName(row: AppointmentRow): string | undefined {
  if (!row.staff_first_name && !row.staff_last_name) return undefined;
  return [row.staff_first_name, row.staff_last_name].filter(Boolean).join(' ');
}

// One-line summary of Calendly intake answers for compact list rows.
// Returns the answer values joined with ' · '; questions that look like
// generic contact fields (number, email, time zone) are filtered out.
export function intakeSummary(row: AppointmentRow): string | undefined {
  const filtered = filterCareIntake(row.intake);
  if (!filtered || filtered.length === 0) return undefined;
  return filtered.map((a) => a.answer.trim()).filter(Boolean).join(' · ');
}

const INTAKE_SKIP_PATTERNS = [
  /^contact\s*number/i,
  /^phone/i,
  /^mobile/i,
  /^email/i,
  /\btime\s*zone\b/i,
];

export function filterCareIntake(intake: IntakeAnswer[] | null | undefined): IntakeAnswer[] {
  if (!intake) return [];
  return intake.filter((a) => {
    if (!a || typeof a.answer !== 'string' || a.answer.trim() === '') return false;
    return !INTAKE_SKIP_PATTERNS.some((re) => re.test(a.question ?? ''));
  });
}

// Question-label patterns. Broad enough to catch Calendly variations:
//   "Arch", "Which Arch?", "Upper or Lower?", "Top or Bottom?", "Which jaw?"
const ARCH_QUESTION =
  /\b(arch|jaw|upper\s*or\s*lower|top\s*or\s*bottom|which\s+side)\b/i;
const SUBJECT_QUESTION = /\b(appliance|repair[\s_]*type|treatment|product|service)\b/i;

// Answer-only fallback: if no question label matched ARCH_QUESTION but an
// answer is clearly an arch indicator (Top / Bottom / Upper / Lower / Both /
// Full mouth, possibly multi-select with newlines), treat it as the arch.
const ARCH_ANSWER_RE =
  /^(top|bottom|upper|lower|both|full[\s\-_]?mouth|upper\s+and\s+lower)(\s*[,;\n]+\s*(top|bottom|upper|lower|both|full[\s\-_]?mouth|upper\s+and\s+lower))*\s*$/i;

// Map "Top" / "Bottom" / "Both" answers to anatomical labels.
// Multi-select values like "Top, Bottom" or "Upper and Lower" collapse to
// "Upper and Lower". Unknown values pass through with first-letter cap.
export function archToAnatomy(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase().trim();
  if (!v) return undefined;
  const hasTop = /\b(top|upper)\b/.test(v);
  const hasBottom = /\b(bottom|lower)\b/.test(v);
  if ((hasTop && hasBottom) || /\bboth\b/.test(v) || /\bfull\b/.test(v)) return 'Upper and Lower';
  if (hasTop) return 'Upper';
  if (hasBottom) return 'Lower';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Maps a Calendly event-type label to one of the muted category colors.
// Match by inclusion (case-insensitive) so minor wording variations still
// land in the right bucket. Virtual is checked before impression so a
// "Virtual Impression Appointment" gets the teal bucket, not the
// in-person olive-lime — staff need to spot Google-Meet bookings at a
// glance.
export function eventTypeCategory(
  label: string | null | undefined
):
  | 'repair'
  | 'sameDay'
  | 'appliance'
  | 'impression'
  | 'virtualImpression'
  | 'consult' {
  if (!label) return 'consult';
  const v = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(v)) return 'repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(v)) return 'sameDay';
  if (/same[\s-]?day\s+appliance|appliance/i.test(v)) return 'appliance';
  if (/virtual.*impression|impression.*virtual/i.test(v)) return 'virtualImpression';
  if (/impression/i.test(v)) return 'impression';
  return 'consult';
}

// One-line, human-readable summary of the appointment for cards and sheets.
// Combines arch + appliance/repair into "Upper Missing Tooth Retainer";
// strips event-type prefixes ("Same-day ", "In-person ", "Virtual ") so the
// final string stays compact and clinical.
// Calendly multi-select answers come back as newline-separated values
// (e.g. "Broken Tooth/Teeth\nRelining (Upper or Lower)"). Render them as
// a comma-joined natural-English list.
function joinMultiSelect(answer: string | undefined | null): string | undefined {
  if (!answer) return undefined;
  const parts = answer
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(', ');
}

export function formatBookingSummary(row: AppointmentRow): string {
  const answers = filterCareIntake(row.intake);
  // Match arch by question label first; if no question matches, fall back to
  // any answer that is itself a recognisable arch indicator.
  const arch =
    answers.find((a) => ARCH_QUESTION.test(a.question ?? '')) ??
    answers.find((a) => ARCH_ANSWER_RE.test(a.answer ?? ''));
  const subject = answers.find(
    (a) => SUBJECT_QUESTION.test(a.question ?? '') && (!arch || a !== arch)
  );
  const archLabel = arch ? archToAnatomy(arch.answer) : undefined;
  const subjectLabel = joinMultiSelect(subject?.answer);

  const event = row.event_type_label?.trim() ?? '';

  // Impression appointments are special: the "product" question describes
  // what's being impressioned (Whitening Trays, Retainers etc.) — but on its
  // own that reads like a Same-day Appliances booking. Keep the full event
  // label as the primary descriptor and use "for {product}" as the suffix.
  if (/impression/i.test(event)) {
    if (subjectLabel) return `${event} for ${subjectLabel}`;
    return event;
  }

  const eventStripped = event.replace(/^(same-day|in-person|virtual)\s+/i, '').trim();

  // Denture-repair bookings should always read "Denture …" so the
  // card disambiguates against real-tooth issues. Calendly's intake
  // answers vary — "Snapped Denture" already includes the word, but
  // "Broken Tooth" / "Add a Tooth" / "Relining" do not. Prepend
  // "Denture " only when the rendered subject doesn't already
  // contain it, otherwise we'd produce "Denture Snapped Denture".
  const isRepair = eventTypeCategory(event) === 'repair';
  const withDenturePrefix = (text: string): string =>
    isRepair && !/denture/i.test(text) ? `Denture ${text}` : text;

  if (subjectLabel && archLabel) return `${archLabel} ${withDenturePrefix(subjectLabel)}`;
  if (subjectLabel) return withDenturePrefix(subjectLabel);
  if (archLabel && eventStripped) return `${archLabel} ${eventStripped}`;
  if (answers.length > 0) {
    return answers
      .map((a) => joinMultiSelect(a.answer))
      .filter((s): s is string => !!s)
      .join(' · ');
  }
  return event;
}
