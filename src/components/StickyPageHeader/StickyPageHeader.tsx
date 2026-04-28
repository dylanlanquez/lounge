import { type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';
import { KIOSK_STATUS_BAR_HEIGHT } from '../KioskStatusBar/KioskStatusBar.tsx';

// Compact sticky header for list-style pages (Patients, In clinic).
// Sits directly under the always-visible KioskStatusBar so titles +
// search input stay reachable as the list scrolls. Visual chrome is
// deliberately quiet — page background, hairline below, no shadow —
// because the pinned area must not compete with row content for
// attention.
//
// Two children slots: title + meta (right-aligned), and the body
// (typically a search input). The component owns spacing and the
// pinning behaviour; consumers own the content.

export interface StickyPageHeaderProps {
  title: string;
  meta?: ReactNode;
  body?: ReactNode;
  // The page's outer horizontal padding so the pinned header bleeds
  // edge-to-edge while still aligning the inner content with the
  // page's max-width container.
  outerPaddingX: number;
  innerMaxWidth: number;
}

export function StickyPageHeader({
  title,
  meta,
  body,
  outerPaddingX,
  innerMaxWidth,
}: StickyPageHeaderProps) {
  return (
    <header
      style={{
        // Sit immediately below the KioskStatusBar so the title isn't
        // clipped by the device chrome.
        position: 'sticky',
        top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        zIndex: 10,
        background: theme.color.bg,
        borderBottom: `1px solid ${theme.color.border}`,
        // Bleed edge-to-edge — the consumer wraps its content in a
        // max-width container so we want the bar to fill the whole
        // viewport for the pinned effect to read.
        marginLeft: -outerPaddingX,
        marginRight: -outerPaddingX,
        padding: `${theme.space[3]}px ${outerPaddingX}px`,
        marginBottom: theme.space[5],
      }}
    >
      <div
        style={{
          maxWidth: innerMaxWidth,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: theme.type.size.lg,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              color: theme.color.ink,
            }}
          >
            {title}
          </h1>
          {meta ? <div>{meta}</div> : null}
        </div>
        {body ? <div>{body}</div> : null}
      </div>
    </header>
  );
}
