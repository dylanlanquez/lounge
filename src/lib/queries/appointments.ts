import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

export interface IntakeAnswer {
  question: string;
  answer: string;
}

// Where the appointment row originated. Drives the icon shown on the
// schedule + detail surfaces — Calendly glyph for public-bookings,
// walking-figure for walk-ins / manually added rows.
// The base source axis (lng_appointments.source) is what the row was
// written with — three discrete values stored in the DB.
export type AppointmentSource = 'calendly' | 'manual' | 'native';

// Synthetic display-side union. 'checkpoint' is NOT a stored source
// (those rows live as source='native' with created_via='checkpoint')
// but every display path that surfaces an origin glyph or label
// should be able to pick it as a first-class option. Glyph + source
// resolvers accept this wider type; readers of lng_appointments.source
// keep using the narrower AppointmentSource.
export type AppointmentSourceForDisplay = AppointmentSource | 'checkpoint';

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
  /** Catalogue axis pins populated by native widget bookings.
   *  Used by formatNativeBookingSummary() to compose hero titles
   *  like "Upper Click-in veneers" / "Lower retainer". Calendly-
   *  imported rows leave these null. */
  service_type: string | null;
  product_key: string | null;
  repair_variant: string | null;
  arch: string | null;
  /** Storefront the booking originated from ('venneir' | 'denture').
   *  Drives source-badge chrome on the appointment cards. */
  brand_id: string | null;
  staff_account_id: string | null;
  notes: string | null;
  intake: IntakeAnswer[] | null;
  join_url: string | null;
  // Meet host (Google room owner) on a virtual impression row.
  meet_host_id: string | null;
  // Virtual impression clinician (staff member). Drives clinician-aware
  // availability when rescheduling from the schedule.
  clinician_staff_member_id: string | null;
  /** When set, this row is the calendar marker for a walk-in (the
   *  source-of-truth row lives on lng_walk_ins). Used by the schedule
   *  to render the "Walk-in" prefix on walk-in rows only — every
   *  other source='manual' row is a Lounge staff booking from the
   *  Schedule's New Booking sheet, and should NOT carry that prefix.
   *  Null on every non-walk-in row. */
  walk_in_id: string | null;
  // Deposit captured at booking time via Calendly (PayPal / Stripe).
  // null fields = no deposit info captured. deposit_status reflects the
  // outcome — 'paid' = ready to credit at checkout; 'failed' = receptionist
  // should chase before the patient turns up.
  deposit_pence: number | null;
  deposit_currency: string | null;
  deposit_provider: 'paypal' | 'stripe' | null;
  deposit_status: 'paid' | 'failed' | null;
  /** TRUE when the customer paid the full price at booking via the
   *  widget's "Pay now" choice. Distinct from deposit_pence — the
   *  deposit_pence value still equals the amount charged, but the
   *  flag flips the surfaces that say "Deposit paid" → "Paid in
   *  full" so the reception team never reads a £400 booking as
   *  having a £400 outstanding balance. */
  paid_in_full_at_booking: boolean;
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

// True when the stored name is the legacy "Customer" Shopify placeholder
// (first = "Customer", no last name) or entirely blank, so it carries no
// identifying information.
function isPlaceholderPatientName(first: string, last: string): boolean {
  if (!first && !last) return true;
  return first.toLowerCase() === 'customer' && last.length === 0;
}

export function patientDisplayName(row: AppointmentRow): string {
  const first = properCase(row.patient_first_name);
  const last = properCase(row.patient_last_name);
  if (isPlaceholderPatientName(first, last)) {
    const email = row.patient_email?.trim();
    return email || 'Patient';
  }
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
  if (isPlaceholderPatientName(first, last)) {
    const email = row.patient_email?.trim();
    return email || 'Patient';
  }
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

export function filterCareIntake(intake: ReadonlyArray<IntakeAnswer> | null | undefined): IntakeAnswer[] {
  if (!intake) return [];
  return intake.filter((a) => {
    if (!a || typeof a.answer !== 'string' || a.answer.trim() === '') return false;
    return !INTAKE_SKIP_PATTERNS.some((re) => re.test(a.question ?? ''));
  });
}

// Question-label patterns. Broad enough to catch Calendly variations:
//   "Arch", "Which Arch?", "Upper or Lower?", "Top or Bottom?", "Which jaw?"
export const ARCH_QUESTION =
  /\b(arch|jaw|upper\s*or\s*lower|top\s*or\s*bottom|which\s+side)\b/i;
const SUBJECT_QUESTION = /\b(appliance|repair[\s_]*type|treatment|product|service)\b/i;

// Answer-only fallback: if no question label matched ARCH_QUESTION but an
// answer is clearly an arch indicator (Top / Bottom / Upper / Lower / Both /
// Full mouth, possibly multi-select with newlines), treat it as the arch.
export const ARCH_ANSWER_RE =
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

// Natural-English arch phrase for sentence-form labels — used by
// formatBookingSummary for impression appointments so the hero banner
// reads "Impression appointment for upper arch" instead of the bare
// "for upper" that confused staff. Single arch becomes "upper arch" /
// "lower arch"; both arches becomes "both arches" (not the literal
// "upper and lower"). Unknown variants pass through lowercased.
export function archPhrase(raw: string | null | undefined): string | undefined {
  const anatomy = archToAnatomy(raw);
  if (!anatomy) return undefined;
  if (anatomy === 'Upper and Lower') return 'both arches';
  if (anatomy === 'Upper') return 'upper arch';
  if (anatomy === 'Lower') return 'lower arch';
  return anatomy.toLowerCase();
}

/**
 * Normalise any incoming arch token (Top, top, Upper, Both, full mouth,
 * multi-line "Top\nBottom", null/empty) into the canonical key
 * 'upper' | 'lower' | 'both', or null when no arch info is present.
 * Built on archToAnatomy so the input matrix stays in one place.
 */
export type ArchKey = 'upper' | 'lower' | 'both';
export function normaliseArchKey(raw: string | null | undefined): ArchKey | null {
  const anatomy = archToAnatomy(raw);
  if (anatomy === 'Upper and Lower') return 'both';
  if (anatomy === 'Upper') return 'upper';
  if (anatomy === 'Lower') return 'lower';
  return null;
}

/**
 * Pluralise an appliance noun for the "both arches" phrasing.
 *   "retainer"          → "retainers"
 *   "night guard"       → "night guards"
 *   "click-in veneers"  → "click-in veneers"   (already plural)
 *   "Retainer"          → "Retainers"
 * Mirrors the staged-item pluralisation rule used by the widget
 * success card; if a future appliance has an irregular plural,
 * special-case it here.
 */
function pluraliseAppliance(label: string): string {
  const t = label.trim();
  if (!t) return t;
  if (/s$/i.test(t)) return t;
  return `${t}s`;
}

/**
 * Canonical "{arch} {appliance}" phrasing. Never emits the bare word
 * "Both" alongside an appliance — for the both case it reads as
 * "Upper & lower {pluralised appliance}". Three casings are
 * supported so each caller can pick what fits its surface:
 *
 *   'sentence' (default) — "Upper retainer" / "Upper & lower retainers".
 *                          First word capitalised; mid-sentence words
 *                          stay lowercase. Used standalone on cards
 *                          where the phrase IS the sentence.
 *   'title'              — "Upper Retainer" / "Upper & Lower Retainers".
 *                          Title Case throughout. Used in headline
 *                          contexts where the whole phrase is a title.
 *   'prose'              — "upper retainer" / "upper & lower retainers".
 *                          Fully lowercase, intended to be embedded
 *                          inside a larger sentence ("Same-day upper
 *                          retainer") where the leading word is
 *                          provided by the caller.
 *
 * The `pluraliseForBoth` flag (default true) controls whether the
 * appliance noun is pluralised for the both-arches case. Appliances
 * pluralise naturally ("retainer" → "retainers"); repair-type
 * answers ("Broken Tooth", "Cracked Denture") plural irregularly in
 * English, so callers in the repair path opt out and emit the
 * singular form ("Upper & Lower Broken Tooth") to avoid producing
 * malformed plurals ("Broken Tooths").
 *
 *   formatArchedAppliance('upper', 'retainer')              → "Upper retainer"
 *   formatArchedAppliance('lower', 'night guard')           → "Lower night guard"
 *   formatArchedAppliance('both',  'retainer')              → "Upper & lower retainers"
 *   formatArchedAppliance('both',  'click-in veneers')      → "Upper & lower click-in veneers"
 *   formatArchedAppliance('both',  'Retainer', 'title')     → "Upper & Lower Retainers"
 *   formatArchedAppliance('upper', 'retainer', 'prose')     → "upper retainer"
 *   formatArchedAppliance('both',  'retainer', 'prose')     → "upper & lower retainers"
 *   formatArchedAppliance('both',  'Broken Tooth', 'title', { pluraliseForBoth: false })
 *                                                           → "Upper & Lower Broken Tooth"
 *   formatArchedAppliance(null,    'retainer')              → "retainer"
 */
export function formatArchedAppliance(
  arch: ArchKey | null | undefined,
  applianceNoun: string,
  casing: 'sentence' | 'title' | 'prose' = 'sentence',
  options?: { pluraliseForBoth?: boolean },
): string {
  const noun = applianceNoun.trim();
  if (!noun) return '';
  if (arch === 'upper') {
    return casing === 'prose' ? `upper ${noun}` : `Upper ${noun}`;
  }
  if (arch === 'lower') {
    return casing === 'prose' ? `lower ${noun}` : `Lower ${noun}`;
  }
  if (arch === 'both') {
    const connector =
      casing === 'title'
        ? 'Upper & Lower'
        : casing === 'prose'
          ? 'upper & lower'
          : 'Upper & lower';
    const finalNoun =
      options?.pluraliseForBoth === false ? noun : pluraliseAppliance(noun);
    return `${connector} ${finalNoun}`;
  }
  return noun;
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

// The six display buckets every booking falls into. These line up
// 1:1 with the colour keys on `theme.category`, so a category value
// indexes straight into the palette for dots, bars, and chips.
export type AppointmentCategory =
  | 'repair'
  | 'sameDay'
  | 'appliance'
  | 'impression'
  | 'virtualImpression'
  | 'consult';

// Axis-pinned bookings (native widget + staff-created) carry a
// canonical service_type; map it straight to a category so these rows
// don't fall through to the event_type_label heuristics (which they
// leave null). Mirrors eventTypeCategory's buckets exactly.
const SERVICE_TYPE_CATEGORY: Record<string, AppointmentCategory> = {
  denture_repair: 'repair',
  click_in_veneers: 'sameDay',
  same_day_appliance: 'appliance',
  impression_appointment: 'impression',
  virtual_impression_appointment: 'virtualImpression',
  other: 'consult',
};

// Canonical category for a booking, whatever its origin. service_type
// is the source of truth when present (axis-pinned rows); otherwise
// fall back to parsing the Calendly event_type_label. This is the ONE
// derivation that should drive both the colour bar on the row and the
// schedule type-filter, so the two can never disagree.
export function appointmentCategory(row: {
  service_type: string | null;
  event_type_label: string | null;
}): AppointmentCategory {
  if (row.service_type) {
    const mapped = SERVICE_TYPE_CATEGORY[row.service_type];
    if (mapped) return mapped;
  }
  return eventTypeCategory(row.event_type_label);
}

// Human labels + canonical display order for the categories. Order is
// the same scan order staff use when reading the strip: repairs and
// veneers (the bread-and-butter same-day work) first, impressions
// next, "other" last. Labels are plural — they head a filter list, not
// a single row.
export const APPOINTMENT_CATEGORY_LABELS: Record<AppointmentCategory, string> = {
  repair: 'Denture repairs',
  sameDay: 'Click-in veneers',
  appliance: 'Same-day appliances',
  impression: 'Impressions',
  virtualImpression: 'Virtual impressions',
  consult: 'Other',
};

export const APPOINTMENT_CATEGORY_ORDER: AppointmentCategory[] = [
  'repair',
  'sameDay',
  'appliance',
  'impression',
  'virtualImpression',
  'consult',
];

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

/**
 * Compose a hero title for axis-pinned bookings (native widget AND
 * staff-created "manual" bookings — both store arch / product_key /
 * service_type on the row directly). Skips the Calendly intake-
 * parsing path entirely; those rows pre-date the axis columns and
 * need formatBookingSummary's heuristics.
 *
 * Canonical phrasing per service_type:
 *   same_day_appliance      → "Same-day <arch> <appliance>"
 *                             "Same-day upper retainer"
 *                             "Same-day upper & lower night guards"
 *                             "Same-day whitening kit" (arch_match=any)
 *   click_in_veneers        → "<Arch> click-in veneers"
 *                             "Upper click-in veneers"
 *                             "Upper & lower click-in veneers"
 *                             Click-in veneers carries its own
 *                             "same day" implication via the product
 *                             name, so no Same-day prefix is added.
 *   denture_repair          → "Denture repair" (arch-less; per-arch
 *                             repair lines render separately).
 *   in_person_impression_*  → "<base> for <arch>, <item>"
 *                             "In-person impression appointment for
 *                              both arches, retainers"
 *
 * Never emits the bare word "Both" alongside an appliance — Dylan
 * called the previous "Both retainer" output amateur. All both-arch
 * phrasing routes through formatArchedAppliance / archPhrase so the
 * label reads as a proper noun phrase.
 */
export function formatNativeBookingSummary(row: {
  service_type: string | null;
  event_type_label: string | null;
  arch: string | null;
  product_key: string | null;
}): string {
  // Single source of truth — Title Case canonical label used on
  // every surface (admin schedule + hero + timeline + visit
  // detail, customer widget Success + Review, emails, manage
  // page). Past versions of this function produced sentence /
  // prose case for the admin app and Title Case for the customer
  // surfaces; that drift produced "Same-day upper retainer" on
  // one screen and "Same-day Upper Retainer" on the next.
  // Dylan asked for the Title Case form everywhere — this
  // delegation collapses both shapes onto one helper.
  return formatCustomerServiceTitleLabel(row);
}

// Accepts the two fields actually needed — works with both AppointmentRow
// and AppointmentDetailRow without requiring a full type cast.
export function formatBookingSummary(row: {
  event_type_label: string | null;
  intake: ReadonlyArray<IntakeAnswer> | null;
}): string {
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

  // Native bookings sometimes store the full formatted summary inside
  // event_type_label (e.g. "Virtual impression appointment · Whitening Tray
  // · Lower arch"). Split on ' · ' so the base service name stays clean and
  // any embedded tokens can be parsed for arch/item context.
  const rawLabel = row.event_type_label?.trim() ?? '';
  const splitParts = rawLabel.split(/\s*·\s*/);
  const event = (splitParts[0] ?? '').trim();
  const embedded = splitParts.slice(1);

  // Impression appointments: keep the service name as the primary descriptor
  // and append arch + item as natural English. The arch token uses the
  // archPhrase() helper so the hero reads "for upper arch" / "for lower
  // arch" / "for both arches" — staff complained the previous "for upper"
  // / "for lower" was missing the word arch and "upper and lower" felt
  // clunky in sentence form. When both arch and item are present we
  // separate with a comma so "Impression appointment for upper arch,
  // whitening trays" reads cleanly instead of running the two tokens
  // together.
  if (/impression/i.test(event)) {
    // Arch comes from intake first; fall back to any embedded token that
    // looks like an arch indicator (Upper / Lower / Both).
    const embeddedArchToken = embedded.find(p => /\b(upper|lower|both|top|bottom)\b/i.test(p));
    const effectiveArch = archLabel ?? (embeddedArchToken ? archToAnatomy(embeddedArchToken) : undefined);

    // Item: specific SUBJECT_QUESTION match → any non-arch intake answer →
    // embedded tokens that aren't the arch.
    const nonArchAnswer = subject ?? answers.find(a => a !== arch);
    const embeddedItems = embedded.filter(p => p !== embeddedArchToken);
    const effectiveItem =
      subjectLabel ??
      (nonArchAnswer ? joinMultiSelect(nonArchAnswer.answer) : undefined) ??
      (embeddedItems.length > 0 ? embeddedItems.join(', ') : undefined);

    const phraseArch = effectiveArch ? archPhrase(effectiveArch) : undefined;
    const itemLower = effectiveItem ? effectiveItem.toLowerCase() : undefined;

    if (phraseArch && itemLower) return `${event} for ${phraseArch}, ${itemLower}`;
    if (phraseArch) return `${event} for ${phraseArch}`;
    if (itemLower) return `${event} for ${itemLower}`;
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

  // Calendly answers come in user-entered Title Case ("Retainer",
  // "Night Guard", "Cracked Denture"). Route through the shared
  // arch+appliance helper. Casing is always 'title' so customer-
  // facing surfaces read identically to the native widget output
  // composed by formatCustomerServiceTitleLabel ("Same-day Upper
  // Retainer", "Upper & Lower Cracked Denture"). Same-day appliance
  // bookings get the "Same-day " prefix prepended. Repair-type
  // answers pluralise irregularly in English so the repair branch
  // opts out of pluralisation to avoid producing "Broken Tooths".
  const archKey = arch ? normaliseArchKey(arch.answer) : null;
  const isSameDayAppliance = eventTypeCategory(event) === 'appliance';
  if (subjectLabel) {
    const noun = withDenturePrefix(subjectLabel);
    const phrase = formatArchedAppliance(archKey, noun, 'title', {
      pluraliseForBoth: !isRepair,
    });
    return isSameDayAppliance ? `Same-day ${phrase}` : phrase;
  }
  if (archKey && eventStripped) {
    const phrase = formatArchedAppliance(archKey, eventStripped, 'title', {
      pluraliseForBoth: !isRepair,
    });
    return isSameDayAppliance ? `Same-day ${phrase}` : phrase;
  }
  if (answers.length > 0) {
    return answers
      .map((a) => joinMultiSelect(a.answer))
      .filter((s): s is string => !!s)
      .join(' · ');
  }
  return event || rawLabel;
}

/**
 * Customer-facing Title Case service phrasing. Used by surfaces the
 * patient sees directly (the self-serve manage page, the widget
 * Success card, the email subject for the canonical placeholders).
 * Mirrors the four service-scoped phrases the email edge function
 * composes — exposes them as a single client-side function so the
 * browser surfaces stay aligned without re-implementing the rules.
 *
 *   same_day_appliance + retainer + upper  → "Same-day Upper Retainer"
 *   same_day_appliance + retainer + both   → "Same-day Upper & Lower Retainers"
 *   same_day_appliance + whitening_kit     → "Same-day Whitening Kit"
 *   click_in_veneers + upper               → "Same-day Upper Click-in Veneers"
 *   click_in_veneers + both                → "Same-day Upper & Lower Click-in Veneers"
 *   in_person_impression + retainer + both → "In-person Impression Appointment for Upper & Lower Retainers"
 *   virtual_impression + retainer + upper  → "Virtual Impression Appointment for Upper Retainer"
 *   denture_repair                         → "Denture Repair"
 *
 * Whitening kit is a deliberate special case — always reads
 * "Same-day Whitening Kit" with no arch, because the kit covers
 * both arches by default and naming an arch would be misleading.
 *
 * Falls back to the persisted event_type_label (or a humanised
 * service-type label) when the service isn't one of the recognised
 * shapes, so legacy / Calendly rows still show something readable.
 */
const TITLE_PRODUCT_NOUN: Record<string, string> = {
  retainer: 'Retainer',
  night_guard: 'Night Guard',
  day_guard: 'Day Guard',
  click_in_veneers: 'Click-in Veneers',
  missing_tooth: 'Missing Tooth Retainer',
  whitening_tray: 'Whitening Tray',
  whitening_kit: 'Whitening Kit',
  aligner: 'Replacement Aligner',
};

function pluraliseTitleNoun(noun: string): string {
  const t = noun.trim();
  if (!t) return t;
  if (/s$/i.test(t)) return t;
  return `${t}s`;
}

function titleArchToken(
  arch: ArchKey | null,
): 'Upper' | 'Lower' | 'Upper & Lower' | null {
  if (arch === 'upper') return 'Upper';
  if (arch === 'lower') return 'Lower';
  if (arch === 'both') return 'Upper & Lower';
  return null;
}

export function formatCustomerServiceTitleLabel(row: {
  service_type: string | null;
  event_type_label: string | null;
  arch: string | null;
  product_key: string | null;
}): string {
  const arch = normaliseArchKey(row.arch);
  const service = row.service_type;
  const eventLabel = row.event_type_label?.trim() || null;

  // Quick Sale retail transactions ride the walk-in arm of the Ledger
  // with service_type='retail'. Give them a clear customer-facing label
  // instead of falling through to the generic "Walk-in".
  if (service === 'retail') return 'Retail sale';

  // Same-day appliance OR click-in veneers — both carry the
  // "Same-day " prefix on customer-facing surfaces, even though
  // click-in veneers's product name already implies same-day,
  // because Dylan asked for consistency on the manage page +
  // emails.
  if (service === 'same_day_appliance' || service === 'click_in_veneers') {
    if (row.product_key === 'whitening_kit') return 'Same-day Whitening Kit';
    const productNoun = row.product_key
      ? TITLE_PRODUCT_NOUN[row.product_key]
      : undefined;
    const serviceNoun =
      service === 'click_in_veneers' ? 'Click-in Veneers' : undefined;
    const noun = productNoun ?? serviceNoun;
    if (!noun) return eventLabel ?? 'Appointment';
    const archToken = titleArchToken(arch);
    const finalNoun = arch === 'both' ? pluraliseTitleNoun(noun) : noun;
    return archToken
      ? `Same-day ${archToken} ${finalNoun}`
      : `Same-day ${finalNoun}`;
  }

  // Impression appointments — "for {arch} {product}" suffix.
  // Both 'impression_appointment' (current DB enum) and the legacy
  // 'in_person_impression_appointment' alias map to the in-person
  // base copy, alongside the virtual variant.
  if (
    service === 'impression_appointment' ||
    service === 'in_person_impression_appointment' ||
    service === 'virtual_impression_appointment'
  ) {
    const base =
      service === 'virtual_impression_appointment'
        ? 'Virtual Impression Appointment'
        : 'In-person Impression Appointment';
    const productNoun = row.product_key
      ? TITLE_PRODUCT_NOUN[row.product_key] ?? null
      : null;
    const archToken = titleArchToken(arch);
    if (archToken && productNoun) {
      const finalNoun =
        arch === 'both' ? pluraliseTitleNoun(productNoun) : productNoun;
      return `${base} for ${archToken} ${finalNoun}`;
    }
    if (archToken) return `${base} for ${archToken}`;
    if (productNoun) return `${base} for ${productNoun}`;
    return base;
  }

  // Denture repair — no axis prefix; per-arch detail belongs in the
  // repair-table block below the service label.
  if (service === 'denture_repair') return 'Denture Repair';

  // Anything else: fall back to the persisted event_type_label.
  return eventLabel ?? 'Appointment';
}

/**
 * One-stop summary for any appointment row, regardless of source.
 * Single source of truth for "what should this booking read as on
 * the schedule / hero / popup / list / clinic board." Routes
 * axis-pinned rows (native widget + staff-created manual) through
 * formatNativeBookingSummary; pre-axis Calendly rows fall back to
 * the intake-parsing formatBookingSummary. Centralising this means
 * adding a new service type or product enum surfaces everywhere in
 * one edit — no chance of one card showing "Same-day appliance"
 * while another shows "Same-day whitening kit" because a call site
 * forgot the conditional.
 */
export function formatAppointmentSummary(row: {
  service_type: string | null;
  event_type_label: string | null;
  arch: string | null;
  product_key: string | null;
  intake: ReadonlyArray<IntakeAnswer> | null;
}): string {
  if (row.service_type) {
    return formatNativeBookingSummary({
      service_type: row.service_type,
      event_type_label: row.event_type_label,
      arch: row.arch,
      product_key: row.product_key,
    });
  }
  return formatBookingSummary({
    event_type_label: row.event_type_label,
    intake: row.intake,
  });
}
