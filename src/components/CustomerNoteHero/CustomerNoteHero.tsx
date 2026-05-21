import { MessageSquareQuote } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// Read-only callout for the note the patient typed into the booking
// widget. Distinct from AppointmentNotesHero (the amber editable
// customer-service handoff note) so staff don't conflate
// "questions/context from the customer" with "internal CS handoff".
//
// Renders nothing when the appointment has no customer note (most
// in-person staff bookings and Calendly imports don't carry one).
//
// Tone: quiet ink-on-near-white card with a leading quote icon. Not
// alarming (it's information, not a directive), but visually pinned
// near the top of the page so the floor team sees what the patient
// asked when the booking landed.

export interface CustomerNoteHeroProps {
  /** Patient-typed note from lng_appointments.customer_note. Null
   *  or whitespace-only → the component renders nothing. */
  note: string | null;
  /** Patient first name, used as the speaker label. Falls back to
   *  "the customer" when unavailable. */
  patientFirstName?: string | null;
}

export function CustomerNoteHero({ note, patientFirstName }: CustomerNoteHeroProps) {
  const trimmed = note?.trim() ?? '';
  if (trimmed.length === 0) return null;
  const speaker = (patientFirstName ?? '').trim() || 'the customer';

  return (
    <div
      role="note"
      aria-label="Customer's booking note"
      style={{
        padding: theme.space[5],
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `5px solid ${theme.color.ink}`,
        borderRadius: theme.radius.card,
        display: 'flex',
        gap: theme.space[4],
        alignItems: 'flex-start',
      }}
    >
      <MessageSquareQuote
        size={20}
        aria-hidden
        style={{ color: theme.color.inkMuted, flexShrink: 0, marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <span
          style={{
            fontSize: theme.type.size.xs,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.inkMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Note from {speaker}
        </span>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            color: theme.color.ink,
            lineHeight: theme.type.leading.relaxed,
            whiteSpace: 'pre-wrap',
          }}
        >
          {trimmed}
        </p>
      </div>
    </div>
  );
}
