import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastProps {
  tone?: ToastTone;
  title: string;
  description?: ReactNode;
  duration?: number; // ms, 0 = sticky
  onDismiss?: () => void;
}

const ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertCircle,
  info: Info,
};

const ICON_COLOR: Record<ToastTone, string> = {
  success: theme.color.accent,
  error: theme.color.alert,
  warning: theme.color.ink,
  info: theme.color.ink,
};

export function Toast({ tone = 'info', title, description, duration = 4000, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  if (!visible) return null;

  const Icon = ICONS[tone];

  const card: CSSProperties = {
    background: theme.color.surface,
    borderRadius: theme.radius.card,
    boxShadow: theme.shadow.raised,
    padding: theme.space[4],
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.space[3],
    minWidth: 280,
    maxWidth: 420,
  };

  return (
    <div role="status" aria-live="polite" style={card}>
      <Icon size={22} style={{ color: ICON_COLOR[tone], flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.base,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {title}
        </p>
        {description ? (
          <p
            style={{
              margin: `${theme.space[1]}px 0 0`,
              fontSize: theme.type.size.sm,
              color: theme.color.inkMuted,
            }}
          >
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setVisible(false);
          onDismiss?.();
        }}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: theme.color.inkMuted,
          cursor: 'pointer',
          padding: 0,
          lineHeight: 0,
          flexShrink: 0,
        }}
      >
        <X size={18} />
      </button>
    </div>
  );
}
