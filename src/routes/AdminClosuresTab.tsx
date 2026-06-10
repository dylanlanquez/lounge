import { useMemo, useRef, useState } from 'react';
import { CalendarOff, CalendarClock, Info, Plus, Trash2 } from 'lucide-react';
import { Button, Card, Checkbox, DatePicker, EmptyState, Input } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { todayIso } from '../lib/calendarMonth.ts';
import {
  type Closure,
  type ClosureScope,
  addClosure,
  deleteClosure,
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

// 'YYYY-MM-DD' -> "Wed, 25 Dec 2026", parsed as a plain calendar date
// (UTC) so no timezone shift nudges it to the day before.
function formatClosureDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function AdminClosuresTab() {
  const { closures, loading, error, reload } = useClosures();

  const [date, setDate] = useState('');
  // Multi-select: tick one or more types to close on the date. Whole
  // clinic stands in for every in-person type (so those individual rows
  // are implied + disabled while it's ticked); virtual is independent.
  const [selected, setSelected] = useState<Set<ClosureScope>>(new Set());
  const [reason, setReason] = useState('');
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const dateTriggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const wholeClinic = selected.has('whole_clinic');
  const today = todayIso();

  const { upcoming, past } = useMemo(() => {
    const up: Closure[] = [];
    const pa: Closure[] = [];
    for (const c of closures) (c.closed_date >= today ? up : pa).push(c);
    return { upcoming: up, past: pa };
  }, [closures, today]);

  const toggle = (scope: ClosureScope) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
        // Whole clinic supersedes the individual in-person types — clear
        // them so we don't write redundant rows.
        if (scope === 'whole_clinic') for (const s of IN_PERSON_SCOPES) next.delete(s);
      }
      return next;
    });
  };

  const canAdd = date !== '' && selected.size > 0 && !busy;

  const resetForm = () => {
    setDate('');
    setReason('');
    setSelected(new Set());
  };

  const handleAdd = async () => {
    if (!canAdd) return;
    setBusy(true);
    setFormError(null);
    try {
      // Whole clinic already covers every in-person type, so submit only
      // it (+ virtual if also ticked), never the individual in-person rows.
      const scopes = wholeClinic
        ? [...selected].filter((s) => s === 'whole_clinic' || s === 'virtual_impression_appointment')
        : [...selected];
      const trimmedReason = reason.trim() || null;
      for (const scope of scopes) {
        await addClosure({ date, scope, reason: trimmedReason });
      }
      resetForm();
      reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not add the closure.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteClosure(id);
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
          {' '}<strong>Whole clinic</strong> closure blocks every in-person booking type for that day; it does not
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

        {/* Date + reason. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: theme.space[4],
          }}
        >
          <div>
            <FieldLabel>Date</FieldLabel>
            <button
              ref={dateTriggerRef}
              type="button"
              onClick={() => setDatePickerOpen((v) => !v)}
              style={{
                appearance: 'none',
                width: '100%',
                height: theme.layout.inputHeight,
                padding: `0 ${theme.space[4]}px`,
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[2],
                background: theme.color.surface,
                border: `1px solid ${datePickerOpen ? theme.color.ink : theme.color.border}`,
                borderRadius: theme.radius.input,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: theme.type.size.base,
                color: date ? theme.color.ink : theme.color.inkSubtle,
                transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
            >
              <CalendarClock size={16} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
              {date ? formatClosureDate(date) : 'Pick a date'}
            </button>
            <DatePicker
              open={datePickerOpen}
              onClose={() => setDatePickerOpen(false)}
              value={date}
              onChange={(iso) => setDate(iso)}
              anchorRef={dateTriggerRef}
              title="Pick the date to close"
              minIso={today}
            />
          </div>

          <Input
            label="Reason (internal)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Bank holiday"
            maxLength={120}
          />
        </div>

        {/* What to close — multi-select. */}
        <div style={{ marginTop: theme.space[4] }}>
          <FieldLabel>Closes</FieldLabel>
          <div
            style={{
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[4],
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[3],
            }}
          >
            <Checkbox
              checked={wholeClinic}
              onChange={() => toggle('whole_clinic')}
              label={SCOPE_LABEL.whole_clinic}
            />
            <div aria-hidden style={{ height: 1, background: theme.color.border }} />
            {/* Individual in-person types — implied + disabled while whole
                clinic is ticked. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: `${theme.space[3]}px ${theme.space[4]}px`,
              }}
            >
              {IN_PERSON_SCOPES.map((scope) => (
                <Checkbox
                  key={scope}
                  checked={wholeClinic || selected.has(scope)}
                  disabled={wholeClinic}
                  onChange={() => toggle(scope)}
                  label={SCOPE_LABEL[scope]}
                />
              ))}
            </div>
            <div aria-hidden style={{ height: 1, background: theme.color.border }} />
            <Checkbox
              checked={selected.has('virtual_impression_appointment')}
              onChange={() => toggle('virtual_impression_appointment')}
              label={SCOPE_LABEL.virtual_impression_appointment}
            />
          </div>
        </div>

        {/* Action. */}
        <div
          style={{
            marginTop: theme.space[4],
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
            <ClosureSection title="Upcoming" rows={upcoming} onDelete={handleDelete} />
          ) : null}
          {past.length > 0 ? (
            <ClosureSection title="Past" rows={past} onDelete={handleDelete} dim />
          ) : null}
        </div>
      )}
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
  rows,
  onDelete,
  dim = false,
}: {
  title: string;
  rows: Closure[];
  onDelete: (id: string) => void;
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
        {rows.map((c) => (
          <li
            key={c.id}
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
              <strong style={{ fontSize: theme.type.size.sm, color: theme.color.ink, whiteSpace: 'nowrap' }}>
                {formatClosureDate(c.closed_date)}
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
                {SCOPE_LABEL[c.scope]}
              </span>
              {c.reason ? (
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkSubtle, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.reason}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDelete(c.id)}
              aria-label={`Remove closure on ${formatClosureDate(c.closed_date)}`}
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
        ))}
      </ul>
    </div>
  );
}
