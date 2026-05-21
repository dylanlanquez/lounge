import { useEffect, useState } from 'react';
import { Pencil, StickyNote } from 'lucide-react';
import { Button, Card } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { editAppointment } from '../../lib/queries/editAppointment.ts';
import { logFailure } from '../../lib/failureLog.ts';

// Customer-service note for the clinic team. Renders the
// lng_appointments.notes column as a quiet detail card that matches
// the visual weight of the other cards on AppointmentDetail /
// VisitDetail (Booking details, Intake answers, etc.). Editable in
// place by any active Lounge staff member at any time.
//
// Distinct from the patient-typed widget note (CustomerNoteHero) —
// this is the internal handoff. Visual cue is just the StickyNote
// icon + the title; no heavy accent colours, no thick borders.
//
// The note carries through every reschedule (rescheduleAppointment.ts
// copies notes onto the new row) and stays attached as the visit
// moves booked → arrived → joined → complete.

export interface AppointmentNotesHeroProps {
  appointmentId: string;
  notes: string | null;
  onChanged: () => void;
}

export function AppointmentNotesHero({
  appointmentId,
  notes,
  onChanged,
}: AppointmentNotesHeroProps) {
  const trimmed = notes?.trim() ?? '';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trimmed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft when the underlying notes change (another tab
  // edited the row). Only when not actively editing — clobbering a
  // half-typed edit would be worse than ignoring the upstream change.
  useEffect(() => {
    if (!editing) setDraft(trimmed);
  }, [editing, trimmed]);

  const isHero = trimmed.length > 0;

  const handleSave = async () => {
    if (saving) return;
    setError(null);
    const next = draft.trim();
    if (next === trimmed) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editAppointment({ appointmentId, notes: next.length > 0 ? next : null });
      setEditing(false);
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save note';
      await logFailure({
        source: 'AppointmentNotesHero.save',
        severity: 'error',
        message,
        context: { appointmentId },
      });
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(trimmed);
    setError(null);
    setEditing(false);
  };

  const editButton = !editing ? (
    <button
      type="button"
      aria-label={trimmed.length > 0 ? 'Edit note' : 'Add note'}
      title={trimmed.length > 0 ? 'Edit note' : 'Add note'}
      onClick={() => setEditing(true)}
      style={{
        appearance: 'none',
        border: `1px solid ${theme.color.border}`,
        background: theme.color.surface,
        color: theme.color.inkMuted,
        cursor: 'pointer',
        padding: 0,
        width: 30,
        height: 30,
        borderRadius: theme.radius.pill,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: `border-color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = theme.color.ink;
        e.currentTarget.style.color = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = theme.color.border;
        e.currentTarget.style.color = theme.color.inkMuted;
      }}
    >
      <Pencil size={13} aria-hidden />
    </button>
  ) : null;

  const editingBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={saving}
        autoFocus
        rows={4}
        placeholder="Customer service: anything the clinic floor must notice on the day — accessibility, behavioural cues, special requests, follow-up reminders."
        style={{
          fontFamily: 'inherit',
          fontSize: theme.type.size.sm,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.input,
          padding: theme.space[3],
          color: theme.color.ink,
          background: theme.color.surface,
          outline: 'none',
          resize: 'vertical',
          lineHeight: theme.type.leading.relaxed,
        }}
      />
      {error ? (
        <p style={{ margin: 0, fontSize: theme.type.size.xs, color: theme.color.alert }}>{error}</p>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
        <Button variant="tertiary" size="sm" onClick={handleCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} loading={saving} disabled={saving}>
          {saving ? 'Saving…' : 'Save note'}
        </Button>
      </div>
    </div>
  );

  // Single chrome for both populated + empty states. Matches the
  // Booking details / Intake answers cards on the same page —
  // Card padding="lg", small circled icon, sensible heading,
  // sm body text. Hero amber callout was Dylan's call to scrap;
  // visual weight now mirrors the rest of the page.
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          marginBottom: theme.space[3],
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: theme.radius.pill,
              background: theme.color.accentBg,
              color: theme.color.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <StickyNote size={15} aria-hidden />
          </span>
          <h3
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            Customer service note
          </h3>
        </div>
        {editButton}
      </div>
      {editing ? (
        editingBody
      ) : isHero ? (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.ink,
            lineHeight: theme.type.leading.snug,
            whiteSpace: 'pre-wrap',
          }}
        >
          {trimmed}
        </p>
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontStyle: 'italic',
            lineHeight: theme.type.leading.snug,
          }}
        >
          No note yet. Leave one here so the clinic team notices anything they need to know about this appointment on the day.
        </p>
      )}
    </Card>
  );
}
