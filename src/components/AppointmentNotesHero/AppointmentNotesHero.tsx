import { useEffect, useState } from 'react';
import { AlertTriangle, Pencil, StickyNote } from 'lucide-react';
import { Button, Card } from '../index.ts';
import { theme } from '../../theme/index.ts';
import { editAppointment } from '../../lib/queries/editAppointment.ts';
import { logFailure } from '../../lib/failureLog.ts';

// Customer-service note for the clinic team. Surfaces the
// lng_appointments.notes column with a hero amber callout when there
// is content, and a quieter "Add note" affordance when empty + still
// editable. Rendered above the detail grid on AppointmentDetail and
// above the body on VisitDetail so the clinic floor sees it before
// any other card.
//
// Editable by any active Lounge staff member at any time — completed
// visits often need a follow-up note for next time, and Calendly
// bookings carry no notes column in Calendly itself so editing here
// doesn't drift from any source of truth. Every save writes a
// patient_events audit row with actor_account_id via editAppointment.
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

  // HERO: tinted-orange callout, impossible to miss. Matches the
  // "warning, do not ignore" pattern (deposit-failed banner,
  // unsuitable status pill) used elsewhere in the app.
  if (isHero) {
    return (
      <div
        role="note"
        aria-label="Customer service note"
        style={{
          padding: theme.space[5],
          background: 'rgba(179, 104, 21, 0.10)',
          border: '1px solid rgba(179, 104, 21, 0.30)',
          borderLeft: `5px solid ${theme.color.warn}`,
          borderRadius: theme.radius.card,
          display: 'flex',
          gap: theme.space[4],
          alignItems: 'flex-start',
        }}
      >
        <AlertTriangle
          size={22}
          aria-hidden
          style={{ color: theme.color.warn, flexShrink: 0, marginTop: 2 }}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[2],
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: theme.space[3],
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.xs,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.warn,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Customer service note
            </span>
            {editButton}
          </div>
          {editing ? (
            editingBody
          ) : (
            <p
              style={{
                margin: 0,
                fontSize: theme.type.size.lg,
                fontWeight: theme.type.weight.medium,
                color: theme.color.ink,
                lineHeight: theme.type.leading.relaxed,
                whiteSpace: 'pre-wrap',
              }}
            >
              {trimmed}
            </p>
          )}
        </div>
      </div>
    );
  }

  // EMPTY + editable fallback: muted card with an "Add note" prompt.
  return (
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          marginBottom: editing ? theme.space[3] : 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
          <StickyNote size={15} aria-hidden style={{ color: theme.color.inkMuted }} />
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            Customer service note
          </span>
        </div>
        {editButton}
      </div>
      {editing ? (
        editingBody
      ) : (
        <p
          style={{
            margin: editing ? 0 : `${theme.space[2]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontStyle: 'italic',
          }}
        >
          No note yet. Leave one here so the clinic team notices anything they need to know about this appointment on the day.
        </p>
      )}
    </Card>
  );
}
