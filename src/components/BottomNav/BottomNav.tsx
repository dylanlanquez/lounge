import { type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CalendarDays, LogOut, Plus, Settings } from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { useAuth } from '../../lib/auth.tsx';

// Returns true when the bottom nav should render. Pulled out as a named
// helper so App can apply the matching bottom padding to its routes
// without re-implementing the rule.
export function shouldShowBottomNav(pathname: string, signedIn: boolean): boolean {
  if (!signedIn) return false;
  if (pathname === '/sign-in') return false;
  return true;
}

// Height the nav reserves for content. Pages add this as bottom padding so
// nothing hides under the fixed bar.
export const BOTTOM_NAV_HEIGHT = 72;

interface NavItem {
  label: string;
  icon: ReactNode;
  match: (pathname: string) => boolean;
  onActivate: (
    navigate: ReturnType<typeof useNavigate>,
    signOut: () => Promise<void>
  ) => void | Promise<void>;
}

const ITEMS: NavItem[] = [
  {
    label: 'Schedule',
    icon: <CalendarDays size={22} />,
    match: (p) => p === '/' || p.startsWith('/schedule'),
    onActivate: (nav) => nav('/schedule'),
  },
  {
    label: 'Walk-in',
    icon: <Plus size={22} />,
    match: (p) => p.startsWith('/walk-in'),
    onActivate: (nav) => nav('/walk-in/new'),
  },
  {
    label: 'Admin',
    icon: <Settings size={22} />,
    match: (p) => p.startsWith('/admin'),
    onActivate: (nav) => nav('/admin'),
  },
  {
    label: 'Sign out',
    icon: <LogOut size={22} />,
    match: () => false,
    onActivate: async (_nav, signOut) => {
      await signOut();
    },
  },
];

export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  if (!shouldShowBottomNav(location.pathname, !!user)) return null;

  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        background: theme.color.surface,
        // Match the popup footer's separator: a single 1px hairline, no
        // upward shadow. The bar reads as a quiet floor of the page rather
        // than a hovering shelf.
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
          gridTemplateColumns: `repeat(${ITEMS.length}, minmax(0, 1fr))`,
          maxWidth: 880,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {ITEMS.map((item) => {
          const active = item.match(location.pathname);
          return (
            <li key={item.label}>
              <NavButton
                label={item.label}
                icon={item.icon}
                active={active}
                onClick={() => item.onActivate(navigate, signOut)}
              />
            </li>
          );
        })}
      </ul>
      <BottomNavStyles />
    </nav>
  );
}

interface NavButtonProps {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}

function NavButton({ label, icon, active, onClick }: NavButtonProps) {
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
