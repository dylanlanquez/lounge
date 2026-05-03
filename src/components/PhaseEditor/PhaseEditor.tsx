import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Button,
  Dialog,
  Input,
  MultiSelectDropdown,
  SegmentedControl,
} from '../index.ts';
import { theme } from '../../theme/index.ts';
import {
  type BookingTypePhaseRow,
  type ResourcePoolRow,
} from '../../lib/queries/bookingTypes.ts';

// PhaseEditor — the focused dialog the admin uses to add a new
// phase or edit an existing one. Mirrors the booking-types editor
// pattern: each form section is a labelled row, controls come from
// the design system, and the save / delete buttons sit at the
// bottom in the standard footer layout.
//
// Shape of `target`:
//   { kind: 'create', config_id, next_phase_index }
//     → create a new phase row at the end of this config's ribbon.
//   { kind: 'edit', phase }
//     → edit an existing phase row.
//
// onSave is async so the caller can do the upsert + setPhasePoolIds
// pair atomically and dismiss only after both succeed.

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
  const [durationMin, setDurationMin] = useState<string>('');
  const [durationMax, setDurationMax] = useState<string>('');
  const [poolIds, setPoolIds] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form state to the target whenever the dialog opens or the
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
      setDurationMin(p.duration_min?.toString() ?? '');
      setDurationMax(p.duration_max?.toString() ?? '');
      setPoolIds(p.pool_ids);
      setNotes(p.notes ?? '');
    } else {
      setLabel('');
      setPatientRequired(true);
      setDurationDefault('');
      setDurationMin('');
      setDurationMax('');
      setPoolIds([]);
      setNotes('');
    }
  }, [open, target]);

  const poolOptions = useMemo(
    () =>
      pools.map((p) => ({
        value: p.id,
        label: p.display_name,
      })),
    [pools],
  );

  const canSave = useMemo(() => {
    if (saving || deleting) return false;
    if (!label.trim()) return false;
    const dDefault = Number.parseInt(durationDefault, 10);
    if (!Number.isFinite(dDefault) || dDefault <= 0) return false;
    if (durationMin) {
      const v = Number.parseInt(durationMin, 10);
      if (!Number.isFinite(v) || v <= 0 || v > dDefault) return false;
    }
    if (durationMax) {
      const v = Number.parseInt(durationMax, 10);
      if (!Number.isFinite(v) || v <= 0 || v < dDefault) return false;
    }
    return true;
  }, [label, durationDefault, durationMin, durationMax, saving, deleting]);

  const handleSave = async () => {
    if (!target) return;
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const dDefault = Number.parseInt(durationDefault, 10);
      const dMin = durationMin ? Number.parseInt(durationMin, 10) : null;
      const dMax = durationMax ? Number.parseInt(durationMax, 10) : null;
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
        duration_min: dMin,
        duration_max: dMax,
        pool_ids: poolIds,
        notes: notes.trim() ? notes.trim() : null,
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

  const dialogTitle =
    target.kind === 'edit' ? `Edit phase ${target.phase.phase_index}` : 'Add phase';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dialogTitle}
      width={520}
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
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], color: theme.color.alert }}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <Section
          title="What happens in this phase"
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

        <Section
          title="How long does it take?"
          subtitle="Default is what the schedule offers. Min and max bound the slot picker. Leave min and max blank for a fixed duration."
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: theme.space[2],
            }}
          >
            <DurationField label="Min" value={durationMin} onChange={setDurationMin} />
            <DurationField
              label="Default"
              required
              value={durationDefault}
              onChange={setDurationDefault}
            />
            <DurationField label="Max" value={durationMax} onChange={setDurationMax} />
          </div>
        </Section>

        <Section
          title="What does this phase need?"
          subtitle="Pick the chairs, rooms, lab benches or staff roles this phase holds. Conflict checking uses this list, per phase."
        >
          {poolOptions.length === 0 ? (
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
            <MultiSelectDropdown
              label=""
              values={poolIds}
              onChange={setPoolIds}
              options={poolOptions}
              placeholder="Pick resources"
              totalNoun="resources"
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
    </Dialog>
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

function DurationField({
  label,
  required,
  value,
  onChange,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
          marginBottom: 4,
        }}
      >
        {label} {required && <span style={{ color: theme.color.alert }}>*</span>}
      </div>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        trailingIcon={<span style={{ fontSize: theme.type.size.xs, color: theme.color.inkMuted }}>min</span>}
      />
    </div>
  );
}
