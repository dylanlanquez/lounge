import { MessageSquareQuote } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';

// Read-only callout for the note the patient typed into the booking
// widget. Distinct from AppointmentNotesHero (the staff customer-
// service handoff note) so the floor team can tell what's a customer
// request vs an internal CS instruction.
//
// Self-suppresses when there's no customer note. Visual weight
// matches the other detail cards on AppointmentDetail / VisitDetail
// (Booking details, Intake answers, etc.) — quiet card chrome,
// small icon, sensible body text. No heavy left border, no big
// accent colours.

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
    <Card padding="lg">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          marginBottom: theme.space[3],
        }}
      >
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
          <MessageSquareQuote size={15} aria-hidden />
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
          Note from {speaker}
        </h3>
      </div>
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
    </Card>
  );
}
