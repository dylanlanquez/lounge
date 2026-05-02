import { type ReactNode } from 'react';
import { AlertTriangle, CalendarClock, Check, Info } from 'lucide-react';
import { theme } from '../../theme/index.ts';

// Inline status banner used inside form sheets to surface live state
// — slot is free, slot is conflicted, slot is outside hours, etc.
// Two visual treatments:
//
//   success / info  — soft tinted card, icon + body in line
//   error / warning — surface card with a 3px coloured left edge,
//                     stacked title + body
//
// Picking which: success / info for transient positive feedback;
// error / warning for blocking states the user should fix before
// continuing (e.g. "Outside working hours"). Warning uses
// theme.color.warn (orange), error uses theme.color.alert (red).

export type StatusBannerTone = 'success' | 'info' | 'warning' | 'error';

export interface StatusBannerProps {
  tone: StatusBannerTone;
  // For error / warning a strong title above the body. For success
  // / info, omitted — body alone reads as the message.
  title?: string;
  // Body content. ReactNode so callers can pass formatted lists
  // (e.g. multi-conflict pool messages).
  children: ReactNode;
}

export function StatusBanner({ tone, title, children }: StatusBannerProps) {
  if (tone === 'error' || tone === 'warning') {
    return <SidebarBanner tone={tone} title={title ?? ''} body={children} />;
  }
  return <FlatBanner tone={tone}>{children}</FlatBanner>;
}

function FlatBanner({
  tone,
  children,
}: {
  tone: 'success' | 'info';
  children: ReactNode;
}) {
  const icon =
    tone === 'success' ? <Check size={16} aria-hidden /> : <CalendarClock size={16} aria-hidden />;
  const colour = tone === 'success' ? theme.color.accent : theme.color.inkMuted;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: tone === 'success' ? theme.color.accentBg : theme.color.bg,
        border: `1px solid ${theme.color.border}`,
      }}
    >
      <span
        aria-hidden
        style={{
          color: colour,
          marginTop: 2,
          flexShrink: 0,
          display: 'inline-flex',
        }}
      >
        {icon}
      </span>
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          color: theme.color.ink,
          lineHeight: theme.type.leading.snug,
        }}
      >
        {children}
      </p>
    </div>
  );
}

function SidebarBanner({
  tone,
  title,
  body,
}: {
  tone: 'error' | 'warning';
  title: string;
  body: ReactNode;
}) {
  const sidebarColour = tone === 'warning' ? theme.color.warn : theme.color.alert;
  const subtle = tone === 'warning';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        borderRadius: theme.radius.input,
        background: subtle ? theme.color.bg : theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${sidebarColour}`,
      }}
    >
      <span
        aria-hidden
        style={{
          color: sidebarColour,
          flexShrink: 0,
          marginTop: 2,
          display: 'inline-flex',
        }}
      >
        {tone === 'warning' ? (
          <Info size={16} aria-hidden />
        ) : (
          <AlertTriangle size={16} aria-hidden />
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {title}
        </p>
        <div
          style={{
            marginTop: 2,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}
