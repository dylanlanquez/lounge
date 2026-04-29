import { type ReactNode, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card } from '../Card/Card.tsx';
import { theme } from '../../theme/index.ts';

// Collapsible card surface used by the patient profile's heavy
// sections (Appointments, Case history, Signed waivers). Closed by
// default so the profile reads short on first paint; the receptionist
// expands the section they need.
//
// Animation: CSS Grid's `grid-template-rows: 0fr → 1fr` transition.
// The trick keeps content in the DOM at all times (so click handlers,
// focus, and inflight pagination state survive collapse) and animates
// the height without measuring the DOM. Inner div carries
// `overflow: hidden` so the body clips during the transition.
//
// Header is a button — click anywhere on it to toggle, with the
// chevron rotating 180° as the affordance.

export interface CollapsibleCardProps {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsibleCard({
  icon,
  title,
  meta,
  defaultOpen = false,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const headerId = `lng-collapsible-${title.toLowerCase().replace(/\s+/g, '-')}-header`;
  const panelId = `lng-collapsible-${title.toLowerCase().replace(/\s+/g, '-')}-panel`;

  return (
    <Card padding="lg">
      <button
        type="button"
        id={headerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        style={{
          appearance: 'none',
          width: '100%',
          padding: 0,
          margin: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[3],
          textAlign: 'left',
          fontFamily: 'inherit',
          color: theme.color.ink,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], minWidth: 0 }}>
          {icon}
          <h2
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </h2>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[3], flexShrink: 0 }}>
          {meta ? (
            <span
              style={{
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: theme.type.weight.medium,
              }}
            >
              {meta}
            </span>
          ) : null}
          <ChevronDown
            size={20}
            color={theme.color.inkSubtle}
            aria-hidden
            style={{
              flexShrink: 0,
              transition: `transform ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </span>
      </button>

      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: `grid-template-rows ${theme.motion.duration.base}ms ${theme.motion.easing.spring}`,
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          {/* Hairline + spacer only show when the section is expanded —
              the chevron + the gap from the parent column flow handle
              the closed state's visual rhythm. */}
          <div
            style={{
              height: 1,
              background: theme.color.border,
              margin: `${theme.space[4]}px 0 ${theme.space[5]}px`,
            }}
          />
          {children}
        </div>
      </div>
    </Card>
  );
}
