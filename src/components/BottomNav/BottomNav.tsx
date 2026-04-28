import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CalendarDays, LogOut, Plus, Settings } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';

// Returns true when the bottom nav should render. Pulled out as a named
// helper so App can apply the matching bottom padding to its routes
// without re-implementing the rule.
export function shouldShowBottomNav(pathname: string, signedIn: boolean): boolean {
  if (!signedIn) return false;
  if (pathname === '/sign-in') return false;
  return true;
}

// Height the nav reserves for content. Pages add this as bottom padding so
// nothing hides under the fixed bar. The BottomSheet footer reads from the
// same constant so its top hairline aligns with the nav's top hairline,
// and its lg-sized action buttons (56px) get comfortable breathing room.
export const BOTTOM_NAV_HEIGHT = 88;

// FAB-docked bottom navigation: 4 standard tab items + a centred raised
// action button (Walk-in) that extends above the nav. Pattern lifted from
// Material Design 3, adapted to Lounge's flat hairline aesthetic. The
// FAB's ink fill matches the existing primary-button colour so it reads
// as the dominant action of the surface, distinct from the muted nav
// items either side of it.
//
// Order, left to right:
//   Schedule | Profile | (FAB Walk-in) | Admin | Sign out

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);

  if (!shouldShowBottomNav(location.pathname, !!user)) return null;

  const onSchedule = () => navigate('/schedule');
  const onWalkIn = () => navigate('/walk-in/new');
  const onAdmin = () => navigate('/admin');
  const onSignOut = () => {
    void signOut();
  };
  const onProfile = () => setProfileOpen(true);

  const isSchedule = location.pathname === '/' || location.pathname.startsWith('/schedule');
  const isWalkIn = location.pathname.startsWith('/walk-in');
  const isAdmin = location.pathname.startsWith('/admin');

  return (
    <>
      <nav
        aria-label="Primary"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 50,
          background: theme.color.surface,
          borderTop: `1px solid ${theme.color.border}`,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            maxWidth: 880,
            marginLeft: 'auto',
            marginRight: 'auto',
            position: 'relative',
          }}
        >
          <li>
            <NavTab
              label="Schedule"
              icon={<CalendarDays size={22} />}
              active={isSchedule}
              onClick={onSchedule}
            />
          </li>
          <li>
            <NavTab
              label="Profile"
              icon={<Avatar name={user?.email ?? 'You'} size="sm" badge="online" />}
              active={false}
              onClick={onProfile}
            />
          </li>
          <li>
            <FabTab label="Walk-in" active={isWalkIn} onClick={onWalkIn} />
          </li>
          <li>
            <NavTab
              label="Admin"
              icon={<Settings size={22} />}
              active={isAdmin}
              onClick={onAdmin}
            />
          </li>
          <li>
            <NavTab
              label="Sign out"
              icon={<LogOut size={22} />}
              active={false}
              onClick={onSignOut}
            />
          </li>
        </ul>
        <BottomNavStyles />
      </nav>

      {/* Profile sheet — minimal v1: who's signed in. Will grow when we
          have a real profile page (preferences, theme, etc.). */}
      <BottomSheet
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Signed in"
        description={
          <span style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
            <span>{user?.email ?? 'No account'}</span>
            <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm }}>
              Tap Sign out in the bottom nav to end the session.
            </span>
          </span>
        }
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              onClick={() => {
                setProfileOpen(false);
                onSignOut();
              }}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[4],
            padding: `${theme.space[4]}px 0`,
          }}
        >
          <Avatar name={user?.email ?? 'You'} size="lg" badge="online" />
          <div>
            <p style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              {user?.email ?? 'No account'}
            </p>
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.sm,
                color: theme.color.inkMuted,
              }}
            >
              Receptionist
            </p>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}

interface NavTabProps {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}

function NavTab({ label, icon, active, onClick }: NavTabProps) {
  const styles: CSSProperties = {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    width: '100%',
    minHeight: BOTTOM_NAV_HEIGHT,
    padding: `${theme.space[2]}px ${theme.space[1]}px`,
    color: active ? theme.color.ink : theme.color.inkSubtle,
    fontFamily: 'inherit',
    fontSize: theme.type.size.xs,
    fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
    transition: `color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };
  return (
    <button
      type="button"
      className="lng-bottom-nav-btn"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (active) return;
        (e.currentTarget as HTMLElement).style.color = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        if (active) return;
        (e.currentTarget as HTMLElement).style.color = theme.color.inkSubtle;
      }}
      style={styles}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Centred, raised floating action button. The circle extends above the
// nav row via negative margin so it reads as the dominant action of the
// surface — pattern is Material Design's "FAB-docked" bottom navigation.
function FabTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="lng-bottom-nav-btn"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        width: '100%',
        minHeight: BOTTOM_NAV_HEIGHT,
        padding: `${theme.space[2]}px ${theme.space[1]}px`,
        color: active ? theme.color.ink : theme.color.inkMuted,
        fontFamily: 'inherit',
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          // Negative margin lifts the circle above the nav's top edge.
          // 56px circle, ~24px sits above the nav, ~32px inside.
          marginTop: -24,
          width: 56,
          height: 56,
          borderRadius: theme.radius.pill,
          background: theme.color.ink,
          color: theme.color.surface,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: theme.shadow.raised,
          transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <Plus size={26} strokeWidth={2.4} />
      </span>
      <span>{label}</span>
    </button>
  );
}

// :focus-visible only matches when the browser thinks focus came from a
// keyboard (Tab / arrow / Enter), not after a mouse click or touch tap.
// Pre-:focus-visible we ran an onFocus handler that drew the ring on every
// kind of focus, including post-click — which left a sticky border on the
// active nav item after every tap. Scoped to .lng-bottom-nav-btn so the
// rule can't leak into other surfaces.
function BottomNavStyles() {
  return (
    <style>{`
      .lng-bottom-nav-btn:focus { outline: none; }
      .lng-bottom-nav-btn:focus-visible {
        outline: 2px solid ${theme.color.focus};
        outline-offset: -4px;
        border-radius: ${theme.radius.input}px;
      }
    `}</style>
  );
}
