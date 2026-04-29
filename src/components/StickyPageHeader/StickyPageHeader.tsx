import { type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';
import { KIOSK_STATUS_BAR_HEIGHT } from '../KioskStatusBar/KioskStatusBar.tsx';

// Two-row header for list-style pages (Patients, In clinic).
//
// Structure:
//   - Title + meta row in normal document flow. Scrolls away as the
//     user scrolls down — Apple HIG calls this the "large title"
//     pattern. When the user scrolls back to the top, the title
//     simply re-enters the viewport because it was always there in
//     the DOM, no re-render or animation needed.
//   - Search row pinned via `position: sticky` directly under the
//     KioskStatusBar so the receptionist can search at any depth.
//     Its bg + border-bottom give the pinned look; padding inside
//     the sticky element (rather than margin outside) keeps the bg
//     attached when the bar pins.
//
// Visual chrome stays quiet — page background, hairline below the
// search row only, no shadow — because the pinned area must not
// compete with row content for attention.

export interface StickyPageHeaderProps {
  title: string;
  meta?: ReactNode;
  body?: ReactNode;
  // The page's outer horizontal padding so the pinned bar bleeds
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
    <>
      {/* Large title — normal flow, scrolls away with the rest of
          the page. Reappears naturally on scroll-back-to-top. */}
      <div
        style={{
          maxWidth: innerMaxWidth,
          margin: '0 auto',
          padding: `${theme.space[6]}px 0 ${theme.space[4]}px`,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.space[3],
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: theme.type.size.xl,
            fontWeight: theme.type.weight.semibold,
            letterSpacing: theme.type.tracking.tight,
            color: theme.color.ink,
          }}
        >
          {title}
        </h1>
        {meta ? <div>{meta}</div> : null}
      </div>

      {/* Search row — pinned just under the kiosk status bar. The
          sticky element's own padding handles the breathing space
          below the input so the cream background stays attached
          while pinned, instead of relying on margin-bottom which
          can detach from a sticky element under scroll. */}
      {body ? (
        <div
          style={{
            position: 'sticky',
            top: `calc(${KIOSK_STATUS_BAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
            zIndex: 10,
            background: theme.color.bg,
            borderBottom: `1px solid ${theme.color.border}`,
            marginLeft: -outerPaddingX,
            marginRight: -outerPaddingX,
            padding: `${theme.space[3]}px ${outerPaddingX}px ${theme.space[4]}px`,
            marginBottom: theme.space[6],
          }}
        >
          <div
            style={{
              maxWidth: innerMaxWidth,
              margin: '0 auto',
            }}
          >
            {body}
          </div>
        </div>
      ) : null}
    </>
  );
}
