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
        borderTop: `1px solid ${theme.color.border}`,
        // Drop shadow upward to lift the bar off scrolling content.
        boxShadow: '0 -4px 16px rgba(14, 20, 20, 0.04)',
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
      onFocus={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = `inset 0 0 0 2px ${theme.color.focus}`;
        (e.currentTarget as HTMLElement).style.borderRadius = `${theme.radius.input}px`;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
      }}
      style={styles}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
