import { type CSSProperties, type ReactNode } from 'react';
import { theme } from '../../theme/index.ts';

export interface LineChartSeries {
  // Stable identifier — used for the React key in the legend.
  id: string;
  label: string;
  // Theme colour (e.g. theme.color.accent) the line and legend dot
  // are painted with. Caller sources this from the theme system; the
  // chart never picks colours itself so a Reports redesign can swap
  // the palette in one place.
  colour: string;
  // Y values aligned to the parent chart's xLabels. NaN entries
  // render as gaps in the line.
  values: number[];
  // Optional formatter applied wherever this series's number lands
  // in front of a human — y-axis tick labels (when this is the only
  // series), the per-point hover title, and the legend's
  // total/last/avg figure. Defaults to en-GB integer formatting
  // (thousand separators included). Currency series should pass
  // `formatPounds` from queries/carts.ts.
  formatValue?: (n: number) => string;
}

export type LineChartLegendMode = 'total' | 'last' | 'avg' | 'max';

export interface LineChartProps {
  // Categorical x-axis labels. Their order defines the rendered
  // x order of every series's values. Equal-spaced.
  xLabels: string[];
  series: LineChartSeries[];
  // Plain-text summary read by screen readers. The chart is a
  // role="img"; assistive tech needs a sentence even though
  // sighted users read the legend + values.
  ariaSummary: string;
  // Optional title rendered above the chart. Style follows the
  // section-header pattern used everywhere else in Reports.
  title?: ReactNode;
  // Optional sub-line under the title (date range, sample size, etc.).
  subtitle?: ReactNode;
  // Visual height of the SVG plot area. Defaults to a comfortable
  // 220px which shows trends without dominating the page.
  height?: number;
  // Which figure to surface in the legend per series:
  //   • 'total' — sum across the period (default; what a manager
  //     usually wants for time-series — e.g. "9 bookings this period")
  //   • 'last' — the last finite value (current standing)
  //   • 'avg'  — mean across finite values
  //   • 'max'  — peak value
  legendMode?: LineChartLegendMode;
}

// LineChart — multi-series time-series chart for the Reports section.
// Hand-rolled SVG so the bundle stays slim and every visual choice
// (stroke width, colour, gridline contrast) flows from the theme. No
// hover tooltips in v1; the legend below the chart shows the latest
// value of each series so a glance answers "what's the line at right
// now" without an interaction.
//
// Data contract: every series's values array must equal xLabels.length.
// We throw if it doesn't — silent truncation would lie about the data.

export function LineChart({
  xLabels,
  series,
  ariaSummary,
  title,
  subtitle,
  height = 220,
  legendMode = 'total',
}: LineChartProps) {
  if (xLabels.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <p style={emptyText}>No data in this period.</p>
      </ChartFrame>
    );
  }
  for (const s of series) {
    if (s.values.length !== xLabels.length) {
      throw new Error(
        `LineChart series "${s.id}" has ${s.values.length} values but xLabels has ${xLabels.length}`,
      );
    }
  }

  // Compute y-axis range. allValues is the union of every finite
  // value across every series; yMax floors at 0 so a chart of all
  // zeros still produces sensible niceMax of 1 below.
  const allValues = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const yMax = allValues.length > 0 ? Math.max(0, ...allValues) : 1;

  // Use a fixed virtual coordinate system; the SVG scales via viewBox.
  const W = 1000;
  const H = 360;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xFor = (i: number): number => {
    if (xLabels.length === 1) return padL + plotW / 2;
    return padL + (i / (xLabels.length - 1)) * plotW;
  };

  // Y-axis ticks: 4 evenly spaced. Round the top tick to a friendly
  // number so the legend reads as a recognisable count and the
  // gridlines line up with the labels.
  const yTicks = computeNiceTicks(yMax, 4);
  const niceMax = yTicks[yTicks.length - 1] ?? yMax;
  const yForNice = (v: number): number =>
    padT + plotH - (v / (niceMax || 1)) * plotH;

  // Pick the y-axis formatter: when every series passes the same
  // formatValue we use it for the axis ticks too, so a currency
  // chart shows "£100" / "£200" rather than "100" / "200". Mixed
  // formatters fall back to the default int formatter — sensible
  // default and the per-series legend value still reflects each
  // formatter individually.
  const yAxisFormat = pickSharedFormatter(series);

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
          {/* Gridlines */}
          {yTicks.map((t) => (
            <g key={`grid-${t}`}>
              <line
                x1={padL}
                x2={W - padR}
                y1={yForNice(t)}
                y2={yForNice(t)}
                stroke={theme.color.border}
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : '4 4'}
              />
              <text
                x={padL - 8}
                y={yForNice(t) + 4}
                textAnchor="end"
                fontSize={12}
                fill={theme.color.inkSubtle}
                fontFamily="inherit"
              >
                {yAxisFormat(t)}
              </text>
            </g>
          ))}

          {/* Series lines */}
          {series.map((s) => {
            const path = pathFor(s.values, xFor, yForNice);
            return (
              <g key={s.id}>
                <path
                  d={path}
                  fill="none"
                  stroke={s.colour}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {s.values.map((v, i) => {
                  if (!Number.isFinite(v)) return null;
                  const fmt = s.formatValue ?? defaultFormat;
                  return (
                    <circle
                      key={`${s.id}-${i}`}
                      cx={xFor(i)}
                      cy={yForNice(v)}
                      r={3.5}
                      fill={theme.color.surface}
                      stroke={s.colour}
                      strokeWidth={2}
                    >
                      <title>{`${s.label} · ${xLabels[i]}: ${fmt(v)}`}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}

          {/* X-axis labels (sparsified so they don't overlap) */}
          {xLabels.map((label, i) => {
            const stride = sparseStride(xLabels.length);
            if (i % stride !== 0 && i !== xLabels.length - 1) return null;
            return (
              <text
                key={`x-${i}`}
                x={xFor(i)}
                y={H - padB / 2 + 6}
                textAnchor="middle"
                fontSize={12}
                fill={theme.color.inkSubtle}
                fontFamily="inherit"
              >
                {label}
              </text>
            );
          })}
        </svg>
      </div>

      {/* Legend with the latest value per series — answers "where is
          the line at right now" without needing a tooltip. */}
      <ul
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: theme.space[3],
          listStyle: 'none',
          margin: `${theme.space[4]}px 0 0`,
          padding: 0,
        }}
      >
        {series.map((s) => {
          const fmt = s.formatValue ?? defaultFormat;
          const headline = legendValue(s.values, legendMode);
          return (
            <li
              key={`legend-${s.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[2],
                fontSize: theme.type.size.sm,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: s.colour,
                  display: 'inline-block',
                }}
              />
              <span style={{ color: theme.color.ink, fontWeight: theme.type.weight.medium }}>
                {s.label}
              </span>
              <span
                style={{
                  color: theme.color.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {headline === null ? '—' : fmt(headline)}
              </span>
            </li>
          );
        })}
      </ul>
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

const emptyText: CSSProperties = {
  margin: 0,
  color: theme.color.inkMuted,
  fontSize: theme.type.size.sm,
  textAlign: 'center',
  padding: `${theme.space[6]}px 0`,
};

// Path builder: M to first finite point, L for each subsequent finite,
// M after gaps so non-finite values render as breaks rather than zero.
function pathFor(
  values: number[],
  xFor: (i: number) => number,
  yFor: (v: number) => number,
): string {
  let started = false;
  const parts: string[] = [];
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      started = false;
      return;
    }
    const cmd = started ? 'L' : 'M';
    parts.push(`${cmd}${xFor(i).toFixed(2)} ${yFor(v).toFixed(2)}`);
    started = true;
  });
  return parts.join(' ');
}

function lastFinite(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// Default integer formatter for any series that doesn't ship its
// own. Locale-pinned so the kiosk renders the UK convention
// regardless of the browser's profile.
const INT_FMT = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
function defaultFormat(n: number): string {
  return INT_FMT.format(n);
}

// Pick the y-axis tick formatter. When every series declares the same
// formatValue function reference, use it; otherwise fall back to the
// default integer formatter. Comparing by reference is intentional —
// two series that pass the same imported formatter share visual
// language; ad-hoc lambdas don't, so a multi-currency mixed chart
// (rare) falls back safely.
function pickSharedFormatter(series: LineChartSeries[]): (n: number) => string {
  if (series.length === 0) return defaultFormat;
  const first = series[0]?.formatValue;
  if (!first) return defaultFormat;
  for (const s of series) {
    if (s.formatValue !== first) return defaultFormat;
  }
  return first;
}

function legendValue(values: number[], mode: LineChartLegendMode): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  switch (mode) {
    case 'last':
      return lastFinite(values);
    case 'avg':
      return finite.reduce((s, n) => s + n, 0) / finite.length;
    case 'max':
      return Math.max(...finite);
    case 'total':
    default:
      return finite.reduce((s, n) => s + n, 0);
  }
}

// Choose ~n+1 nicely-rounded ticks from 0 → max. Returns ascending,
// always includes 0 and a number ≥ max.
export function computeNiceTicks(max: number, n: number): number[] {
  if (max <= 0) return [0, 1];
  const step = niceStep(max / n);
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const norm = rough / base;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  return step * base;
}

// Stride between visible x-axis labels so they don't overlap. For
// long ranges (30+ days) we show every Nth label, always keeping the
// last one so the right edge reads correctly.
function sparseStride(n: number): number {
  if (n <= 7) return 1;
  if (n <= 14) return 2;
  if (n <= 31) return 5;
  if (n <= 90) return 10;
  return Math.ceil(n / 10);
}
