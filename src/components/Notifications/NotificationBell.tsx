import { useState } from 'react';
import { Bell } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useNotifications } from '../../lib/queries/notifications.ts';
import { NotificationsSheet } from './NotificationsSheet.tsx';

// The TopBar bell. Renders a Lucide Bell icon button with a subtle
// accent-coloured dot in the top-right corner when there are
// unseen notifications. Clicking opens the drawer AND immediately
// resets the unseen count (Linear / Slack / Stripe Inbox
// convention — the bell is "seen everything as of when you tapped
// me").
//
// The realtime subscription + data fetch lives in useNotifications,
// so the bell stays cheap even while the sheet is closed — it just
// reads the cached count off the hook.

interface NotificationBellProps {
  // Pass-through for the TopBar size token. The header is dense on
  // mobile and roomy on desktop; the icon scales accordingly.
  size?: number;
  // Optional accessible label override. Default reads the unseen
  // count for screen readers.
  ariaLabel?: string;
}

export function NotificationBell({ size = 22, ariaLabel }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const { unseenCount } = notifications;
  const hasUnseen = unseenCount > 0;

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
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.ink,
          cursor: 'pointer',
          padding: theme.space[2],
          borderRadius: theme.radius.pill,
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Bell size={size} aria-hidden />
        {hasUnseen ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 8,
              height: 8,
              borderRadius: theme.radius.pill,
              background: theme.color.accent,
              // Soft ring matching the TopBar background so the dot
              // reads as a coin sitting ON the bell rather than a
              // pixel pressed into it. Two-stop box-shadow gives a
              // halo without an alpha border.
              boxShadow: `0 0 0 2px ${theme.color.bg}`,
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
