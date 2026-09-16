import { useState } from 'react';
import { Check } from 'lucide-react';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import {
  VOICE_CALL_OUTCOMES,
  logVoiceCallOutcome,
  type VoiceCallOutcome,
} from '../../lib/queries/voiceCallLog.ts';
import { logFailure } from '../../lib/failureLog.ts';

// "Log this call" — the single action that replaces Mark patient as
// arrived / Mark as no-show for a voice call. One screen: pick what
// happened, add a note if it's worth one, done. Every outcome takes a
// note (not just the vague "Other" case the clinic no-show picker
// singles out) because for a call centre the note usually carries
// more than the outcome does — "asked to call after 6pm", "number
// says disconnected", "will call us back tomorrow".

export interface CallOutcomeSheetProps {
  open: boolean;
  appointmentId: string;
  patientId: string;
  onClose: () => void;
  onLogged: (result: { status: 'complete' | 'no_show'; logWriteFailed: boolean }) => void;
}

const TONE_COLOUR: Record<'good' | 'bad' | 'warn', string> = {
  good: theme.color.accent,
  bad: theme.color.alert,
  warn: theme.color.warn,
};

export function CallOutcomeSheet({ open, appointmentId, patientId, onClose, onLogged }: CallOutcomeSheetProps) {
  const [outcome, setOutcome] = useState<VoiceCallOutcome | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOutcome(null);
    setNote('');
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!outcome || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await logVoiceCallOutcome({ appointmentId, patientId, outcome, note });
      reset();
      onLogged(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not log this call';
      await logFailure({
        source: 'CallOutcomeSheet.submit',
        severity: 'error',
        message,
        context: { appointmentId, outcome },
      });
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      title="Log this call"
      description="What happened, and anything worth remembering for next time."
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={submitting} disabled={submitting || !outcome}>
            {submitting ? 'Logging…' : 'Log this call'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
        <div
          role="radiogroup"
          aria-label="Outcome"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: theme.space[2] }}
        >
          {VOICE_CALL_OUTCOMES.map((opt) => {
            const selected = outcome === opt.value;
            const colour = TONE_COLOUR[opt.tone];
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={submitting}
                onClick={() => setOutcome(opt.value)}
                style={{
                  appearance: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.space[2],
                  textAlign: 'left',
                  padding: `${theme.space[3]}px ${theme.space[4]}px`,
                  minHeight: theme.layout.minTouchTarget,
                  borderRadius: theme.radius.input,
                  border: selected ? `1.5px solid ${colour}` : `1.5px solid ${theme.color.border}`,
                  background: selected ? `${colour}14` : theme.color.surface,
                  color: selected ? colour : theme.color.ink,
                  fontFamily: 'inherit',
                  fontSize: theme.type.size.sm,
                  fontWeight: selected ? theme.type.weight.semibold : theme.type.weight.medium,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                  transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
                }}
              >
                <span>{opt.label}</span>
                <span
                  aria-hidden
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: theme.radius.pill,
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: selected ? 'none' : `1.5px solid ${theme.color.border}`,
                    background: selected ? colour : 'transparent',
                  }}
                >
                  {selected ? <Check size={12} strokeWidth={3} color={theme.color.surface} /> : null}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
          <label
            htmlFor="call-outcome-note"
            style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.ink }}
          >
            Note (optional)
          </label>
          <textarea
            id="call-outcome-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={submitting}
            rows={4}
            placeholder="e.g. Asked to be called back after 6pm; number rang out with no voicemail set up."
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 96,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.input,
              padding: theme.space[3],
              fontFamily: 'inherit',
              fontSize: theme.type.size.base,
              lineHeight: theme.type.leading.normal,
              color: theme.color.ink,
              background: theme.color.surface,
              outline: 'none',
            }}
          />
        </div>

        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert, fontWeight: theme.type.weight.medium }}>
            {error}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
