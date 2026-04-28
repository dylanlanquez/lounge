import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import type { AppointmentStatus } from '../../components/AppointmentCard/AppointmentCard.tsx';

export interface IntakeAnswer {
  question: string;
  answer: string;
}

export interface AppointmentRow {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  event_type_label: string | null;
  staff_account_id: string | null;
  intake: IntakeAnswer[] | null;
  join_url: string | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_email: string | null;
  patient_phone: string | null;
  staff_first_name: string | null;
  staff_last_name: string | null;
}

interface UseTodayAppointmentsResult {
  data: AppointmentRow[];
  loading: boolean;
  error: string | null;
}

export function useTodayAppointments(): UseTodayAppointmentsResult {
  const [data, setData] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        // RLS scopes this query to the receptionist's location.
        const fetchToday = (withIntake: boolean) =>
          supabase
            .from('lng_appointments')
            .select(
              [
                'id',
                'patient_id',
                'location_id',
                'start_at',
                'end_at',
                'status',
                'event_type_label',
                'staff_account_id',
                ...(withIntake ? ['intake', 'join_url'] : []),
                'patient:patients ( first_name, last_name, email, phone )',
                'staff:accounts!lng_appointments_staff_account_id_fkey ( first_name, last_name )',
              ].join(', ')
            )
            .gte('start_at', start.toISOString())
            .lte('start_at', end.toISOString())
            .order('start_at', { ascending: true });

        let { data: rows, error: err } = await fetchToday(true);
        // 42703 = undefined_column. Frontend deployed before schema migration
        // landed: degrade gracefully without intake instead of blanking the page.
        if (err && err.code === '42703') {
          const fallback = await fetchToday(false);
          rows = fallback.data;
          err = fallback.error;
        }

        if (cancelled) return;
        if (err) {
          // PGRST200 is "relation not found in the embedded resource" — happens
          // before slice 0 migrations land. Treat as empty rather than error.
          if (err.code === 'PGRST200' || err.code === '42P01') {
            setData([]);
            setError(null);
          } else {
            setError(err.message);
          }
          setLoading(false);
          return;
        }

        const mapped: AppointmentRow[] = (rows ?? []).map((r) => {
          const raw = r as unknown as AppointmentRowRaw;
          const patient = Array.isArray(raw.patient) ? raw.patient[0] : raw.patient;
          const staff = Array.isArray(raw.staff) ? raw.staff[0] : raw.staff;
          return {
            id: raw.id,
            patient_id: raw.patient_id,
            location_id: raw.location_id,
            start_at: raw.start_at,
            end_at: raw.end_at,
            status: raw.status,
            event_type_label: raw.event_type_label,
            staff_account_id: raw.staff_account_id,
            intake: raw.intake ?? null,
            join_url: raw.join_url ?? null,
            patient_first_name: patient?.first_name ?? null,
            patient_last_name: patient?.last_name ?? null,
            patient_email: patient?.email ?? null,
            patient_phone: patient?.phone ?? null,
            staff_first_name: staff?.first_name ?? null,
            staff_last_name: staff?.last_name ?? null,
          };
        });
        setData(mapped);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

interface AppointmentRowRaw {
  id: string;
  patient_id: string;
  location_id: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  event_type_label: string | null;
  staff_account_id: string | null;
  intake: IntakeAnswer[] | null;
  join_url: string | null;
  patient:
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }
    | { first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[]
    | null;
  staff:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
}

export function patientDisplayName(row: AppointmentRow): string {
  const first = row.patient_first_name ?? '';
  const last = row.patient_last_name ?? '';
  if (!first && !last) return 'Patient';
  return `${first} ${last.slice(0, 1)}${last.slice(0, 1) ? '.' : ''}`.trim();
}

// Human-readable label for an appointment status. Backed-end enums like
// 'no_show' / 'in_progress' are not for the receptionist to see.
export function humaniseStatus(status: AppointmentRow['status']): string {
  switch (status) {
    case 'booked':
      return 'Booked';
    case 'arrived':
      return 'Arrived';
    case 'in_progress':
      return 'In progress';
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
  const first = (row.patient_first_name ?? '').trim();
  const last = (row.patient_last_name ?? '').trim();
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
// land in the right bucket.
export function eventTypeCategory(
  label: string | null | undefined
): 'repair' | 'sameDay' | 'appliance' | 'impression' | 'consult' {
  if (!label) return 'consult';
  const v = label.toLowerCase();
  if (/denture\s+repair|repair/i.test(v)) return 'repair';
  if (/click[\s-]?in\s+veneer|veneer/i.test(v)) return 'sameDay';
  if (/same[\s-]?day\s+appliance|appliance/i.test(v)) return 'appliance';
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

  if (subjectLabel && archLabel) return `${archLabel} ${subjectLabel}`;
  if (subjectLabel) return subjectLabel;
  if (archLabel && eventStripped) return `${archLabel} ${eventStripped}`;
  if (answers.length > 0) {
    return answers
      .map((a) => joinMultiSelect(a.answer))
      .filter((s): s is string => !!s)
      .join(' · ');
  }
  return event;
}
