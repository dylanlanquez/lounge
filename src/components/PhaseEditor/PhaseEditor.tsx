import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  BottomSheet,
  Button,
  Input,
  SegmentedControl,
} from '../index.ts';
import { theme } from '../../theme/index.ts';
import {
  type BookingTypePhaseRow,
  type ResourcePoolRow,
} from '../../lib/queries/bookingTypes.ts';

// PhaseEditor — bottom sheet (matches the rest of the tablet UI)
// for adding or editing one phase of a booking type. Three things
// the admin actually has to think about:
//
//   1. What's this phase called.
//   2. Is the patient here, or can they leave.
//   3. How long does it take, and what does it hold while it runs.
//
// Duration is one number — the typical case. min/max bounds exist
// in the schema but stay out of this UI; the slot-picker still uses
// the same duration value either way and the rare "this can vary"
// case can be exposed in a future expander if it ever needs to be.
//
// Pool consumption is rendered as toggleable chips rather than a
// dropdown because the typical pool set is 2 to 5 items — chips
// surface every option in one glance and toggle in one tap.

export type PhaseEditorTarget =
  | { kind: 'create'; config_id: string; next_phase_index: number }
  | { kind: 'edit'; phase: BookingTypePhaseRow };

export interface PhaseEditorValues {
  id: string | null;
  config_id: string;
  phase_index: number;
  label: string;
  patient_required: boolean;
  duration_default: number;
  duration_min: number | null;
  duration_max: number | null;
  pool_ids: string[];
  notes: string | null;
}

export interface PhaseEditorProps {
  open: boolean;
  target: PhaseEditorTarget | null;
  pools: ResourcePoolRow[];
  onClose: () => void;
  onSave: (values: PhaseEditorValues) => Promise<void>;
  // Only shown when editing an existing phase.
  onDelete?: (phaseId: string) => Promise<void>;
}

export function PhaseEditor({
  open,
  target,
  pools,
  onClose,
  onSave,
  onDelete,
}: PhaseEditorProps) {
  const [label, setLabel] = useState('');
  const [patientRequired, setPatientRequired] = useState(true);
  const [durationDefault, setDurationDefault] = useState<string>('');
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form state to the target whenever the sheet opens or the
  // target changes. Resetting on close prevents stale values from
  // leaking into the next open.
  useEffect(() => {
    if (!open || !target) return;
    setError(null);
    if (target.kind === 'edit') {
      const p = target.phase;
      setLabel(p.label);
      setPatientRequired(p.patient_required);
      setDurationDefault(p.duration_default?.toString() ?? '');
      setPoolIds(p.pool_ids);
    } else {
      setLabel('');
      setPatientRequired(true);
      setDurationDefault('');
      setPoolIds([]);
    }
  }, [open, target]);

  const canSave = useMemo(() => {
    if (saving || deleting) return false;
    if (!label.trim()) return false;
    const dDefault = Number.parseInt(durationDefault, 10);
    if (!Number.isFinite(dDefault) || dDefault <= 0) return false;
    return true;
  }, [label, durationDefault, saving, deleting]);

  const handleSave = async () => {
    if (!target) return;
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const dDefault = Number.parseInt(durationDefault, 10);
      const values: PhaseEditorValues = {
        id: target.kind === 'edit' ? target.phase.id : null,
        config_id:
          target.kind === 'edit' ? target.phase.config_id : target.config_id,
        phase_index:
          target.kind === 'edit'
            ? target.phase.phase_index
            : target.next_phase_index,
        label: label.trim(),
        patient_required: patientRequired,
        duration_default: dDefault,
        // min/max stay null from this UI — the typical case is a
        // single duration and the slot-picker uses duration_default
        // either way. A future expander can opt into a range.
        duration_min: null,
        duration_max: null,
        pool_ids: poolIds,
        notes: null,
      };
      await onSave(values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the phase.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!target || target.kind !== 'edit' || !onDelete) return;
    if (!window.confirm('Delete this phase? Existing appointments keep their snapshot.')) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(target.phase.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the phase.');
    } finally {
      setDeleting(false);
    }
  };

  if (!target) return null;

  const sheetTitle =
    target.kind === 'edit' ? `Edit phase ${target.phase.phase_index}` : 'Add phase';

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={sheetTitle}
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: theme.space[2],
          }}
        >
          <div>
            {target.kind === 'edit' && onDelete && (
              <Button
                variant="tertiary"
                onClick={handleDelete}
                loading={deleting}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.space[1],
                    color: theme.color.alert,
                  }}
                >
                  <Trash2 size={16} />
                  Delete
                </span>
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!canSave}>
              {target.kind === 'edit' ? 'Save changes' : 'Add phase'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <Section
          title="Name this phase"
          subtitle="A short label your team will see on the schedule and the timeline."
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Sign in & assess"
            autoFocus
          />
        </Section>

        <Section
          title="Is the patient here?"
          subtitle="Active phases hold the chair and the clinician. Passive phases free the patient to leave."
        >
          <SegmentedControl
            value={patientRequired ? 'active' : 'passive'}
            onChange={(v) => setPatientRequired(v === 'active')}
            options={[
              { value: 'active', label: 'Patient in chair' },
              { value: 'passive', label: 'Patient may leave' },
            ]}
          />
        </Section>

        <Section title="How long?" subtitle="In minutes.">
          <div style={{ maxWidth: 200 }}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={durationDefault}
              onChange={(e) => setDurationDefault(e.target.value.replace(/[^0-9]/g, ''))}
              trailingIcon={
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                  min
                </span>
              }
            />
          </div>
        </Section>

        <Section
          title="What does this phase need?"
          subtitle="Pick the chairs, rooms, lab benches or staff this phase holds. The conflict checker uses this list to know what's busy when."
        >
          {pools.length === 0 ? (
            <div
              style={{
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
                padding: theme.space[2],
              }}
            >
              No resource pools defined yet. Add some in Conflicts &amp; capacity first.
            </div>
          ) : (
            <PoolChipPicker
              pools={pools}
              selected={poolIds}
              onChange={setPoolIds}
            />
          )}
        </Section>

        {error && (
          <div
            style={{
              color: theme.color.alert,
              fontSize: theme.type.size.sm,
              padding: theme.space[2],
              background: 'rgba(184,58,42,0.06)',
              borderRadius: theme.radius.input,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <div>
        <div
          style={{
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// Toggleable chip row for a small pool set. Selected chips fill with
// the accent colour; unselected sit as outlined buttons. Tap to
// toggle. Better than a dropdown for 2-to-5 items because every
// option is visible at all times.
function PoolChipPicker({
  pools,
  selected,
  onChange,
}: {
  pools: ResourcePoolRow[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const set = useMemo(() => new Set(selected), [selected]);
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.space[2] }}>
      {pools.map((p) => {
        const isOn = set.has(p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => toggle(p.id)}
            aria-pressed={isOn}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.space[1],
              padding: `${theme.space[2]}px ${theme.space[3]}px`,
              borderRadius: theme.radius.pill,
              border: `1px solid ${
                isOn ? theme.color.accent : theme.color.border
              }`,
              background: isOn ? theme.color.accent : theme.color.surface,
              color: isOn ? '#FFFFFF' : theme.color.ink,
              fontSize: theme.type.size.sm,
              fontWeight: isOn
                ? theme.type.weight.semibold
                : theme.type.weight.medium,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {p.display_name}
          </button>
        );
      })}
    </div>
  );
}
