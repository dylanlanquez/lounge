import { type CSSProperties, useEffect, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { Input } from '../Input/Input.tsx';
import { theme } from '../../theme/index.ts';
import {
  DATE_RANGE_PRESETS,
  type DateRange,
  type DateRangePresetId,
  dateRangeLabel,
  makeCustomRange,
  resolvePreset,
} from '../../lib/dateRange.ts';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  // Optional: shrink the trigger button when the picker sits in a
  // dense filter row. Defaults to a comfortable inline width that
  // suits a page header.
  size?: 'sm' | 'md';
  // Optional: disable the trigger while a parent is mid-mutation.
  disabled?: boolean;
}

// Universal date-range picker used at the top of every Reports / Financials
// page. Trigger is a tertiary Button; tapping opens a BottomSheet with the
// preset shortcuts on top and a custom range pair below. Same chrome as the
// rest of the app (BottomSheet + Button + Input) so it sits visually inside
// the existing surface, not as a foreign control.
//
// Why BottomSheet rather than a desktop popover: every other "open a panel
// for input" surface in Lounge uses BottomSheet — discount sheet, void
// sheet, edit-name sheet. Consistency wins. On desktop the sheet still
// reads as a centred modal because the BottomSheet component degrades that
// way at the breakpoints we care about.

export function DateRangePicker({
  value,
  onChange,
  size = 'md',
  disabled = false,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  // Local draft so the parent's value doesn't flicker through partially
  // typed custom dates. Committed on Apply / preset click.
  const [draft, setDraft] = useState<DateRange>(value);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft whenever the sheet opens. If a parent updates
  // `value` while the sheet is closed (e.g. another control resets the
  // range), we pick the new value up here without staling the inputs.
  useEffect(() => {
    if (open) {
      setDraft(value);
      setError(null);
    }
  }, [open, value]);

  const pickPreset = (id: DateRangePresetId) => {
    const next = resolvePreset(id);
    onChange(next);
    setOpen(false);
  };

  const applyCustom = () => {
    setError(null);
    try {
      const next = makeCustomRange(draft.start, draft.end);
      onChange(next);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid date range');
    }
  };

  const triggerStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[2],
  };

  return (
    <>
      <Button
        variant="tertiary"
        size={size}
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <span style={triggerStyle}>
          <Calendar size={size === 'sm' ? 14 : 16} aria-hidden />
          {dateRangeLabel(value)}
          <ChevronDown size={size === 'sm' ? 12 : 14} aria-hidden />
        </span>
      </Button>

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Date range"
        description="Pick a shortcut or enter custom dates."
        footer={
          <div
            style={{
              display: 'flex',
              gap: theme.space[3],
              justifyContent: 'flex-end',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={applyCustom}>
              Apply custom
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          <section>
            <h3
              style={{
                margin: 0,
                marginBottom: theme.space[3],
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                color: theme.color.inkMuted,
              }}
            >
              Shortcuts
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: theme.space[2],
              }}
            >
              {DATE_RANGE_PRESETS.map((preset) => {
                const active = value.preset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => pickPreset(preset.id)}
                    style={{
                      appearance: 'none',
                      border: `1px solid ${active ? theme.color.ink : theme.color.border}`,
                      background: active ? theme.color.ink : theme.color.surface,
                      color: active ? theme.color.surface : theme.color.ink,
                      borderRadius: theme.radius.input,
                      padding: `${theme.space[2]}px ${theme.space[3]}px`,
                      fontFamily: 'inherit',
                      fontSize: theme.type.size.sm,
                      fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3
              style={{
                margin: 0,
                marginBottom: theme.space[3],
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                textTransform: 'uppercase',
                letterSpacing: theme.type.tracking.wide,
                color: theme.color.inkMuted,
              }}
            >
              Custom range
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: theme.space[3],
              }}
            >
              <Input
                label="From"
                type="date"
                value={draft.start}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, start: e.target.value, preset: 'custom' }))
                }
                max={draft.end}
              />
              <Input
                label="To"
                type="date"
                value={draft.end}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, end: e.target.value, preset: 'custom' }))
                }
                min={draft.start}
              />
            </div>
            {error ? (
              <p
                role="alert"
                style={{
                  margin: `${theme.space[3]}px 0 0`,
                  color: theme.color.alert,
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                }}
              >
                {error}
              </p>
            ) : null}
          </section>
        </div>
      </BottomSheet>
    </>
  );
}
