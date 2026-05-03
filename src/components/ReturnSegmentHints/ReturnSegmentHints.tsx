import { useMemo } from 'react';
import { theme } from '../../theme/index.ts';
import { InlineHint } from '../InlineHint/InlineHint.tsx';
import type { ResolvedBookingTypeConfig } from '../../lib/queries/bookingTypes.ts';

// Threshold for the "patient comes back" hint, in minutes. Mirrors
// the default in lng_settings.booking.patient_segmented_threshold_
// minutes (the email-side renderer reads the live value). Hardcoded
// here for the slot pickers — admin-tuned values won't sync without
// a refresh, but the admin almost never changes it and the drift is
// harmless (cosmetic only).
const RETURN_HINT_THRESHOLD_MIN = 60;

// Hint surfaced under a slot picker when the candidate booking has
// a passive phase ≥ threshold. Tells the receptionist when to ask
// the patient to come back so they can pass the time on at the moment
// they're scheduling, not after the fact. One row per "back at"
// segment so a 5-phase service with two long passives renders both.

export interface ReturnSegmentHintsProps {
  phases: ResolvedBookingTypeConfig['phases'];
  // ISO timestamp of the candidate booking start. Null when the
  // operator hasn't picked a time yet — the component renders
  // nothing in that case.
  startIso: string | null;
}

export function ReturnSegmentHints({ phases, startIso }: ReturnSegmentHintsProps) {
  const segments = useMemo(() => {
    if (!startIso || phases.length < 2) return [];
    const out: { time: string; label: string; durationMinutes: number }[] = [];
    let cursor = new Date(startIso).getTime();
    let hadLongPassive = false;
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i]!;
      const dur = (p.duration_default ?? 0) * 60_000;
      const end = cursor + dur;
      // When the previous phase was a long passive AND this phase
      // is active, this is a "patient back" point.
      if (i > 0 && hadLongPassive && p.patient_required) {
        out.push({
          time: formatHmm(cursor),
          label: p.label,
          durationMinutes: p.duration_default ?? 0,
        });
        hadLongPassive = false;
      }
      if (!p.patient_required && dur >= RETURN_HINT_THRESHOLD_MIN * 60_000) {
        hadLongPassive = true;
      }
      cursor = end;
    }
    return out;
  }, [phases, startIso]);

  if (segments.length === 0) return null;
  return (
    <div
      style={{
        marginTop: theme.space[2],
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
      }}
    >
      {segments.map((s, i) => (
        <InlineHint key={i} tone="muted">
          Patient back at <strong>{s.time}</strong> for {s.label}
          {s.durationMinutes > 0 ? ` (${s.durationMinutes} min)` : ''}.
        </InlineHint>
      ))}
    </div>
  );
}

function formatHmm(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
