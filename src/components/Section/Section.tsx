import { type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Tooltip } from '../Tooltip/Tooltip.tsx';

// Section header pattern lifted from src/routes/Arrival.tsx and used
// across the booking sheets (new-booking, reschedule).
//
// Visual shape:
//   bold black H2 title (theme.type.size.md, weight.semibold,
//                        tracking.tight, ink colour)
//   optional (i) tooltip — light variant, opens beside the title
//   optional red asterisk for required fields
//   then the control(s)
//
// Static "what does this field do" guidance lives in the tooltip.
// Dynamic per-section state (e.g. duration once a service is picked)
// belongs in a sibling InlineHint inside the section's content, not
// in a header subtitle — keeps the header clean and the dynamic
// state visually distinct.

export interface SectionProps {
  title: string;
  // Optional (i) tooltip — typically a sentence or two describing
  // what the field does. Rendered with the light Tooltip variant so
  // it reads as a help card, not an inline annotation.
  info?: ReactNode;
  // Renders a small red asterisk after the title — same affordance
  // the arrival form's required fields use.
  required?: boolean;
  children: ReactNode;
}

export function Section({
  title,
  info,
  required = false,
  children,
}: SectionProps) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.space[2],
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {title}
          {required ? (
            <span
              aria-hidden
              style={{
                color: theme.color.alert,
                fontWeight: theme.type.weight.semibold,
                marginLeft: 4,
              }}
            >
              *
            </span>
          ) : null}
        </h2>
        {info ? (
          <Tooltip align="start" maxWidth={300} variant="light" content={info}>
            <button
              type="button"
              aria-label={`More about: ${title}`}
              style={{
                appearance: 'none',
                border: 'none',
                background: 'transparent',
                padding: theme.space[1],
                margin: 0,
                borderRadius: theme.radius.pill,
                color: theme.color.inkSubtle,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Info size={14} aria-hidden />
            </button>
          </Tooltip>
        ) : null}
      </header>
      <div>{children}</div>
    </section>
  );
}
