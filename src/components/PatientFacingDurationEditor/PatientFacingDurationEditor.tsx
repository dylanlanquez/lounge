import { useEffect, useMemo, useState } from 'react';
import { BottomSheet, Button, Input, SegmentedControl } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { patientFacingDurationLabel } from '../../lib/queries/bookingTypes.ts';

// PatientFacingDurationEditor — focused single-purpose sheet for
// "what we tell the patient" duration. Two modes:
//
//   Fixed — one number, e.g. denture repair "30 min".
//   Range — two numbers, e.g. Click-in Veneers "4 to 6 hours".
//
// Live preview shows exactly what the patient will read in the
// confirmation email so the admin doesn't have to translate the
// abstract "min/max" form into the rendered copy in their head.
//
// "Use the operational total (X min)" link clears both override
// fields so the resolver falls back to the derived block duration.

export type PatientFacingValues = {
  min: number | null;
  max: number | null;
};

export interface PatientFacingDurationEditorProps {
  open: boolean;
  // The booking-type config row we're editing. Null when closed.
  configId: string | null;
  // Service display name shown in the sheet title for context.
  serviceLabel: string;
  // Currently-stored override values. Null = no override; the
  // resolver derives min from the block total at runtime, max stays
  // null (no fallback for the upper bound).
  currentOverrideMin: number | null;
  currentOverrideMax: number | null;
  // The derived operational total (sum of phase defaults), shown so
  // the admin can compare and so "Use the operational total" reads
  // with the actual fallback value next to it.
  operationalMinutes: number;
  onClose: () => void;
  onSave: (values: PatientFacingValues) => Promise<void>;
}

type Mode = 'fixed' | 'range';

export function PatientFacingDurationEditor({
  open,
  configId,
  serviceLabel,
  currentOverrideMin,
  currentOverrideMax,
  operationalMinutes,
  onClose,
  onSave,
}: PatientFacingDurationEditorProps) {
  const [mode, setMode] = useState<Mode>('fixed');
  const [minValue, setMinValue] = useState<string>('');
  const [maxValue, setMaxValue] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form state to the target whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    const hasOverride = currentOverrideMin !== null && currentOverrideMin > 0;
    const hasRange = currentOverrideMax !== null && currentOverrideMax > 0;
    if (hasOverride) {
      setMinValue(String(currentOverrideMin));
      if (hasRange) {
        setMaxValue(String(currentOverrideMax));
        setMode('range');
      } else {
        setMaxValue('');
        setMode('fixed');
      }
    } else {
      // Pre-fill with the operational total so the admin sees the
      // current effective value and can edit it directly. Default
      // mode = fixed (the common case).
      setMinValue(operationalMinutes > 0 ? String(operationalMinutes) : '');
      setMaxValue('');
      setMode('fixed');
    }
  }, [open, currentOverrideMin, currentOverrideMax, operationalMinutes]);

  // When the admin switches mode mid-edit, keep their typed numbers
  // around so toggling Range → Fixed → Range doesn't wipe what they
  // had. We only validate / save the relevant fields per mode.
  const parsedMin = useMemo(() => Number.parseInt(minValue, 10), [minValue]);
  const parsedMax = useMemo(() => Number.parseInt(maxValue, 10), [maxValue]);

  const validation = useMemo<{ ok: boolean; message: string | null }>(() => {
    if (saving) return { ok: false, message: null };
    if (!Number.isFinite(parsedMin) || parsedMin <= 0) {
      return { ok: false, message: null };
    }
    if (mode === 'range') {
      if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
        return { ok: false, message: null };
      }
      if (parsedMax < parsedMin) {
        return {
          ok: false,
          message: 'The maximum has to be at least the minimum.',
        };
      }
      if (parsedMax === parsedMin) {
        return {
          ok: false,
          message:
            'Min and max are the same — switch to Fixed for a single value.',
        };
      }
    }
    return { ok: true, message: null };
  }, [mode, parsedMin, parsedMax, saving]);

  // Live preview of the rendered patient-facing label, using the
  // same formatter the email and ribbon will end up using.
  const preview = useMemo(() => {
    if (!Number.isFinite(parsedMin) || parsedMin <= 0) return '';
    if (mode === 'fixed') return patientFacingDurationLabel(parsedMin, null);
    if (!Number.isFinite(parsedMax) || parsedMax <= 0) return '';
    return patientFacingDurationLabel(parsedMin, parsedMax);
  }, [mode, parsedMin, parsedMax]);

  const handleSave = async () => {
    if (!configId || !validation.ok) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        min: parsedMin,
        max: mode === 'range' ? parsedMax : null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!configId) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ min: null, max: null });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear.');
    } finally {
      setSaving(false);
    }
  };

  if (!configId) return null;

  const hasOverride =
    currentOverrideMin !== null && currentOverrideMin > 0;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`What do we tell the patient · ${serviceLabel}`}
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          <Button variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!validation.ok}>
            Save
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          The patient sees this duration in their booking confirmation,
          reminder, and add-to-calendar invite. Pick a fixed time when
          you can promise it; pick a range for bookings that genuinely
          vary, like Click-in Veneers' lab fabrication.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={[
              { value: 'fixed', label: 'Fixed time' },
              { value: 'range', label: 'Time range' },
            ]}
          />

          {mode === 'fixed' ? (
            <FixedField value={minValue} onChange={setMinValue} />
          ) : (
            <RangeFields
              minValue={minValue}
              maxValue={maxValue}
              onMinChange={setMinValue}
              onMaxChange={setMaxValue}
            />
          )}
        </div>

        <PreviewLine preview={preview} />

        {validation.message && (
          <div
            style={{
              fontSize: theme.type.size.sm,
              color: theme.color.alert,
            }}
          >
            {validation.message}
          </div>
        )}

        {hasOverride && (
          <div>
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              style={{
                appearance: 'none',
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                color: theme.color.accent,
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              Use the operational total ({operationalMinutes} min)
            </button>
            <div
              style={{
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                marginTop: 2,
              }}
            >
              Clears the override so the email auto-follows whatever the
              phase total resolves to.
            </div>
          </div>
        )}

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

function FixedField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>How long?</FieldLabel>
      <div style={{ maxWidth: 200 }}>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
          trailingIcon={<MinSuffix />}
        />
      </div>
    </div>
  );
}

function RangeFields({
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  minValue: string;
  maxValue: string;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>How long, minimum to maximum?</FieldLabel>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[2],
        }}
      >
        <div style={{ flex: 1, maxWidth: 160 }}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            autoFocus
            value={minValue}
            onChange={(e) => onMinChange(e.target.value.replace(/[^0-9]/g, ''))}
            trailingIcon={<MinSuffix />}
          />
        </div>
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontWeight: theme.type.weight.medium,
          }}
        >
          to
        </span>
        <div style={{ flex: 1, maxWidth: 160 }}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            value={maxValue}
            onChange={(e) => onMaxChange(e.target.value.replace(/[^0-9]/g, ''))}
            trailingIcon={<MinSuffix />}
          />
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: theme.type.size.base,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.ink,
        marginBottom: theme.space[2],
      }}
    >
      {children}
    </div>
  );
}

function MinSuffix() {
  return (
    <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
      min
    </span>
  );
}

// Live render of what the patient will read in their email. Empty
// state when neither side is filled in yet so the admin doesn't see
// "The patient will see: " trailing into nothing.
function PreviewLine({ preview }: { preview: string }) {
  if (!preview) return null;
  return (
    <div
      style={{
        background: theme.color.accentBg,
        borderRadius: theme.radius.input,
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[1],
      }}
    >
      <div
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.accent,
          fontWeight: theme.type.weight.semibold,
          letterSpacing: theme.type.tracking.wide,
          textTransform: 'uppercase',
        }}
      >
        Preview
      </div>
      <div
        style={{
          fontSize: theme.type.size.base,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        Your appointment, {preview}.
      </div>
      <div
        style={{
          fontSize: theme.type.size.xs,
          color: theme.color.inkMuted,
        }}
      >
        This is what {'{{patientFacingDuration}}'} renders to in the email.
      </div>
    </div>
  );
}
