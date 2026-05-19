import { useEffect, useMemo, useState } from 'react';
import { Bell, ChevronLeft, Search, Settings, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { theme } from '../../theme/index.ts';
import { Button } from '../Button/Button.tsx';
import {
  filterNotifications,
  groupNotificationsByDay,
  type UseNotificationsResult,
} from '../../lib/queries/notifications.ts';
import { NotificationRow } from './NotificationRow.tsx';
import { NotificationsSettings } from './NotificationsSettings.tsx';

// Drawer for the TopBar notifications bell. Uses a custom portal +
// sheet rather than the shared BottomSheet because we need the
// header to combine three controls (title, search, settings cog,
// close) in two rows and the standard BottomSheet header doesn't
// have the right slots — its title/description live above an
// optional close button, with no horizontal control row.
//
// Lifecycle:
//   • Bell opens the sheet AND fires markViewed() on the parent
//     so the unseen count resets the moment the drawer appears.
//   • Closing the sheet (X / Esc / backdrop) calls onClose only;
//     viewed state is already committed.
//   • Settings is a NESTED view inside the same sheet — the
//     header chevron navigates back to the list without closing.

interface NotificationsSheetProps {
  open: boolean;
  onClose: () => void;
  notifications: UseNotificationsResult;
}

type View = 'list' | 'settings';

export function NotificationsSheet({ open, onClose, notifications }: NotificationsSheetProps) {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('list');
  const [search, setSearch] = useState('');

  // Reset internal state on each fresh open so a previous search
  // or settings drilldown doesn't bleed across openings.
  useEffect(() => {
    if (open) {
      setView('list');
      setSearch('');
    }
  }, [open]);

  // Lock root scroll while the sheet is open. We also pad the
  // root by the disappearing scrollbar's width so a centred portal
  // doesn't visibly shift sideways the moment the bell opens —
  // the previous "tiniest glimpse" flash Dylan saw was the
  // scrollbar collapsing and the popup recentering 7-8 px to the
  // left in the same paint. Compensating before flipping overflow
  // keeps the layout pinned. Identical pattern is applied in
  // BottomSheet so every modal surface behaves the same way.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const root = document.getElementById('root');
    const prevOverflow = root?.style.overflow ?? '';
    const prevPaddingRight = root?.style.paddingRight ?? '';
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    if (root) {
      if (scrollbarWidth > 0) {
        root.style.paddingRight = `${scrollbarWidth}px`;
      }
      root.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      if (root) {
        root.style.overflow = prevOverflow;
        root.style.paddingRight = prevPaddingRight;
      }
    };
  }, [open, onClose]);

  const filteredRows = useMemo(
    () => filterNotifications(notifications.rows, search),
    [notifications.rows, search],
  );
  const sections = useMemo(
    () => groupNotificationsByDay(filteredRows),
    [filteredRows],
  );
  const unseenCutoff = notifications.lastViewedAt;
  const hasResults = filteredRows.length > 0;
  const hasAnyRows = notifications.rows.length > 0;

  const handleRowActivate = (linkPath: string) => {
    navigate(linkPath);
    onClose();
  };

  const handleMarkAllRead = async () => {
    await notifications.markViewed();
  };

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: theme.color.overlay,
          animation: 'lng-fade 200ms ease-out',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 720,
          background: theme.color.surface,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          // Pinned to a single height across both views. The
          // notifications list and the settings panel have very
          // different content lengths, and the previous maxHeight
          // approach let the sheet collapse when settings was
          // active — the toggling jump read as glitchy. A fixed
          // 88dvh keeps the surface stationary; the inner body
          // scrolls within when content overflows, and a
          // shorter view (settings) just has trailing whitespace
          // — the same pattern Linear / Notion use for panels
          // that have multiple sub-views.
          height: '88dvh',
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: `env(safe-area-inset-bottom, 0px)`,
          animation: 'lng-sheet-up 280ms cubic-bezier(0.25, 1, 0.3, 1)',
          boxShadow: theme.shadow.overlay,
          overflow: 'hidden',
        }}
      >
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: theme.space[3] }}>
          <span
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: theme.color.border,
            }}
          />
        </div>

        {/* Header. Two rows: title + actions on top, search input
            on bottom (list view only). Settings view replaces the
            search row with a back-only header. */}
        <header
          style={{
            padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[3]}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[3],
            borderBottom: `1px solid ${theme.color.border}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: theme.space[3],
            }}
          >
            {view === 'settings' ? (
              <button
                type="button"
                onClick={() => setView('list')}
                aria-label="Back to notifications"
                style={iconButtonStyle()}
              >
                <ChevronLeft size={22} />
              </button>
            ) : null}
            <h2
              style={{
                margin: 0,
                flex: 1,
                fontSize: theme.type.size.xl,
                fontWeight: theme.type.weight.semibold,
                letterSpacing: theme.type.tracking.tight,
                color: theme.color.ink,
              }}
            >
              {view === 'settings' ? 'Notification settings' : 'Notifications'}
            </h2>
            {view === 'list' ? (
              <button
                type="button"
                onClick={() => setView('settings')}
                aria-label="Notification settings"
                style={iconButtonStyle()}
              >
                <Settings size={20} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={iconButtonStyle()}
            >
              <X size={22} />
            </button>
          </div>

          {/* Search row. Kept in the DOM in both views so the
              header doesn't snap when switching panes — animates
              maxHeight + opacity instead, matching the body
              cross-fade timing. aria-hidden + pointer-events
              cleanly inert it on the settings view. */}
          <div
            aria-hidden={view !== 'list'}
            style={{
              maxHeight: view === 'list' ? 48 : 0,
              opacity: view === 'list' ? 1 : 0,
              pointerEvents: view === 'list' ? 'auto' : 'none',
              overflow: 'hidden',
              transition: `max-height 240ms cubic-bezier(0.25, 1, 0.3, 1), opacity 200ms ease-out`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: theme.space[2],
                background: theme.color.bg,
                borderRadius: theme.radius.pill,
                padding: `${theme.space[2]}px ${theme.space[4]}px`,
              }}
            >
              <Search size={16} color={theme.color.inkMuted} aria-hidden />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search by patient or booking type"
                style={{
                  appearance: 'none',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  flex: 1,
                  minWidth: 0,
                  fontSize: theme.type.size.sm,
                  color: theme.color.ink,
                  fontFamily: 'inherit',
                  padding: `${theme.space[1]}px 0`,
                }}
                autoCorrect="off"
                spellCheck={false}
                tabIndex={view === 'list' ? 0 : -1}
              />
              {search.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  style={{
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    color: theme.color.inkMuted,
                    cursor: 'pointer',
                    padding: theme.space[1],
                  }}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          </div>
        </header>

        {/* Body. Both views are mounted simultaneously, stacked
            absolutely in the same scroll-clipped container. View
            switches translate the active view in from a small
            offset while cross-fading opacity, which gives an
            iOS-like push transition rather than the previous
            instant content swap. pointer-events on the hidden
            view stops phantom clicks landing on it during the
            fade. The fixed 88dvh sheet height means the layout
            doesn't reflow when settings (shorter) takes over. */}
        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            background: theme.color.bg,
          }}
        >
          <ViewPane visible={view === 'list'} direction="left">
            {notifications.loading && !hasAnyRows ? (
              <Status text="Loading notifications…" />
            ) : notifications.error ? (
              <Status text={notifications.error} tone="alert" />
            ) : !hasAnyRows ? (
              <EmptyState
                title="You're all caught up"
                description="New bookings, reschedules, cancellations, and ended visits show up here. Pick which types you want in Settings."
              />
            ) : !hasResults ? (
              <Status text={`No notifications match "${search.trim()}".`} />
            ) : (
              <div>
                {sections.map((section) => (
                  <section key={section.label}>
                    <div
                      style={{
                        padding: `${theme.space[4]}px ${theme.space[6]}px ${theme.space[2]}px`,
                        fontSize: theme.type.size.xs,
                        fontWeight: theme.type.weight.semibold,
                        color: theme.color.inkMuted,
                        letterSpacing: theme.type.tracking.wide,
                        textTransform: 'uppercase',
                        background: theme.color.bg,
                        position: 'sticky',
                        top: 0,
                        zIndex: 1,
                      }}
                    >
                      {section.label}
                    </div>
                    <div style={{ background: theme.color.surface }}>
                      {section.rows.map((row) => (
                        <NotificationRow
                          key={row.id}
                          row={row}
                          unseen={unseenCutoff ? row.created_at > unseenCutoff : true}
                          highlight={search}
                          onActivate={handleRowActivate}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </ViewPane>
          <ViewPane visible={view === 'settings'} direction="right">
            <div style={{ padding: `${theme.space[5]}px ${theme.space[6]}px` }}>
              <NotificationsSettings />
            </div>
          </ViewPane>
        </div>

        {/* Footer. Always mounted so its appearance/disappearance
            fades in lockstep with the body transition instead of
            popping the layout. Tertiary "Mark all as read" is the
            only action; the entire row sits quietly when there's
            nothing to act on. */}
        <footer
          aria-hidden={view !== 'list' || !hasAnyRows}
          style={{
            flexShrink: 0,
            borderTop: `1px solid ${theme.color.border}`,
            padding: `${theme.space[3]}px ${theme.space[6]}px`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: theme.color.surface,
            opacity: view === 'list' && hasAnyRows ? 1 : 0,
            pointerEvents: view === 'list' && hasAnyRows ? 'auto' : 'none',
            transition: `opacity ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
          }}
        >
          <span
            style={{
              fontSize: theme.type.size.xs,
              color: theme.color.inkSubtle,
            }}
          >
            {notifications.unseenCount > 0
              ? `${notifications.unseenCount} new`
              : 'All read'}
          </span>
          <Button
            variant="tertiary"
            onClick={() => void handleMarkAllRead()}
            disabled={notifications.unseenCount === 0}
          >
            Mark all as read
          </Button>
        </footer>
      </div>
      {/* Keyframes live inside the portal so the bell can fire its
          sheet-up + fade animations whether or not any BottomSheet
          is also mounted. Without this, opening the bell from a
          screen with no other modal active rendered the sheet at
          its final position immediately — no slide, which made the
          appearance read as a flash. */}
      <style>{`
        @keyframes lng-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes lng-sheet-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

// Absolute-stacked scroll container used to host the list and the
// settings pane in the same body slot. Drives the push transition
// when the active view flips. `direction` defines which side the
// pane slides in from when it becomes visible — `left` for the
// notifications list (entered via the back chevron from settings),
// `right` for the settings pane (entered via the cog from the list).
// Hidden panes keep their last-rendered DOM in place so back-navigation
// doesn't trigger a remount + scroll-jump.
function ViewPane({
  visible,
  direction,
  children,
}: {
  visible: boolean;
  direction: 'left' | 'right';
  children: React.ReactNode;
}) {
  const offset = direction === 'right' ? 24 : -24;
  return (
    <div
      aria-hidden={!visible}
      style={{
        position: 'absolute',
        inset: 0,
        overflowY: 'auto',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : `translateX(${offset}px)`,
        pointerEvents: visible ? 'auto' : 'none',
        transition: `opacity 220ms ease-out, transform 280ms cubic-bezier(0.25, 1, 0.3, 1)`,
      }}
    >
      {children}
    </div>
  );
}

function Status({ text, tone = 'muted' }: { text: string; tone?: 'muted' | 'alert' }) {
  return (
    <p
      style={{
        margin: 0,
        padding: `${theme.space[8]}px ${theme.space[6]}px`,
        textAlign: 'center',
        fontSize: theme.type.size.sm,
        color: tone === 'alert' ? theme.color.alert : theme.color.inkMuted,
      }}
    >
      {text}
    </p>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: theme.space[3],
        padding: `${theme.space[12]}px ${theme.space[6]}px`,
        textAlign: 'center',
      }}
    >
      <span
        style={{
          width: 56,
          height: 56,
          borderRadius: theme.radius.pill,
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.color.inkMuted,
        }}
      >
        <Bell size={24} />
      </span>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.md,
          fontWeight: theme.type.weight.semibold,
          color: theme.color.ink,
        }}
      >
        {title}
      </p>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.inkMuted,
          maxWidth: 360,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {description}
      </p>
    </div>
  );
}

function iconButtonStyle(): React.CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: theme.color.ink,
    cursor: 'pointer',
    padding: theme.space[2],
    borderRadius: theme.radius.pill,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
