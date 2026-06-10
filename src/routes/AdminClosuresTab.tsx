import { useMemo, useRef, useState } from 'react';
import { CalendarOff, CalendarClock, Info, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  DatePicker,
  EmptyState,
  Input,
  MultiSelectDropdown,
  SegmentedControl,
} from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { addDaysIso, todayIso } from '../lib/calendarMonth.ts';
import {
  type Closure,
  type ClosureScope,
  addClosureRange,
  deleteClosures,
  useClosures,
} from '../lib/queries/closures.ts';

// The individual in-person types a whole-clinic closure stands in for.
const IN_PERSON_SCOPES: ClosureScope[] = [
  'denture_repair',
  'click_in_veneers',
  'same_day_appliance',
  'impression_appointment',
  'other',
];

const SCOPE_LABEL: Record<ClosureScope, string> = {
  whole_clinic: 'Whole clinic (in-person)',
  denture_repair: 'Denture repairs',
  click_in_veneers: 'Click-in veneers',
  same_day_appliance: 'Same-day appliances',
  impression_appointment: 'Impressions',
  virtual_impression_appointment: 'Virtual impressions',
  other: 'Other',
};

// Order in the dropdown: whole clinic first, then the in-person types,
// then virtual (the separate team) last.
const SCOPE_OPTIONS: { value: ClosureScope; label: string }[] = [
  { value: 'whole_clinic', label: SCOPE_LABEL.whole_clinic },
  ...IN_PERSON_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] })),
  { value: 'virtual_impression_appointment', label: SCOPE_LABEL.virtual_impression_appointment },
];

// Per-type palette dot for the list — the same category colours as the
// schedule bars / filter.
const SCOPE_COLOR: Record<ClosureScope, string | null> = {
  whole_clinic: null,
  denture_repair: theme.category.repair,
  click_in_veneers: theme.category.sameDay,
  same_day_appliance: theme.category.appliance,
  impression_appointment: theme.category.impression,
  virtual_impression_appointment: theme.category.virtualImpression,
  other: theme.category.consult,
};

type Mode = 'single' | 'range';

// 'YYYY-MM-DD' parsed as a plain calendar date (UTC) so no timezone
// shift nudges it to the day before. `weekday` adds the day name.
function fmtDate(iso: string, weekday = true): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: weekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// A contiguous run of closed dates with the same scope + reason, shown
// as one row.
interface ClosureGroup {
  scope: ClosureScope;
  reason: string | null;
  from: string;
  to: string;
  ids: string[];
}

function groupClosures(rows: Closure[]): ClosureGroup[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      (a.reason ?? '').localeCompare(b.reason ?? '') ||
      a.closed_date.localeCompare(b.closed_date)
  );
  const groups: ClosureGroup[] = [];
  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.scope === c.scope &&
      (last.reason ?? '') === (c.reason ?? '') &&
      addDaysIso(last.to, 1) === c.closed_date
    ) {
      last.to = c.closed_date;
      last.ids.push(c.id);
    } else {
      groups.push({ scope: c.scope, reason: c.reason, from: c.closed_date, to: c.closed_date, ids: [c.id] });
    }
  }
  return groups;
}

export function AdminClosuresTab() {
  const { closures, loading, error, reload } = useClosures();

  const [mode, setMode] = useState<Mode>('single');
  const [single, setSingle] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Multi-select: choose one or more types to close. Whole clinic and
  // the individual in-person types are mutually exclusive (whole clinic
  // already covers them); virtual is independent.
  const [selected, setSelected] = useState<Set<ClosureScope>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const wholeClinic = selected.has('whole_clinic');
  const today = todayIso();

  const { upcoming, past } = useMemo(() => {
    const groups = groupClosures(closures);
    const up = groups.filter((g) => g.to >= today).sort((a, b) => a.from.localeCompare(b.from));
    const pa = groups.filter((g) => g.to < today).sort((a, b) => b.from.localeCompare(a.from));
    return { upcoming: up, past: pa };
  }, [closures, today]);

  // Keep whole-clinic and the in-person types mutually exclusive: adding
  // whole clinic clears the individual ones, and vice versa.
  const handleScopeChange = (vals: ClosureScope[]) => {
    setSelected((prev) => {
      const next = new Set(vals);
      const addedWhole = next.has('whole_clinic') && !prev.has('whole_clinic');
      const addedInPerson = IN_PERSON_SCOPES.some((s) => next.has(s) && !prev.has(s));
      if (addedWhole) for (const s of IN_PERSON_SCOPES) next.delete(s);
      else if (addedInPerson) next.delete('whole_clinic');
      return next;
    });
  };

  const span =
    mode === 'single'
      ? single
        ? { from: single, to: single }
        : null
      : from && to
        ? from <= to
          ? { from, to }
          : { from: to, to: from }
        : null;

  const canAdd = span !== null && selected.size > 0 && !busy;

  const resetForm = () => {
    setSingle('');
    setFrom('');
    setTo('');
    setReason('');
    setSelected(new Set());
  };

  const handleAdd = async () => {
    if (!canAdd || !span) return;
    setBusy(true);
    setFormError(null);
    try {
      const scopes = wholeClinic
        ? [...selected].filter((s) => s === 'whole_clinic' || s === 'virtual_impression_appointment')
        : [...selected];
      const trimmedReason = reason.trim() || null;
      for (const scope of scopes) {
        await addClosureRange({ from: span.from, to: span.to, scope, reason: trimmedReason });
      }
      resetForm();
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not add the closure.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGroup = async (ids: string[]) => {
    try {
      await deleteClosures(ids);
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not remove the closure.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      {/* What closures do — including the virtual caveat. */}
      <div
        style={{
          display: 'flex',
          gap: theme.space[3],
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          background: theme.color.accentBg,
          borderRadius: theme.radius.card,
          borderLeft: `4px solid ${theme.color.accent}`,
        }}
      >
        <Info size={18} color={theme.color.accent} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
        <p style={{ margin: 0, fontSize: theme.type.size.sm, lineHeight: theme.type.leading.normal, color: theme.color.accent }}>
          <span style={{ fontWeight: theme.type.weight.semibold }}>Blocked dates close bookings everywhere</span>
          {' '}— the booking widgets, reschedule, self-serve, and Checkpoint. A
          {' '}<strong>Whole clinic</strong> closure blocks every in-person booking type for those days; it does not
          affect virtual impressions, which run on a separate team. To close virtual too, tick
          {' '}<strong>Virtual impressions</strong> as well. Reasons are internal only and are never shown to customers.
        </p>
      </div>

      {/* Add a closure. */}
      <Card padding="md">
        <h3
          style={{
            margin: `0 0 ${theme.space[4]}px`,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          Add a closure
        </h3>

        <div style={{ marginBottom: theme.space[4] }}>
          <SegmentedControl<Mode>
            size="sm"
            ariaLabel="Single day or date range"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'single', label: 'Single day' },
              { value: 'range', label: 'Date range' },
            ]}
          />
        </div>

        {/* Date(s) + closes + reason — one tidy row that wraps. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: theme.space[4],
            alignItems: 'end',
          }}
        >
          {mode === 'single' ? (
            <DateField label="Date" value={single} onChange={setSingle} minIso={today} />
          ) : (
            <>
              <DateField label="From" value={from} onChange={setFrom} minIso={today} />
              <DateField label="To" value={to} onChange={setTo} minIso={from || today} />
            </>
          )}
          <MultiSelectDropdown<ClosureScope>
            label="Closes"
            values={[...selected]}
            options={SCOPE_OPTIONS}
            onChange={handleScopeChange}
            placeholder="Choose what to close"
            totalNoun="types"
          />
          <Input
            label="Reason (internal)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Bank holiday"
            maxLength={120}
          />
        </div>

        {/* Action on its own row so it never gets crammed beside the fields. */}
        <div
          style={{
            marginTop: theme.space[5],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: theme.space[4],
          }}
        >
          {formError ? (
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.alert, marginRight: 'auto' }}>
              {formError}
            </span>
          ) : null}
          <Button variant="primary" size="md" onClick={handleAdd} disabled={!canAdd} loading={busy}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2] }}>
              <Plus size={16} aria-hidden /> Add closure
            </span>
          </Button>
        </div>
      </Card>

      {/* Existing closures. */}
      {loading ? (
        <p style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>Loading closures…</p>
      ) : error ? (
        <p style={{ fontSize: theme.type.size.sm, color: theme.color.alert }}>{error}</p>
      ) : upcoming.length === 0 && past.length === 0 ? (
        <EmptyState
          icon={<CalendarOff size={24} />}
          title="No closures set"
          description="Add a date above to block bookings for a holiday or a clinic closure."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {upcoming.length > 0 ? (
            <ClosureSection title="Upcoming" groups={upcoming} onDelete={handleDeleteGroup} />
          ) : null}
          {past.length > 0 ? (
            <ClosureSection title="Past" groups={past} onDelete={handleDeleteGroup} dim />
          ) : null}
        </div>
      )}
    </div>
  );
}

// Date trigger + the app's polished date popover, self-contained.
function DateField({
  label,
  value,
  onChange,
  minIso,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  minIso: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          appearance: 'none',
          width: '100%',
          height: theme.layout.inputHeight,
          padding: `0 ${theme.space[4]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
          background: theme.color.surface,
          border: `1px solid ${open ? theme.color.ink : theme.color.border}`,
          borderRadius: theme.radius.input,
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: theme.type.size.base,
          color: value ? theme.color.ink : theme.color.inkSubtle,
          transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <CalendarClock size={16} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
        {value ? fmtDate(value) : 'Pick a date'}
      </button>
      <DatePicker
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        onChange={onChange}
        anchorRef={ref}
        title="Pick the date"
        minIso={minIso}
      />
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'block',
        marginBottom: theme.space[2],
        fontSize: theme.type.size.sm,
        fontWeight: theme.type.weight.medium,
        color: theme.color.inkMuted,
      }}
    >
      {children}
    </span>
  );
}

function ClosureSection({
  title,
  groups,
  onDelete,
  dim = false,
}: {
  title: string;
  groups: ClosureGroup[];
  onDelete: (ids: string[]) => void;
  dim?: boolean;
}) {
  return (
    <div>
      <p
        style={{
          margin: `0 0 ${theme.space[2]}px`,
          fontSize: theme.type.size.xs,
          color: theme.color.inkSubtle,
          fontWeight: theme.type.weight.medium,
          textTransform: 'uppercase',
          letterSpacing: theme.type.tracking.wide,
        }}
      >
        {title}
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2], opacity: dim ? 0.6 : 1 }}>
        {groups.map((g) => {
          const dateLabel = g.from === g.to ? fmtDate(g.from) : `${fmtDate(g.from, false)} – ${fmtDate(g.to, false)}`;
          return (
            <li
              key={g.ids.join(',')}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[3],
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0, flexWrap: 'wrap' }}>
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    flexShrink: 0,
                    borderRadius: theme.radius.pill,
                    background: SCOPE_COLOR[g.scope] ?? theme.color.accent,
                  }}
                />
                <strong style={{ fontSize: theme.type.size.sm, color: theme.color.ink, whiteSpace: 'nowrap' }}>
                  {dateLabel}
                </strong>
                <span
                  style={{
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.medium,
                    color: theme.color.inkMuted,
                    background: 'rgba(14,20,20,0.05)',
                    padding: `${theme.space[1]}px ${theme.space[2]}px`,
                    borderRadius: theme.radius.pill,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {SCOPE_LABEL[g.scope]}
                </span>
                {g.reason ? (
                  <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkSubtle, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.reason}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onDelete(g.ids)}
                aria-label={`Remove closure ${dateLabel}`}
                style={{
                  appearance: 'none',
                  border: `1px solid ${theme.color.border}`,
                  background: theme.color.surface,
                  color: theme.color.alert,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: theme.radius.pill,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  fontFamily: 'inherit',
                }}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
