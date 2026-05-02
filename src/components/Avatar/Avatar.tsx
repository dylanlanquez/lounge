import { type CSSProperties, useState } from 'react';
import { theme } from '../../theme/index.ts';

export type AvatarSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  // Either a URL, a Meridian avatar_data string ('preset:cat:seed', 'logo:url',
  // 'data:...'), or null to fall back to initials.
  src?: string | null;
  // Used for fallback initials and alt text.
  name: string;
  size?: AvatarSize;
  // Optional badge dot in the bottom-right (online/offline/etc.)
  badge?: 'online' | 'offline' | null;
}

const SIZES: Record<AvatarSize, number> = {
  xxs: 20,
  xs: 24,
  sm: 32,
  md: 40,
  lg: 56,
  xl: 80,
};

const FONT: Record<AvatarSize, number> = {
  xxs: 9,
  xs: 10,
  sm: 12,
  md: 14,
  lg: 18,
  xl: 26,
};

export function Avatar({ src, name, size = 'md', badge = null }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const dim = SIZES[size];
  const initials = computeInitials(name);
  const bgColor = colorFromName(name);
  const showImage = src && !imgError && (src.startsWith('http') || src.startsWith('data:'));

  const wrapper: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    width: dim,
    height: dim,
    flexShrink: 0,
  };

  const inner: CSSProperties = {
    width: '100%',
    height: '100%',
    borderRadius: theme.radius.pill,
    overflow: 'hidden',
    background: bgColor,
    color: theme.color.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: FONT[size],
    fontWeight: theme.type.weight.semibold,
    letterSpacing: '0.02em',
  };

  const badgeStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: dim * 0.28,
    height: dim * 0.28,
    minWidth: 8,
    minHeight: 8,
    borderRadius: theme.radius.pill,
    background: badge === 'online' ? theme.color.accent : theme.color.inkSubtle,
    boxShadow: `0 0 0 2px ${theme.color.surface}`,
  };

  return (
    <span style={wrapper} aria-label={name}>
      <span style={inner}>
        {showImage ? (
          <img
            src={src!}
            alt=""
            onError={() => setImgError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span aria-hidden>{initials}</span>
        )}
      </span>
      {badge ? <span style={badgeStyle} aria-hidden /> : null}
    </span>
  );
}

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Deterministic ink-shade per name. Stays in the B&W palette per design preference.
function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  // Map hash to one of five ink-tone backgrounds.
  const tones = [
    '#0E1414',
    'rgba(14,20,20,0.85)',
    'rgba(14,20,20,0.72)',
    '#1F4D3A', // forest green for variety, used sparingly
    'rgba(14,20,20,0.6)',
  ];
  return tones[Math.abs(hash) % tones.length]!;
}
