import { type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export interface FunnelStage {
  id: string;
  label: string;
  count: number;
}

export interface FunnelProps {
  stages: FunnelStage[];
  ariaSummary: string;
  title?: ReactNode;
  subtitle?: ReactNode;
}

// Funnel — vertical drop-off chart. The first stage is the
// denominator; each subsequent stage shows its absolute count, the
// percent retained from stage 1, and the percent retained from the
// stage immediately above. Anti-pattern dodge: we DON'T mask drop-off
// behind a smooth gradient — every step is a separate row with
// explicit numbers because a manager wants the exact figure, not a
// vibe.

export function Funnel({ stages, ariaSummary, title, subtitle }: FunnelProps) {
  if (stages.length === 0) {
    return (
      <Frame title={title} subtitle={subtitle}>
        <p
          style={{
            margin: 0,
            color: theme.color.inkMuted,
            fontSize: theme.type.size.sm,
            textAlign: 'center',
            padding: `${theme.space[6]}px 0`,
          }}
        >
          No data in this period.
        </p>
      </Frame>
    );
  }
  // Stage 1 is the denominator. If it's zero every percent is undefined;
  // render the rows but with em-dashes for the percent labels rather
  // than NaN%.
  const firstCount = stages[0]?.count ?? 0;

  return (
    <Frame title={title} subtitle={subtitle}>
      <ul
        role="img"
        aria-label={ariaSummary}
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.space[3],
        }}
      >
        {stages.map((stage, i) => {
          const prev = i === 0 ? null : stages[i - 1]!;
          const fromStart = firstCount > 0 ? (stage.count / firstCount) * 100 : null;
          const fromPrev =
            prev && prev.count > 0 ? (stage.count / prev.count) * 100 : null;
          // The bar width visualises the proportion of the start
          // stage. First stage is always 100 %, subsequent narrow.
          const widthPct = fromStart === null ? 0 : Math.max(2, fromStart);
          return (
            <li key={stage.id} style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: theme.space[3],
                  marginBottom: theme.space[2],
                }}
              >
                <span
                  style={{
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                  }}
                >
                  {stage.label}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.semibold,
                    color: theme.color.ink,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {stage.count.toLocaleString('en-GB')}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: theme.space[3],
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: 12,
                    background: theme.color.bg,
                    borderRadius: theme.radius.pill,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${widthPct}%`,
                      height: '100%',
                      background: i === 0 ? theme.color.accent : theme.color.ink,
                      transition: 'width 160ms ease-out',
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: theme.type.size.xs,
                    color: theme.color.inkMuted,
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 90,
                    textAlign: 'right',
                  }}
                >
                  {fromStart === null ? '—' : `${fromStart.toFixed(0)}% of start`}
                </span>
              </div>
              {prev ? (
                <p
                  style={{
                    margin: `${theme.space[2]}px 0 0`,
                    color: theme.color.inkSubtle,
                    fontSize: theme.type.size.xs,
                  }}
                >
                  {fromPrev === null
                    ? `From "${prev.label}": no prior data`
                    : `${fromPrev.toFixed(0)}% retained from "${prev.label}" (${(prev.count - stage.count).toLocaleString('en-GB')} dropped)`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

function Frame({ title, subtitle, children }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div>
      {title || subtitle ? (
        <header style={{ marginBottom: theme.space[3] }}>
          {title ? (
            <h3
              style={{
                margin: 0,
                fontSize: theme.type.size.md,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
              }}
            >
              {title}
            </h3>
          ) : null}
          {subtitle ? (
            <p
              style={{
                margin: `${theme.space[1]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}
