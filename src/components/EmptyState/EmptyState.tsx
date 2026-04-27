import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}

export function EmptyState({ icon, title, description, action, style }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: `${theme.space[12]}px ${theme.space[6]}px`,
        gap: theme.space[4],
        ...style,
      }}
    >
      {icon ? (
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2], maxWidth: 360 }}>
        <h2
          style={{
            margin: 0,
            fontSize: theme.type.size.lg,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          {title}
        </h2>
        {description ? (
          <p style={{ margin: 0, color: theme.color.inkMuted, fontSize: theme.type.size.base, lineHeight: theme.type.leading.normal }}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div style={{ marginTop: theme.space[2] }}>{action}</div> : null}
    </div>
  );
}
