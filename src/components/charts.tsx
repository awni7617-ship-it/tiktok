'use client';

import { useId, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { compactNumber, formatDay } from '@/lib/format';

/**
 * Analytics charts.
 *
 * Hand-rolled SVG rather than a charting library: the whole set is five forms,
 * and owning the markup is what lets every chart be theme-aware, keyboard
 * reachable and screen-reader legible without fighting a library's defaults.
 *
 * Palette: the categorical slots below are a validated four-hue set (checked
 * for lightness band, chroma, CVD separation and surface contrast in both
 * modes against this product's actual surfaces). Two light-mode slots sit
 * under 3:1 against the light surface, so every categorical chart here ships
 * direct labels *and* a table view rather than relying on colour alone.
 *
 * Single-series charts use the accent token and need no legend — the title
 * names the series.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Fixed categorical order. Assigned by entity, never by rank, never cycled. */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500'] as const;

/**
 * Resolve a categorical slot. Both modes are declared as CSS custom properties
 * on the chart root, so the swap happens in one place.
 */
function seriesVar(index: number): string {
  return `var(--viz-series-${(index % 4) + 1})`;
}

/** Wrapper that declares the palette for both themes. */
function VizRoot({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('viz-root', className)}>
      <style>{`
        .viz-root {
          --viz-series-1: ${SERIES_LIGHT[0]};
          --viz-series-2: ${SERIES_LIGHT[1]};
          --viz-series-3: ${SERIES_LIGHT[2]};
          --viz-series-4: ${SERIES_LIGHT[3]};
        }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme='light'])) .viz-root {
            --viz-series-1: ${SERIES_DARK[0]};
            --viz-series-2: ${SERIES_DARK[1]};
            --viz-series-3: ${SERIES_DARK[2]};
            --viz-series-4: ${SERIES_DARK[3]};
          }
        }
        :root[data-theme='dark'] .viz-root {
          --viz-series-1: ${SERIES_DARK[0]};
          --viz-series-2: ${SERIES_DARK[1]};
          --viz-series-3: ${SERIES_DARK[2]};
          --viz-series-4: ${SERIES_DARK[3]};
        }
      `}</style>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface Point {
  date: string;
  value: number;
}

/**
 * How a chart's values should be rendered.
 *
 * A string rather than a formatter function: these components are client
 * components, and a server component cannot pass a function across the
 * boundary. Naming the unit is also more readable at the call site.
 */
export type Unit = 'count' | 'hours' | 'percent' | 'seconds';

function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case 'hours':
      return `${compactNumber(value / 3600)}h`;
    case 'percent':
      return `${Math.round(value * 100)}%`;
    case 'seconds':
      return `${Math.round(value)}s`;
    case 'count':
    default:
      return compactNumber(value);
  }
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

/**
 * Headline number with an optional trend sparkline.
 *
 * The delta is never colour-only: it carries an arrow glyph and a signed
 * number, so the direction survives greyscale and colour-blindness.
 */
export function StatTile({
  label,
  value,
  delta,
  spark,
  suffix,
  hint,
}: {
  label: string;
  value: string | number;
  /** Percentage change; `null` means there is no comparable prior period. */
  delta?: number | null;
  spark?: Point[];
  suffix?: string;
  hint?: string;
}) {
  const isUp = (delta ?? 0) >= 0;

  return (
    <VizRoot className="panel p-4 flex flex-col gap-2.5">
      <p className="text-xs font-medium text-[var(--text-muted)]">{label}</p>

      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          {suffix ? <span className="text-sm text-[var(--text-muted)]">{suffix}</span> : null}
        </div>

        {spark && spark.length > 1 ? <Sparkline points={spark} /> : null}
      </div>

      {delta !== undefined ? (
        <p className="text-xs tabular-nums text-[var(--text-secondary)]">
          {delta === null ? (
            <span className="text-[var(--text-muted)]">No prior period to compare</span>
          ) : (
            <>
              <span aria-hidden>{isUp ? '▲' : '▼'}</span>{' '}
              <span className={isUp ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                {isUp ? '+' : ''}
                {delta}%
              </span>{' '}
              <span className="text-[var(--text-muted)]">vs previous period</span>
            </>
          )}
        </p>
      ) : null}

      {hint ? <p className="text-xs text-[var(--text-muted)]">{hint}</p> : null}
    </VizRoot>
  );
}

/** Bare trend line. Decorative by design — the tile's number is the content. */
export function Sparkline({ points, width = 72, height = 28 }: { points: Point[]; width?: number; height?: number }) {
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point.value - min) / span) * (height - 4) - 2;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden focusable="false">
      <path d={path} fill="none" stroke="var(--viz-series-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Time series (area + line, single series)
// ---------------------------------------------------------------------------

/**
 * Single-series area chart with a crosshair tooltip.
 *
 * One series, so no legend — the title names it. Grid lines are recessive and
 * only horizontal; vertical gridlines add ink without aiding value reading.
 */
export function TimeSeriesChart({
  points,
  label,
  height = 200,
  unit = 'count',
}: {
  points: Point[];
  label: string;
  height?: number;
  unit?: Unit;
}) {
  const format = (value: number) => formatValue(value, unit);
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    const width = 800;
    const padding = { top: 12, right: 8, bottom: 24, left: 8 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;

    const max = Math.max(...points.map((p) => p.value), 1);
    // Head-room so the peak never touches the top edge.
    const scaleMax = max * 1.15;

    const coords = points.map((point, index) => ({
      ...point,
      x: padding.left + (index / Math.max(points.length - 1, 1)) * plotWidth,
      y: padding.top + plotHeight - (point.value / scaleMax) * plotHeight,
    }));

    return { width, padding, plotWidth, plotHeight, scaleMax, coords, baseline: padding.top + plotHeight };
  }, [points, height]);

  if (points.length === 0) {
    return (
      <div className="grid h-40 place-items-center text-sm text-[var(--text-muted)]">
        No data for this period yet.
      </div>
    );
  }

  const linePath = geometry.coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${geometry.coords[geometry.coords.length - 1]!.x.toFixed(1)},${geometry.baseline} L${geometry.coords[0]!.x.toFixed(1)},${geometry.baseline} Z`;

  const active = hover !== null ? geometry.coords[hover] : null;

  return (
    <VizRoot className="relative">
      <svg
        viewBox={`0 0 ${geometry.width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${label} over ${points.length} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--viz-series-1)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--viz-series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive horizontal grid. */}
        {[0, 0.5, 1].map((fraction) => {
          const y = geometry.padding.top + geometry.plotHeight * fraction;
          return (
            <g key={fraction}>
              <line
                x1={geometry.padding.left}
                x2={geometry.width - geometry.padding.right}
                y1={y}
                y2={y}
                stroke="var(--border-subtle)"
                strokeWidth={1}
              />
              <text
                x={geometry.padding.left}
                y={y - 4}
                className="fill-[var(--text-muted)]"
                fontSize={10}
              >
                {format(geometry.scaleMax * (1 - fraction))}
              </text>
            </g>
          );
        })}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--viz-series-1)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {active ? (
          <g>
            <line
              x1={active.x}
              x2={active.x}
              y1={geometry.padding.top}
              y2={geometry.baseline}
              stroke="var(--border-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {/* 2px surface ring so the marker reads on top of the line. */}
            <circle cx={active.x} cy={active.y} r={5} fill="var(--viz-series-1)" stroke="var(--surface-base)" strokeWidth={2} />
          </g>
        ) : null}

        {/* First and last date only — a label per point is noise. */}
        <text x={geometry.padding.left} y={height - 6} className="fill-[var(--text-muted)]" fontSize={10}>
          {formatDay(points[0]!.date)}
        </text>
        <text
          x={geometry.width - geometry.padding.right}
          y={height - 6}
          textAnchor="end"
          className="fill-[var(--text-muted)]"
          fontSize={10}
        >
          {formatDay(points[points.length - 1]!.date)}
        </text>
      </svg>

      {active ? (
        <div
          className="glass-strong pointer-events-none absolute -translate-x-1/2 rounded-lg px-2.5 py-1.5 text-xs shadow-[var(--shadow-lift)]"
          style={{ left: `${(active.x / geometry.width) * 100}%`, top: 0 }}
        >
          <div className="font-medium tabular-nums">{format(active.value)}</div>
          <div className="text-[var(--text-muted)]">{formatDay(active.date)}</div>
        </div>
      ) : null}
    </VizRoot>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bar chart (magnitude, single hue)
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  /** Optional secondary line under the label. */
  meta?: string;
}

/**
 * Ranked magnitude comparison.
 *
 * Horizontal because the labels are long titles; a vertical bar chart would
 * force them to rotate. Bars are directly labelled with their value, so no
 * axis is needed at all.
 */
export function BarChart({ data, unit = 'count' }: { data: BarDatum[]; unit?: Unit }) {
  const format = (value: number) => formatValue(value, unit);
  const max = Math.max(...data.map((datum) => datum.value), 1);

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--text-muted)]">Nothing to rank yet.</p>;
  }

  return (
    <VizRoot className="space-y-3">
      {data.map((datum) => (
        <div key={datum.label} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-sm">{datum.label}</span>
            <span className="shrink-0 text-sm font-medium tabular-nums">{format(datum.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
            {/* 4px rounded data-end, anchored to the baseline. */}
            <div
              className="h-full rounded-r-[4px] transition-[width] duration-700 ease-[var(--ease-out-quint)]"
              style={{
                width: `${Math.max((datum.value / max) * 100, 1.5)}%`,
                background: 'var(--viz-series-1)',
              }}
            />
          </div>
          {datum.meta ? <p className="mt-1 text-xs text-[var(--text-muted)]">{datum.meta}</p> : null}
        </div>
      ))}
    </VizRoot>
  );
}

// ---------------------------------------------------------------------------
// Retention curve
// ---------------------------------------------------------------------------

/**
 * Audience retention across the video.
 *
 * The sharpest drop is annotated inline, because "where did I lose them?" is
 * the only question this chart is asked — making the reader find it themselves
 * would be withholding the answer.
 */
export function RetentionCurve({
  curve,
  height = 180,
  dropOffPercent,
}: {
  curve: number[];
  height?: number;
  dropOffPercent?: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (curve.length < 2) {
    return (
      <div className="grid h-32 place-items-center text-sm text-[var(--text-muted)]">
        Retention data appears once the platform reports it.
      </div>
    );
  }

  const width = 600;
  const padding = { top: 14, right: 12, bottom: 22, left: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const coords = curve.map((value, index) => ({
    value,
    percent: (index / (curve.length - 1)) * 100,
    x: padding.left + (index / (curve.length - 1)) * plotWidth,
    y: padding.top + plotHeight - value * plotHeight,
  }));

  const line = coords.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const active = hover !== null ? coords[hover] : null;
  const dropX = dropOffPercent != null ? padding.left + (dropOffPercent / 100) * plotWidth : null;

  return (
    <VizRoot>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Audience retention across the video"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          setHover(Math.max(0, Math.min(curve.length - 1, Math.round(ratio * (curve.length - 1)))));
        }}
      >
        {[0, 0.5, 1].map((fraction) => {
          const y = padding.top + plotHeight * fraction;
          return (
            <g key={fraction}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--border-subtle)" />
              <text x={0} y={y + 3} className="fill-[var(--text-muted)]" fontSize={10}>
                {Math.round((1 - fraction) * 100)}%
              </text>
            </g>
          );
        })}

        {dropX !== null ? (
          <g>
            <line
              x1={dropX}
              x2={dropX}
              y1={padding.top}
              y2={padding.top + plotHeight}
              stroke="var(--danger)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text x={dropX + 5} y={padding.top + 10} className="fill-[var(--danger)]" fontSize={10}>
              biggest drop
            </text>
          </g>
        ) : null}

        <path d={line} fill="none" stroke="var(--viz-series-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {active ? (
          <circle cx={active.x} cy={active.y} r={5} fill="var(--viz-series-1)" stroke="var(--surface-base)" strokeWidth={2} />
        ) : null}

        <text x={padding.left} y={height - 5} className="fill-[var(--text-muted)]" fontSize={10}>
          start
        </text>
        <text x={width - padding.right} y={height - 5} textAnchor="end" className="fill-[var(--text-muted)]" fontSize={10}>
          end
        </text>
      </svg>

      <p className="mt-1 text-center text-xs text-[var(--text-muted)] tabular-nums" aria-live="polite">
        {active
          ? `${Math.round(active.percent)}% through — ${Math.round(active.value * 100)}% still watching`
          : 'Hover the curve to read a point'}
      </p>
    </VizRoot>
  );
}

// ---------------------------------------------------------------------------
// Categorical split
// ---------------------------------------------------------------------------

/**
 * Share by platform.
 *
 * Categorical, so it ships the two things the palette's light-mode contrast
 * requires: a direct label on every segment and a table view. Colour is never
 * the only carrier of identity here.
 */
export function CategoricalSplit({ data, unit = 'count' }: { data: BarDatum[]; unit?: Unit }) {
  const format = (value: number) => formatValue(value, unit);
  const [showTable, setShowTable] = useState(false);
  const total = data.reduce((sum, datum) => sum + datum.value, 0);

  if (data.length === 0 || total === 0) {
    return <p className="py-6 text-center text-sm text-[var(--text-muted)]">No published posts yet.</p>;
  }

  // Beyond four entities, fold the tail into "Other" rather than inventing hues.
  const ranked = [...data].sort((a, b) => b.value - a.value);
  const shown = ranked.slice(0, 4);
  const rest = ranked.slice(4);
  const segments =
    rest.length > 0
      ? [...shown, { label: 'Other', value: rest.reduce((sum, d) => sum + d.value, 0) }]
      : shown;

  return (
    <VizRoot className="space-y-3">
      {/* 2px surface gap between segments keeps adjacent fills readable. */}
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {segments.map((segment, index) => (
          <div
            key={segment.label}
            className="first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: index < 4 ? seriesVar(index) : 'var(--text-muted)',
            }}
            title={`${segment.label}: ${format(segment.value)}`}
          />
        ))}
      </div>

      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {segments.map((segment, index) => (
          <li key={segment.label} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: index < 4 ? seriesVar(index) : 'var(--text-muted)' }}
                aria-hidden
              />
              <span className="truncate text-[var(--text-secondary)]">{segment.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
              {Math.round((segment.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => setShowTable((value) => !value)}
        className="text-xs text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-secondary)]"
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'View as table'}
      </button>

      {showTable ? (
        <table className="w-full text-xs">
          <caption className="sr-only">Distribution by platform</caption>
          <thead>
            <tr className="text-left text-[var(--text-muted)]">
              <th scope="col" className="py-1 font-medium">Platform</th>
              <th scope="col" className="py-1 text-right font-medium">Value</th>
              <th scope="col" className="py-1 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.label} className="border-t border-[var(--border-subtle)]">
                <td className="py-1.5">{segment.label}</td>
                <td className="py-1.5 text-right tabular-nums">{format(segment.value)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {Math.round((segment.value / total) * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </VizRoot>
  );
}

/** Score gauge for the optimizer report. */
export function ScoreRing({ score, size = 96 }: { score: number; size?: number }) {
  const radius = (size - 10) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));

  // Status colour, not a categorical slot — this encodes state, not identity.
  const tone = clamped >= 80 ? 'var(--success)' : clamped >= 55 ? 'var(--warning)' : 'var(--danger)';

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label={`Readiness score ${Math.round(clamped)} out of 100`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-inset)" strokeWidth={6} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-1000 ease-[var(--ease-out-quint)]"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-xl font-semibold tabular-nums">{Math.round(clamped)}</span>
      </div>
    </div>
  );
}
