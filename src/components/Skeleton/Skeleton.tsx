import { type CSSProperties } from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, radius = 6, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width,
        height,
        borderRadius: radius,
        background:
          'linear-gradient(90deg, rgba(14,20,20,0.05) 0%, rgba(14,20,20,0.09) 50%, rgba(14,20,20,0.05) 100%)',
        backgroundSize: '200% 100%',
        animation: 'lng-skeleton 1.4s ease-in-out infinite',
        ...style,
      }}
    >
      <SkeletonKeyframes />
    </span>
  );
}

function SkeletonKeyframes() {
  return (
    <style>{`
      @keyframes lng-skeleton {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `}</style>
  );
}
