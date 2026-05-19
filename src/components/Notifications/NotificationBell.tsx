import { useState } from 'react';
import { Bell } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useNotifications } from '../../lib/queries/notifications.ts';
import { NotificationsSheet } from './NotificationsSheet.tsx';

// Notification bell + drawer opener. Lives in the KioskStatusBar
// next to the battery / wifi cluster. Subtle accent-coloured dot
// in the top-right corner when there are unseen notifications.
// Clicking opens the drawer AND immediately resets the unseen
// count (Linear / Slack / Stripe Inbox convention — the bell is
// "seen everything as of when you tapped me").
//
// The realtime subscription + data fetch lives in useNotifications,
// so the bell stays cheap even while the sheet is closed — it just
// reads the cached count off the hook.

interface NotificationBellProps {
  // Glyph size in px. Drives both the icon and the padding
  // around it so the button stays proportionally tappable across
  // the 32px kiosk bar and the older TopBar's 56px row.
  size?: number;
  // Background colour the dot's halo blends into. Defaults to the
  // KioskStatusBar surface colour. Pass the page bg if the bell
  // ever lands outside that container.
  haloColor?: string;
  // Optional accessible label override. Default reads the unseen
  // count for screen readers.
  ariaLabel?: string;
}

export function NotificationBell({
  size = 22,
  haloColor = theme.color.surface,
  ariaLabel,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const { unseenCount } = notifications;
  const hasUnseen = unseenCount > 0;

  // Padding scales with icon size so the tap target matches the
  // surface. Min 2px so a very small icon still has breathing room
  // inside a tight kiosk bar; ratio 0.36 hits the iOS HIG minimum
  // tap target on the default size while still fitting a 32px bar
  // when size=15.
  const pad = Math.max(2, Math.round(size * 0.36));
  // Dot offset matches the padding so the dot lands on the bell's
  // top-right corner regardless of icon size.
  const dotInset = pad - 2;
  // Dot size scales with the icon — 8/22 ratio on the default size.
  const dotSize = Math.max(6, Math.round(size * 0.36));

  const openSheet = () => {
    setOpen(true);
    // Mark viewed the moment the sheet opens. The realtime channel
    // continues to deliver new events; the unseenCount the hook
    // exposes recomputes from "rows newer than last_viewed_at" so
    // events that arrive while the sheet is open will re-light the
    // badge once it closes. Matches Linear's inbox behaviour.
    void notifications.markViewed();
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        aria-label={
          ariaLabel ??
          (hasUnseen
            ? `Notifications — ${unseenCount} new`
            : 'Notifications')
        }
        title="Notifications"
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.ink,
          cursor: 'pointer',
          padding: pad,
          borderRadius: theme.radius.pill,
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
          outline: 'none',
        }}
      >
        <Bell size={size} aria-hidden />
        {hasUnseen ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: dotInset,
              right: dotInset,
              width: dotSize,
              height: dotSize,
              borderRadius: theme.radius.pill,
              background: theme.color.accent,
              // Soft ring matching the host bar's surface so the dot
              // reads as a coin sitting ON the bell rather than a
              // pixel pressed into it.
              boxShadow: `0 0 0 2px ${haloColor}`,
            }}
          />
        ) : null}
      </button>

      <NotificationsSheet
        open={open}
        onClose={() => setOpen(false)}
        notifications={notifications}
      />
    </>
  );
}
