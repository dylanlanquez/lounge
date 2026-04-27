import { type CSSProperties, type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { theme } from '../../theme/index.ts';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';
export type CardElevation = 'flat' | 'raised' | 'overlay';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: CardPadding;
  elevation?: CardElevation;
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
}

const PADDING: Record<CardPadding, number> = {
  none: 0,
  sm: theme.space[4],
  md: theme.space[5],
  lg: theme.space[6],
};

const SHADOW: Record<CardElevation, string> = {
  flat: 'none',
  raised: theme.shadow.card,
  overlay: theme.shadow.overlay,
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, padding = 'md', elevation = 'raised', interactive = false, as = 'div', style, ...rest },
  ref
) {
  const Tag = as;
  const styles: CSSProperties = {
    background: theme.color.surface,
    borderRadius: theme.radius.card,
    padding: PADDING[padding],
    boxShadow: SHADOW[elevation],
    ...(interactive && {
      cursor: 'pointer',
      transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.spring}, box-shadow ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
    }),
    ...style,
  };

  return (
    <Tag ref={ref as never} style={styles} {...rest}>
      {children}
    </Tag>
  );
});
