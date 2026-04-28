import { useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';
import { Avatar } from '../Avatar/Avatar.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Button } from '../Button/Button.tsx';
import { CalendarIcon } from '../Icons/CalendarIcon.tsx';
import { ToothIcon } from '../Icons/ToothIcon.tsx';

// Returns true when the bottom nav should render. Pulled out as a named
// helper so App can apply the matching bottom padding to its routes
// without re-implementing the rule.
export function shouldShowBottomNav(pathname: string, signedIn: boolean): boolean {
  if (!signedIn) return false;
  if (pathname === '/sign-in') return false;
  // Arrival wizard takes over the full surface so the patient doesn't
  // tap out mid-flow (the iPad is handed across the desk for the
  // customer-facing steps).
  if (pathname.startsWith('/arrival/')) return false;
  return true;
}

// Height the nav reserves for content. Pages add this as bottom padding so
// nothing hides under the floating pill. Includes the pill's height, the
// gap below it, and breathing room for the FAB that hangs above it. The
// BottomSheet footer also reads from this constant so its top hairline
// stays vertically consistent with the system's bottom rhythm.
export const BOTTOM_NAV_HEIGHT = 88;

// Internal — the actual visible pill height. Slightly slimmer than
// BOTTOM_NAV_HEIGHT so pages have a touch of free space between their
// content and the pill, which makes the floating effect read.
const PILL_HEIGHT = 68;
const PILL_BOTTOM_GAP = 10;
const PILL_MAX_WIDTH = 600;
// FAB diameter. Pulled up to extend above the pill's top edge by half
// of itself, so the bottom half sits inside the pill flow.
const FAB_SIZE = 64;
const FAB_LIFT = 28; // px the circle rises above the pill's top edge

// FAB-docked bottom navigation: 4 standard tab items + a centred raised
// action button (Walk-in) that extends above the nav. Pattern lifted from
// Material Design 3, adapted to Lounge's flat hairline aesthetic. The
// FAB's ink fill matches the existing primary-button colour so it reads
// as the dominant action of the surface, distinct from the muted nav
// items either side of it.
//
// Order, left to right:
//   Schedule | Patients | (FAB Walk-in) | In clinic | Profile
//
// Sign out lives inside the Profile sheet — the receptionist signs out
// from there, freeing a slot on the bar. Admin moves to the kiosk top
// bar (next to WiFi / battery) so it's still one tap away without
// crowding the primary surface.

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);

  if (!shouldShowBottomNav(location.pathname, !!user)) return null;

  const onSchedule = () => navigate('/schedule');
  const onPatients = () => navigate('/patients');
  const onWalkIn = () => navigate('/walk-in/new');
  const onInClinic = () => navigate('/in-clinic');
  const onSignOut = () => {
    void signOut();
  };
  const onProfile = () => setProfileOpen(true);

  const isSchedule = location.pathname === '/' || location.pathname.startsWith('/schedule');
  const isPatients = location.pathname.startsWith('/patients');
  const isWalkIn = location.pathname.startsWith('/walk-in');
  const isInClinic = location.pathname.startsWith('/in-clinic');

  return (
    <>
      {/* Outer non-interactive bleed bar — full-width fixed positioning
          that lets the inner pill centre itself horizontally. The pill
          itself owns all visual chrome; this wrapper only handles
          placement and gives pointer-events back to the pill so taps
          on the surrounding cream don't get swallowed. */}
      <div
        aria-hidden="false"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: `calc(${PILL_BOTTOM_GAP}px + env(safe-area-inset-bottom, 0px))`,
          zIndex: 50,
          display: 'flex',
          justifyContent: 'center',
          padding: `0 ${theme.space[4]}px`,
          pointerEvents: 'none',
        }}
      >
        <nav
          aria-label="Primary"
          style={{
            pointerEvents: 'auto',
            width: '100%',
            maxWidth: PILL_MAX_WIDTH,
            height: PILL_HEIGHT,
            borderRadius: theme.radius.pill,
            // Frosted-glass surface. The translucent white reads
            // calm on the cream page background; the saturate boost
            // keeps the colour feel of whatever's behind from going
            // grey under the blur.
            background: 'rgba(255, 255, 255, 0.72)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            border: '1px solid rgba(255, 255, 255, 0.55)',
            boxShadow:
              '0 18px 48px rgba(14, 20, 20, 0.14), 0 4px 14px rgba(14, 20, 20, 0.08)',
            position: 'relative',
          }}
        >
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              height: '100%',
              display: 'grid',
              gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
              alignItems: 'stretch',
              position: 'relative',
            }}
          >
            <li style={{ display: 'flex' }}>
              <NavTab
                label="Schedule"
                icon={<CalendarIcon size={22} />}
                active={isSchedule}
                onClick={onSchedule}
              />
            </li>
            <li style={{ display: 'flex' }}>
              <NavTab
                label="Patients"
                icon={<Users size={22} />}
                active={isPatients}
                onClick={onPatients}
              />
            </li>
            <li style={{ display: 'flex' }}>
              <FabTab label="Walk-in" active={isWalkIn} onClick={onWalkIn} />
            </li>
            <li style={{ display: 'flex' }}>
              <NavTab
                label="In clinic"
                icon={<ToothIcon size={22} />}
                active={isInClinic}
                onClick={onInClinic}
              />
            </li>
            <li style={{ display: 'flex' }}>
              <NavTab
                label="Profile"
                icon={<Avatar name={user?.email ?? 'You'} size="sm" badge="online" />}
                active={false}
                onClick={onProfile}
              />
            </li>
          </ul>
          <BottomNavStyles />
        </nav>
      </div>

      {/* Profile sheet — minimal v1: who's signed in + sign-out shortcut. */}
      <BottomSheet
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Signed in"
        description={
          <span style={{ display: 'flex', flexDirection: 'column', gap: theme.space[1] }}>
            <span>{user?.email ?? 'No account'}</span>
            <span style={{ color: theme.color.inkSubtle, fontSize: theme.type.size.sm }}>
              Tap Sign out below to end the session.
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
    height: '100%',
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

// Centred, raised floating action button. The circle extends ABOVE the
// pill's top edge by FAB_LIFT pixels — overflow is allowed because the
// outer pill has no overflow:hidden. The accent fill (Lounge's forest
// green) gives the action a confident colour against the cream page
// without relying on stark ink for prominence.
function FabTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="lng-bottom-nav-btn lng-bottom-nav-fab"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={onClick}
      style={{
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        width: '100%',
        height: '100%',
        padding: `${theme.space[2]}px ${theme.space[1]}px ${theme.space[2]}px`,
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
        position: 'relative',
      }}
    >
      <span
        aria-hidden
        className="lng-bottom-nav-fab-circle"
        style={{
          marginTop: -FAB_LIFT,
          width: FAB_SIZE,
          height: FAB_SIZE,
          borderRadius: theme.radius.pill,
          background: theme.color.accent,
          color: theme.color.surface,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Tinted shadow in the brand accent gives the FAB a soft
          // glow rather than a heavy grey drop.
          boxShadow:
            '0 14px 32px rgba(31, 77, 58, 0.32), 0 4px 10px rgba(31, 77, 58, 0.20), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
          transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <Plus size={28} strokeWidth={2.4} />
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
  // Suppress every focus outline on nav buttons. The previous green
  // ring read as a "stuck active" state to staff after taps. Touch
  // and mouse users don't need a focus indicator here — the icon's
  // active tint already shows which page they're on. The FAB grows
  // a little on press for a tactile cue.
  return (
    <style>{`
      .lng-bottom-nav-btn:focus,
      .lng-bottom-nav-btn:focus-visible { outline: none; }
      .lng-bottom-nav-fab:active .lng-bottom-nav-fab-circle {
        transform: scale(0.96);
      }
    `}</style>
  );
}
