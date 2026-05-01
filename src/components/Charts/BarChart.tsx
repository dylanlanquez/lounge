import { type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';
import { computeNiceTicks } from './LineChart.tsx';

export interface BarChartBar {
  // Stable id for the React key.
  id: string;
  // Category label rendered under each bar.
  label: string;
  // Numeric value.
  value: number;
  // Optional theme colour. Defaults to theme.color.accent.
  colour?: string;
}

export interface BarChartProps {
  bars: BarChartBar[];
  ariaSummary: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  // Visual height of the SVG.
  height?: number;
  // Render number labels on top of each bar. Default true — most
  // Reports surfaces want the exact count visible alongside the
  // visual ranking.
  showValueLabels?: boolean;
  // Custom value formatter for the in-bar label. Defaults to
  // localised integer; financial bars override with formatPence.
  formatValue?: (n: number) => string;
}

// BarChart — vertical bar chart, theme-coloured, axis-rounded. Used
// across Reports for hour-of-day distributions, status counts, etc.
// Hand-rolled SVG so the visual dialect (corner radius, x-tick gap,
// label position) matches LineChart and Funnel without a charting
// library imposing its own opinions.

export function BarChart({
  bars,
  ariaSummary,
  title,
  subtitle,
  height = 220,
  showValueLabels = true,
  formatValue,
}: BarChartProps) {
  if (bars.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
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
      </ChartFrame>
    );
  }

  const max = Math.max(0, ...bars.map((b) => b.value));
  const yTicks = computeNiceTicks(max, 4);
  const niceMax = yTicks[yTicks.length - 1] ?? max;
  const yScale = niceMax === 0 ? 1 : niceMax;

  const W = 1000;
  const H = 360;
  const padL = 40;
  const padR = 16;
  const padT = 30; // value labels live above bars; extra room for the bigger label
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Each bar gets equal slot width; the visible bar fills 70 % of the
  // slot so adjacent bars have breathing room.
  const slot = plotW / bars.length;
  const barWidth = slot * 0.7;

  const yFor = (v: number): number => padT + plotH - (v / yScale) * plotH;

  const fmt = formatValue ?? ((n: number) => n.toLocaleString('en-GB'));

  return (
    <ChartFrame title={title} subtitle={subtitle}>
      <div style={{ position: 'relative', width: '100%', height }}>
        <svg
          role="img"
          aria-label={ariaSummary}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          {/* Gridlines + y-tick labels — share the chart's formatter
              so currency bars get "£100" axis ticks for free. */}
          {yTicks.map((t) => (
            <g key={`grid-${t}`}>
              <line
                x1={padL}
                x2={W - padR}
                y1={yFor(t)}
                y2={yFor(t)}
                stroke={theme.color.border}
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : '4 4'}
              />
              <text
                x={padL - 8}
                y={yFor(t) + 4}
                textAnchor="end"
                fontSize={13}
                fill={theme.color.inkSubtle}
                fontFamily="inherit"
              >
                {fmt(t)}
              </text>
            </g>
          ))}

          {/* Bars */}
          {bars.map((b, i) => {
            const x = padL + i * slot + (slot - barWidth) / 2;
            const y = yFor(b.value);
            const barH = padT + plotH - y;
            const colour = b.colour ?? theme.color.accent;
            return (
              <g key={b.id}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(0, barH)}
                  rx={3}
                  ry={3}
                  fill={colour}
                >
                  <title>{`${b.label}: ${fmt(b.value)}`}</title>
                </rect>
                {showValueLabels && b.value > 0 ? (
                  <text
                    x={x + barWidth / 2}
                    y={y - 8}
                    textAnchor="middle"
                    fontSize={14}
                    fill={theme.color.ink}
                    fontFamily="inherit"
                    fontWeight={theme.type.weight.semibold}
                  >
                    {fmt(b.value)}
                  </text>
                ) : null}
                <text
                  x={x + barWidth / 2}
                  y={H - padB / 2 + 6}
                  textAnchor="middle"
                  fontSize={13}
                  fill={theme.color.inkSubtle}
                  fontFamily="inherit"
                >
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFrame>
  );
}

function ChartFrame({ title, subtitle, children }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
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
