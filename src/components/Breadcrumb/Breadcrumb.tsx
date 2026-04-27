import { type ReactNode, Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import { theme } from '../../theme/index.ts';

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  ariaLabel?: string;
}

export function Breadcrumb({ items, ariaLabel = 'Breadcrumb' }: BreadcrumbProps) {
  return (
    <nav aria-label={ariaLabel}>
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: theme.space[2],
          margin: 0,
          padding: 0,
          listStyle: 'none',
          fontSize: theme.type.size.sm,
        }}
      >
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const linkLike = !isLast && (item.href || item.onClick);
          return (
            <Fragment key={i}>
              <li style={{ display: 'flex', alignItems: 'center' }}>
                {linkLike ? (
                  item.href ? (
                    <a
                      href={item.href}
                      style={{ color: theme.color.inkMuted, textDecoration: 'none' }}
                    >
                      {item.label}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={item.onClick}
                      style={{
                        appearance: 'none',
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        color: theme.color.inkMuted,
                        fontFamily: 'inherit',
                        fontSize: 'inherit',
                      }}
                    >
                      {item.label}
                    </button>
                  )
                ) : (
                  <span
                    aria-current={isLast ? 'page' : undefined}
                    style={{ color: isLast ? theme.color.ink : theme.color.inkMuted, fontWeight: isLast ? theme.type.weight.medium : theme.type.weight.regular }}
                  >
                    {item.label}
                  </span>
                )}
              </li>
              {!isLast ? (
                <li aria-hidden style={{ display: 'flex', alignItems: 'center', color: theme.color.inkSubtle }}>
                  <ChevronRight size={14} />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
