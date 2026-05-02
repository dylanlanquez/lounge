import { type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CalendarRange, UserPlus, Users } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useKeyboardOpen } from '../../lib/useKeyboardOpen.ts';
import { CalendarIcon } from '../Icons/CalendarIcon.tsx';
import { ToothIcon } from '../Icons/ToothIcon.tsx';
import { useActiveVisitCount } from '../../lib/queries/clinicBoard.ts';

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
// nothing hides under the floating pill.
export const BOTTOM_NAV_HEIGHT = 88;

// Internal — the actual visible pill height.
const PILL_HEIGHT = 68;
const PILL_BOTTOM_GAP = 10;
const PILL_MAX_WIDTH = 600;

// Floating-pill bottom nav: 5 equal nav tabs.
//
//   Schedule | Patients | Walk-in | In clinic | Appointments
//
// Walk-in is just another tab. An earlier design lifted Walk-in
// into a raised circular FAB; staff feedback was that it dominated
// the surface, so it's been folded back into the regular grid.
//
// Profile / sign-out moved to the kiosk top bar (next to Admin) so
// the bottom row of primary destinations stays focused on what staff
// actually navigate between every shift. Appointments takes the
// freed slot — the full booking ledger (past + future, every status)
// is referenced often enough ("what happened with this patient last
// month?", "show me every cancelled booking this week") that buring
// it in a sub-menu would slow staff down.

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const navVisible = shouldShowBottomNav(location.pathname, !!user);
  const inClinicCount = useActiveVisitCount(navVisible);

  // Hide the floating pill while the iPad on-screen keyboard is up.
  // Shared hook with the arrival ActionBar so every fixed-bottom
  // surface reads the same signal.
  const keyboardOpen = useKeyboardOpen();

  if (!navVisible) return null;
  if (keyboardOpen) return null;

  const onSchedule = () => navigate('/schedule');
  const onPatients = () => navigate('/patients');
  const onWalkIn = () => navigate('/walk-in/new');
  const onInClinic = () => navigate('/in-clinic');
  const onAppointments = () => navigate('/appointments');

  const isSchedule = location.pathname === '/' || location.pathname.startsWith('/schedule');
  const isPatients = location.pathname.startsWith('/patients');
  const isWalkIn = location.pathname.startsWith('/walk-in');
  const isInClinic = location.pathname.startsWith('/in-clinic');
  const isAppointments = location.pathname.startsWith('/appointments');

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
              <NavTab
                label="Walk-in"
                icon={<UserPlus size={22} />}
                active={isWalkIn}
                onClick={onWalkIn}
              />
            </li>
            <li style={{ display: 'flex' }}>
              <NavTab
                label="In clinic"
                icon={<ToothIcon size={22} />}
                active={isInClinic}
                onClick={onInClinic}
                badgeCount={inClinicCount}
              />
            </li>
            <li style={{ display: 'flex' }}>
              <NavTab
                label="Appointments"
                icon={<CalendarRange size={22} />}
                active={isAppointments}
                onClick={onAppointments}
              />
            </li>
          </ul>
          <BottomNavStyles />
        </nav>
      </div>
    </>
  );
}

interface NavTabProps {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  // null hides the badge (loading or error). 0 also hides — no point in
  // shouting "0 in clinic" at the receptionist. Anything > 99 renders
  // as "99+" so the pill stays compact.
  badgeCount?: number | null;
}

function NavTab({ label, icon, active, onClick, badgeCount }: NavTabProps) {
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
  const showBadge = typeof badgeCount === 'number' && badgeCount > 0;
  const badgeText = showBadge ? (badgeCount > 99 ? '99+' : String(badgeCount)) : '';
  return (
    <button
      type="button"
      className="lng-bottom-nav-btn"
      aria-current={active ? 'page' : undefined}
      aria-label={showBadge ? `${label}, ${badgeCount} in clinic` : label}
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
      <span style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
        {icon}
        {showBadge ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -6,
              right: -10,
              minWidth: 18,
              height: 18,
              padding: `0 5px`,
              borderRadius: theme.radius.pill,
              background: theme.color.accent,
              color: theme.color.surface,
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              lineHeight: '18px',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              border: `1.5px solid ${theme.color.surface}`,
              boxSizing: 'content-box',
            }}
          >
            {badgeText}
          </span>
        ) : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

// Suppress every focus outline on nav buttons. The previous green
// ring read as a "stuck active" state to staff after taps. Touch
// and mouse users don't need a focus indicator here — the icon's
// active tint already shows which page they're on. Scoped to
// .lng-bottom-nav-btn so the rule can't leak into other surfaces.
function BottomNavStyles() {
  return (
    <style>{`
      .lng-bottom-nav-btn:focus,
      .lng-bottom-nav-btn:focus-visible { outline: none; }
    `}</style>
  );
}
