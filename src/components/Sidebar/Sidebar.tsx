import { type ReactNode, type CSSProperties } from 'react';
import { theme } from '../../theme/index.ts';

export interface SidebarItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  onClick?: () => void;
  href?: string;
}

export interface SidebarSection {
  id: string;
  label?: string;
  items: SidebarItem[];
}

export interface SidebarProps {
  sections: SidebarSection[];
  activeId: string | null;
  // Logo / mark at the top.
  brand?: ReactNode;
  // Footer slot — used for the user identity card.
  footer?: ReactNode;
  width?: number;
}

export function Sidebar({ sections, activeId, brand, footer, width = 264 }: SidebarProps) {
  return (
    <aside
      style={{
        width,
        flexShrink: 0,
        height: '100dvh',
        background: theme.color.surface,
        borderRight: `1px solid ${theme.color.border}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {brand ? (
        <div style={{ padding: `${theme.space[6]}px ${theme.space[5]}px ${theme.space[5]}px` }}>{brand}</div>
      ) : null}

      <nav style={{ flex: 1, overflowY: 'auto', padding: `0 ${theme.space[3]}px` }}>
        {sections.map((section) => (
          <div key={section.id} style={{ marginBottom: theme.space[5] }}>
            {section.label ? (
              <p
                style={{
                  margin: `0 ${theme.space[3]}px ${theme.space[2]}px`,
                  fontSize: theme.type.size.xs,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.inkSubtle,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                }}
              >
                {section.label}
              </p>
            ) : null}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {section.items.map((item) => (
                <li key={item.id}>
                  <SidebarRow item={item} active={item.id === activeId} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {footer ? (
        <div
          style={{
            padding: theme.space[4],
            borderTop: `1px solid ${theme.color.border}`,
          }}
        >
          {footer}
        </div>
      ) : null}
    </aside>
  );
}

function SidebarRow({ item, active }: { item: SidebarItem; active: boolean }) {
  const inner: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: theme.space[3],
    padding: `${theme.space[3]}px ${theme.space[3]}px`,
    borderRadius: 12,
    background: active ? theme.color.accentBg : 'transparent',
    color: active ? theme.color.accent : theme.color.ink,
    fontWeight: active ? theme.type.weight.semibold : theme.type.weight.medium,
    fontSize: theme.type.size.sm,
    cursor: 'pointer',
    position: 'relative',
    textDecoration: 'none',
    border: 'none',
    fontFamily: 'inherit',
    width: '100%',
    textAlign: 'left',
    outline: 'none',
  };
  const accentBar: CSSProperties = active
    ? {
        position: 'absolute',
        left: -theme.space[3],
        top: 8,
        bottom: 8,
        width: 2,
        borderRadius: 2,
        background: theme.color.accent,
      }
    : { display: 'none' };

  const Tag: 'a' | 'button' = item.href ? 'a' : 'button';

  return (
    <Tag
      href={item.href}
      onClick={item.onClick}
      type={Tag === 'button' ? 'button' : undefined}
      style={inner}
      aria-current={active ? 'page' : undefined}
    >
      <span style={accentBar} aria-hidden />
      {item.icon ? <span style={{ display: 'inline-flex', flexShrink: 0 }}>{item.icon}</span> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
      {item.badge ? <span style={{ flexShrink: 0 }}>{item.badge}</span> : null}
    </Tag>
  );
}
