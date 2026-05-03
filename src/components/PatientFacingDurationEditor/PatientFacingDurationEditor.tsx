import { useEffect, useMemo, useState } from 'react';
import { BottomSheet, Button, Input } from '../index.ts';
import { theme } from '../../theme/index.ts';

// PatientFacingDurationEditor — focused single-purpose sheet for
// "what we tell the patient" duration. The operational total is
// always the sum of phases, derived. The patient-facing duration is
// what we communicate (confirmation email, calendar invite). Most of
// the time they match; this editor lets the admin set them apart for
// the cases where the marketing line shouldn't equal the operational
// reality (denture repair: tell patient "30 min", operationally 35).
//
// Three controls:
//   - One number input ("min" suffix).
//   - "Use operational total (X min)" link — clears the override
//     (writes null) so the field falls back to the derived value.
//   - Save / Cancel buttons in the footer.

export interface PatientFacingDurationEditorProps {
  open: boolean;
  // The booking-type config row we're editing. Null when closed.
  configId: string | null;
  // Service display name shown in the sheet title for context.
  serviceLabel: string;
  // Currently-stored override minutes (column value). Null = no
  // override; the resolver derives from the block total at runtime.
  currentOverrideMinutes: number | null;
  // The derived operational total (sum of phase defaults), shown so
  // the admin can compare and so "Use operational total" reads with
  // the actual fallback value next to it.
  operationalMinutes: number;
  onClose: () => void;
  onSave: (minutes: number | null) => Promise<void>;
}

export function PatientFacingDurationEditor({
  open,
  configId,
  serviceLabel,
  currentOverrideMinutes,
  operationalMinutes,
  onClose,
  onSave,
}: PatientFacingDurationEditorProps) {
  const [value, setValue] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (currentOverrideMinutes !== null && currentOverrideMinutes > 0) {
      setValue(currentOverrideMinutes.toString());
    } else {
      // Pre-fill with the operational total so the admin sees the
      // current effective value and can edit it directly. Saving
      // unchanged still writes the derived number to the column,
      // which is fine — the resolver returns the same value either
      // way and the column is the single source of truth.
      setValue(operationalMinutes > 0 ? operationalMinutes.toString() : '');
    }
  }, [open, currentOverrideMinutes, operationalMinutes]);

  const parsed = useMemo(() => Number.parseInt(value, 10), [value]);
  const canSave =
    !saving && Number.isFinite(parsed) && parsed > 0;

  const handleSave = async () => {
    if (!configId || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
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
      await onSave(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear.');
    } finally {
      setSaving(false);
    }
  };

  if (!configId) return null;

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
          <Button onClick={handleSave} loading={saving} disabled={!canSave}>
            Save
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.normal,
          }}
        >
          The patient sees this duration in their booking confirmation,
          reminder, and add-to-calendar invite. Most of the time it matches
          the operational total. Override it when the marketing line should
          read differently, like rounding 35 minutes down to 30.
        </p>

        <div>
          <div
            style={{
              fontSize: theme.type.size.base,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              marginBottom: theme.space[2],
            }}
          >
            How long?
          </div>
          <div style={{ maxWidth: 200 }}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
              trailingIcon={
                <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                  min
                </span>
              }
            />
          </div>
        </div>

        {currentOverrideMinutes !== null && (
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
