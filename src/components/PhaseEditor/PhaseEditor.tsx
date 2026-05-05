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
  | { kind: 'edit'; phase: BookingTypePhaseRow }
  // Per ADR-006 §6.3.3 — children can only override duration. Label,
  // patient_required, and pool_ids stay structural and read from the
  // parent. The editor renders those fields as muted "from
  // {parentLabel}" rows, with only duration editable.
  //
  //   parentPhase: the parent's phase row (for label/patient/pools).
  //   childOverride: the existing child row at this phase_index, or
  //     null when no override exists yet (open in "create override"
  //     mode pre-filled with the parent's duration).
  //   childConfigId: the child config row id we're attaching the
  //     override to.
  //   parentLabel: human label of the parent service for the
  //     "from {parent}" muted text.
  | {
      kind: 'child-override';
      childConfigId: string;
      parentPhase: BookingTypePhaseRow;
      childOverride: BookingTypePhaseRow | null;
      parentLabel: string;
    };

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
  // Only shown for edit / child-override modes — both let the admin
  // remove the row (parent edit deletes the phase entirely; child
  // override deletes just the override row, reverting to inherit).
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
    } else if (target.kind === 'child-override') {
      // Per M12, child override rows fully replace the parent's phase
      // when present. Pre-fill every field with the existing override
      // values when one exists, else with the parent's values so the
      // admin starts from a sensible baseline and only edits what
      // differs.
      const p = target.parentPhase;
      const o = target.childOverride;
      setLabel(o?.label?.trim() || p.label);
      setPatientRequired(o?.patient_required ?? p.patient_required);
      setPoolIds(o?.pool_ids ?? p.pool_ids);
      const seedDuration =
        o?.duration_default ?? p.duration_default ?? 0;
      setDurationDefault(seedDuration > 0 ? seedDuration.toString() : '');
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
      let values: PhaseEditorValues;
      if (target.kind === 'edit') {
        values = {
          id: target.phase.id,
          config_id: target.phase.config_id,
          phase_index: target.phase.phase_index,
          label: label.trim(),
          patient_required: patientRequired,
          duration_default: dDefault,
          duration_min: null,
          duration_max: null,
          pool_ids: poolIds,
          notes: null,
        };
      } else if (target.kind === 'create') {
        values = {
          id: null,
          config_id: target.config_id,
          phase_index: target.next_phase_index,
          label: label.trim(),
          patient_required: patientRequired,
          duration_default: dDefault,
          duration_min: null,
          duration_max: null,
          pool_ids: poolIds,
          notes: null,
        };
      } else {
        // child-override: row-level override semantics (M12) — every
        // field is the admin's choice. Pre-filled with the parent's
        // values when the editor opened so unchanged fields equal
        // the parent; changed fields diverge for just this variant.
        values = {
          id: target.childOverride?.id ?? null,
          config_id: target.childConfigId,
          phase_index: target.parentPhase.phase_index,
          label: label.trim(),
          patient_required: patientRequired,
          duration_default: dDefault,
          duration_min: null,
          duration_max: null,
          pool_ids: poolIds,
          notes: null,
        };
      }
      await onSave(values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the phase.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!target || !onDelete) return;
    let id: string | null = null;
    let prompt = '';
    if (target.kind === 'edit') {
      id = target.phase.id;
      prompt = 'Delete this phase? Existing appointments keep their snapshot.';
    } else if (target.kind === 'child-override') {
      id = target.childOverride?.id ?? null;
      prompt = 'Reset this phase to the parent default? The override is removed.';
    }
    if (!id) return;
    if (!window.confirm(prompt)) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the phase.');
    } finally {
      setDeleting(false);
    }
  };

  if (!target) return null;

  const sheetTitle =
    target.kind === 'edit'
      ? `Edit phase ${target.phase.phase_index}`
      : target.kind === 'create'
        ? 'Add phase'
        : `Override duration · phase ${target.parentPhase.phase_index}`;
  const isChildOverride = target.kind === 'child-override';
  const showDelete =
    (target.kind === 'edit' && !!onDelete) ||
    (target.kind === 'child-override' && !!target.childOverride && !!onDelete);
  const deleteLabel = isChildOverride ? 'Reset to parent' : 'Delete';
  const saveLabel = target.kind === 'create'
    ? 'Add phase'
    : isChildOverride
      ? 'Save override'
      : 'Save changes';

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
            {showDelete && (
              <Button variant="tertiary" onClick={handleDelete} loading={deleting}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: theme.space[1],
                    color: theme.color.alert,
                  }}
                >
                  <Trash2 size={16} />
                  {deleteLabel}
                </span>
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={!canSave}>
              {saveLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        {isChildOverride && target.kind === 'child-override' && (
          <InheritsFromBanner parentLabel={target.parentLabel} />
        )}

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
              numericFormat="integer"
              min={1}
              value={durationDefault}
              onChange={(e) => setDurationDefault(e.target.value)}
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
              No resources defined yet. Add some in Resources first.
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

// Slim banner shown at the top of the editor in child-override mode.
// Tells the admin where the defaults came from. Editable fields
// below are pre-filled with the parent's values so changing one
// just diverges from the parent for this variant.
function InheritsFromBanner({ parentLabel }: { parentLabel: string }) {
  return (
    <div
      style={{
        background: theme.color.bg,
        borderRadius: theme.radius.input,
        padding: `${theme.space[2]}px ${theme.space[3]}px`,
        fontSize: theme.type.size.sm,
        color: theme.color.inkMuted,
      }}
    >
      Pre-filled from <strong style={{ color: theme.color.ink }}>{parentLabel}</strong>.
      Anything you change here applies just to this variant. Reset to parent
      from the footer when you want a field to follow the parent again.
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
