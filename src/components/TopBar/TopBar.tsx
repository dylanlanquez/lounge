import { type ReactNode } from 'react';
import { ArrowLeft, BarChart3, LogOut, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Button } from '../Button/Button.tsx';
import { theme } from '../../theme/index.ts';
import { useIsMobile } from '../../lib/useIsMobile.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useCurrentAccount } from '../../lib/queries/currentAccount.ts';

export interface TopBarProps {
  // 'home' shows logo + avatar + admin + sign-out menu.
  // 'subpage' shows back button + title + (optional) right slot.
  variant?: 'home' | 'subpage';
  title?: ReactNode;
  backTo?: string | null;
  right?: ReactNode;
}

export function TopBar({ variant = 'home', title, backTo, right }: TopBarProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile(640);
  const { user, signOut } = useAuth();
  const { account } = useCurrentAccount();
  const showAdminButton = !!account && (account.is_admin || account.is_super_admin);
  const showReportsButton = !!account && account.can_view_reports;

  if (variant === 'subpage') {
    return (
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          marginBottom: theme.space[5],
          minHeight: 36,
          flexWrap: 'wrap',
        }}
      >
        <Button variant="tertiary" size="sm" onClick={() => (backTo === null ? navigate(-1) : navigate(backTo ?? -1 as never))}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
            <ArrowLeft size={16} /> Back
          </span>
        </Button>
        {title ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
              fontWeight: theme.type.weight.medium,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        {right}
      </header>
    );
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
        marginBottom: theme.space[6],
        flexWrap: 'wrap',
      }}
    >
      <img src="/lounge-logo.png" alt="Lounge" style={{ height: isMobile ? 26 : 32, width: 'auto' }} />
      <div style={{ flex: 1 }} />
      {user ? <Avatar name={user.email ?? 'You'} size={isMobile ? 'sm' : 'md'} badge="online" /> : null}
      {isMobile ? (
        <>
          {showReportsButton ? (
            <button
              type="button"
              aria-label="Reports"
              title="Reports"
              onClick={() => navigate('/reports')}
              style={iconButtonStyle}
            >
              <BarChart3 size={18} />
            </button>
          ) : null}
          {showAdminButton ? (
            <button
              type="button"
              aria-label="Admin"
              onClick={() => navigate('/admin')}
              style={iconButtonStyle}
            >
              <Settings size={18} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Sign out"
            onClick={signOut}
            style={iconButtonStyle}
          >
            <LogOut size={18} />
          </button>
        </>
      ) : (
        <>
          {showReportsButton ? (
            <Button variant="tertiary" size="sm" onClick={() => navigate('/reports')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
                <BarChart3 size={16} /> Reports
              </span>
            </Button>
          ) : null}
          {showAdminButton ? (
            <Button variant="tertiary" size="sm" onClick={() => navigate('/admin')}>
              Admin
            </Button>
          ) : null}
          <Button variant="tertiary" size="sm" onClick={signOut}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <LogOut size={16} /> Sign out
            </span>
          </Button>
        </>
      )}
    </header>
  );
}

const iconButtonStyle = {
  appearance: 'none' as const,
  border: 'none',
  background: 'transparent',
  color: theme.color.ink,
  cursor: 'pointer',
  width: 36,
  height: 36,
  borderRadius: theme.radius.pill,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
