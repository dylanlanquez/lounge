import { type CSSProperties, useEffect, useId, useMemo, useState } from 'react';
import { theme } from '../../theme/index.ts';
import { DropdownSelect } from '../DropdownSelect/DropdownSelect.tsx';

// Date-of-birth input as three side-by-side dropdowns (Day / Month /
// Year). Replaces the native <input type="date"> calendar widget,
// which lands elderly patients in a year-grid that's awkward to
// navigate on a kiosk. Three dropdowns mirror how a person says a
// date ("the 5th of May 1952") and inherit the in-app DropdownSelect
// chrome (large touch targets, portal'd panel, ARIA listbox).
//
// The component is purely presentational. Parent owns the canonical
// value as a YYYY-MM-DD string (or '' when not yet complete) — the
// same shape the existing form state, validation and submitArrivalIntake
// already expect.

const MONTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

const YEARS_BACK = 110;

interface Parts {
  day: string;
  month: string;
  year: string;
}

function parseIsoDate(value: string): Parts {
  // Accept YYYY-MM-DD and the empty string; anything else parses to empty.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return { day: '', month: '', year: '' };
  return { year: m[1]!, month: m[2]!, day: m[3]! };
}

function daysInMonth(month: number, year: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 30;
}

export interface DateOfBirthRowProps {
  value: string;
  onChange: (value: string) => void;
  fullSpan?: boolean;
}

export function DateOfBirthRow({
  value,
  onChange,
  fullSpan = false,
}: DateOfBirthRowProps) {
  const [parts, setParts] = useState<Parts>(() => parseIsoDate(value));
  const labelId = useId();

  // Sync from prop when the parent's value diverges from local — handles
  // async hydrate (initial load fills in the patient's existing DOB).
  // Compares stringified parts to avoid re-syncing the value we just
  // emitted ourselves.
  useEffect(() => {
    const next = parseIsoDate(value);
    if (
      next.day !== parts.day ||
      next.month !== parts.month ||
      next.year !== parts.year
    ) {
      setParts(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Emit when the three parts compose into a valid date. Empty out
  // when any part is missing so the form's required-field check still
  // flags the row as incomplete.
  useEffect(() => {
    const composed =
      parts.day && parts.month && parts.year
        ? `${parts.year}-${parts.month}-${parts.day}`
        : '';
    if (composed !== value) onChange(composed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts]);

  // Day clamp — if the user picks Feb after entering 31, drop the day
  // to the new month's maximum so the composed date is always valid.
  useEffect(() => {
    if (!parts.month || !parts.year || !parts.day) return;
    const max = daysInMonth(parseInt(parts.month, 10), parseInt(parts.year, 10));
    if (parseInt(parts.day, 10) > max) {
      setParts((p) => ({ ...p, day: String(max).padStart(2, '0') }));
    }
  }, [parts.month, parts.year, parts.day]);

  const yearOptions = useMemo(() => {
    const now = new Date().getFullYear();
    const out: { value: string; label: string }[] = [];
    for (let y = now; y >= now - YEARS_BACK; y--) {
      out.push({ value: String(y), label: String(y) });
    }
    return out;
  }, []);

  const dayOptions = useMemo(() => {
    const max =
      parts.month && parts.year
        ? daysInMonth(parseInt(parts.month, 10), parseInt(parts.year, 10))
        : 31;
    const out: { value: string; label: string }[] = [];
    for (let d = 1; d <= max; d++) {
      const padded = String(d).padStart(2, '0');
      out.push({ value: padded, label: String(d) });
    }
    return out;
  }, [parts.month, parts.year]);

  // Match EditableFieldCard's silhouette exactly so the row sits on
  // the same baseline as the other field cards — same padding, same
  // border, same label rhythm. We use a div + role=group instead of
  // a native <fieldset>/<legend> because the browser's UA legend
  // renders into the top border, which broke the card's outline
  // rectangle in the FormGrid.
  const wrapper: CSSProperties = {
    ...(fullSpan ? { gridColumn: '1 / -1' } : {}),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space[2],
    padding: `${theme.space[3]}px ${theme.space[4]}px`,
    borderRadius: theme.radius.input,
    background: theme.color.surface,
    border: `1px solid ${theme.color.border}`,
  };

  const labelStyle: CSSProperties = {
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    color: theme.color.inkMuted,
    letterSpacing: 0,
  };

  return (
    <div role="group" aria-labelledby={labelId} style={wrapper}>
      <span id={labelId} style={labelStyle}>
        Date of birth
        <span
          aria-hidden
          style={{
            color: theme.color.alert,
            marginLeft: 4,
            fontWeight: theme.type.weight.semibold,
          }}
        >
          *
        </span>
      </span>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1.4fr 1fr',
          gap: theme.space[2],
        }}
      >
        <DropdownSelect
          ariaLabel="Day"
          value={parts.day}
          options={dayOptions}
          placeholder="Day"
          onChange={(v) => setParts((p) => ({ ...p, day: v }))}
        />
        <DropdownSelect
          ariaLabel="Month"
          value={parts.month}
          options={MONTH_OPTIONS}
          placeholder="Month"
          onChange={(v) => setParts((p) => ({ ...p, month: v }))}
        />
        <DropdownSelect
          ariaLabel="Year"
          value={parts.year}
          options={yearOptions}
          placeholder="Year"
          onChange={(v) => setParts((p) => ({ ...p, year: v }))}
        />
      </div>
    </div>
  );
}
