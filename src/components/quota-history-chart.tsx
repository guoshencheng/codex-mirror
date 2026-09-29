'use client';

import { useMemo, useState } from 'react';
import type { QuotaHistoryDto, QuotaHistoryPoint, QuotaHistorySeries } from '../contracts/quota-history';
import styles from './quota-history.module.css';

const WIDTH = 380;
const HEIGHT = 178;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 370;
const PLOT_TOP = 20;
const PLOT_BOTTOM = 130;
const SERIES_COLORS = ['#9a8cff', '#57c7ff', '#f4b95f', '#68d39b', '#f18497'] as const;

interface Group {
  id: string;
  title: string;
  unit: string;
  series: QuotaHistorySeries[];
}

function groupsFor(history: QuotaHistoryDto): Group[] {
  const groups = new Map<string, Group>();
  for (const item of history.series) {
    const id = item.kind === 'balance' ? `balance:${item.unit}` : 'quota-window';
    const group = groups.get(id) ?? { id, title: item.kind === 'balance' ? `余额 · ${item.unit}` : '额度窗口', unit: item.unit, series: [] };
    group.series.push(item);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function valueNumber(point: QuotaHistoryPoint): number | null {
  const value = typeof point.value === 'number' ? point.value : Number(point.value);
  return Number.isFinite(value) ? value : null;
}

function colorFor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function pointX(point: QuotaHistoryPoint, from: number, to: number): number {
  const timestamp = Date.parse(point.observedAt);
  const ratio = to > from && Number.isFinite(timestamp) ? Math.min(1, Math.max(0, (timestamp - from) / (to - from))) : 0;
  return PLOT_LEFT + ratio * (PLOT_RIGHT - PLOT_LEFT);
}

function yScale(value: number, kind: QuotaHistorySeries['kind'], bounds: { min: number; max: number }): number {
  let ratio: number;
  if (kind === 'quota-window') {
    ratio = value / 100;
  } else {
    const span = bounds.max - bounds.min;
    if (Number.isFinite(span) && span > 0) {
      ratio = (value - bounds.min) / span;
    } else {
      const scale = Math.max(Math.abs(bounds.min), Math.abs(bounds.max), 1);
      const normalizedMin = bounds.min / scale;
      const normalizedMax = bounds.max / scale;
      const normalizedValue = value / scale;
      const normalizedSpan = normalizedMax - normalizedMin;
      ratio = normalizedSpan > 0 ? (normalizedValue - normalizedMin) / normalizedSpan : 0.5;
    }
  }
  if (!Number.isFinite(ratio)) ratio = 0.5;
  return PLOT_BOTTOM - Math.min(1, Math.max(0, ratio)) * (PLOT_BOTTOM - PLOT_TOP);
}

function pathFor(series: QuotaHistorySeries, from: number, to: number, bounds: { min: number; max: number }): string {
  let path = '';
  let previousWasValid = false;
  for (const point of series.points) {
    const value = valueNumber(point);
    if (value === null) {
      previousWasValid = false;
      continue;
    }
    const x = pointX(point, from, to);
    const y = yScale(value, series.kind, bounds);
    path += (!previousWasValid || point.breakBefore ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`);
    previousWasValid = true;
  }
  return path;
}

function boundsFor(group: Group): { min: number; max: number } {
  if (group.series[0]?.kind === 'quota-window') return { min: 0, max: 100 };
  const values = group.series.flatMap(item => item.points.map(valueNumber).filter((value): value is number => value !== null));
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min !== max) return { min, max };
  const padding = Math.min(Math.max(Math.abs(min) * 0.05, 1), Number.MAX_VALUE / 16);
  const lower = min - padding;
  const upper = max + padding;
  if (Number.isFinite(lower) && Number.isFinite(upper) && lower !== upper) return { min: lower, max: upper };
  return min === 0 ? { min: -1, max: 1 } : { min: min * 0.99, max: min * 1.01 };
}

function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return value.toExponential(2);
  try { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value); }
  catch { return String(value); }
}

function axisTicks(group: Group, bounds: { min: number; max: number }): Array<{ value: number; label: string }> {
  if (group.series[0]?.kind === 'quota-window') return [
    { value: 100, label: '100%' }, { value: 50, label: '50%' }, { value: 0, label: '0%' },
  ];
  const span = bounds.max - bounds.min;
  const middle = Number.isFinite(span) ? bounds.min + span / 2 : bounds.min / 2 + bounds.max / 2;
  return [
    { value: bounds.max, label: formatAxisValue(bounds.max) },
    { value: middle, label: formatAxisValue(middle) },
    { value: bounds.min, label: formatAxisValue(bounds.min) },
  ];
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp); }
  catch { return value; }
}

function formatPointValue(series: QuotaHistorySeries, point: QuotaHistoryPoint): string {
  return `${String(point.value)}${series.kind === 'quota-window' ? '%' : ` ${series.unit}`}`;
}

function formatReset(point: QuotaHistoryPoint): string {
  return point.resetsAt ? ` · 重置 ${formatTime(point.resetsAt)}` : '';
}

function HistoryGroup({ group, history, primary }: { group: Group; history: QuotaHistoryDto; primary: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const bounds = useMemo(() => boundsFor(group), [group]);
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  const selectable = group.series.flatMap(item => item.points.map(point => ({ point, series: item })));
  const selected = selectable[Math.min(selectedIndex, Math.max(0, selectable.length - 1))];
  const move = (delta: number) => setSelectedIndex(index => Math.min(Math.max(index + delta, 0), Math.max(0, selectable.length - 1)));
  const ticks = axisTicks(group, bounds);
  const hasUnplottable = group.series.some(item => item.kind === 'balance' && item.points.some(point => valueNumber(point) === null));

  return <section className={styles.chartGroup} aria-label={`${group.title}历史`}>
    <h4>{group.title}</h4>
    <svg
      className={styles.chart}
      role="img"
      aria-label={`${group.title}历史折线图`}
      tabIndex={0}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      onKeyDown={event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
        if (event.key === 'Home') { event.preventDefault(); setSelectedIndex(0); }
        if (event.key === 'End') { event.preventDefault(); setSelectedIndex(Math.max(0, selectable.length - 1)); }
      }}
    >
      <line className={styles.axis} x1={PLOT_LEFT} y1={PLOT_TOP} x2={PLOT_LEFT} y2={PLOT_BOTTOM} />
      <line className={styles.axis} x1={PLOT_LEFT} y1={PLOT_BOTTOM} x2={PLOT_RIGHT} y2={PLOT_BOTTOM} />
      {ticks.map(tick => <g key={tick.label} className={styles.tick}>
        <line x1={PLOT_LEFT - 3} y1={yScale(tick.value, group.series[0]?.kind ?? 'balance', bounds)} x2={PLOT_LEFT} y2={yScale(tick.value, group.series[0]?.kind ?? 'balance', bounds)} />
        <text x={PLOT_LEFT - 6} y={yScale(tick.value, group.series[0]?.kind ?? 'balance', bounds) + 3} textAnchor="end">{tick.label}</text>
      </g>)}
      <text className={styles.axisLabel} x={5} y={PLOT_TOP - 5}>{group.unit}</text>
      <text className={styles.axisLabel} x={PLOT_RIGHT} y={HEIGHT - 4} textAnchor="end">{formatTime(history.to)}</text>
      <text className={styles.axisLabel} x={PLOT_LEFT} y={HEIGHT - 4}>{formatTime(history.from)}</text>
      <text className={styles.axisLabel} x={(PLOT_LEFT + PLOT_RIGHT) / 2} y={HEIGHT - 4} textAnchor="middle">时间</text>
      {group.series.map((item, seriesIndex) => <path key={item.id} data-testid="quota-history-series-path" className={styles.line} data-series={item.id}
        data-series-color={colorFor(seriesIndex)} style={{ stroke: colorFor(seriesIndex) }} d={pathFor(item, from, to, bounds)} />)}
      {group.series.map((item, seriesIndex) => item.points.map((point, index) => {
        const value = valueNumber(point);
        if (value === null) return null;
        const x = pointX(point, from, to);
        const y = yScale(value, item.kind, bounds);
        return <circle key={`${item.id}:${index}`} className={styles.point} cx={x} cy={y} r="3" data-history-point="true"
          data-series-color={colorFor(seriesIndex)} style={{ fill: colorFor(seriesIndex) }}
          onClick={() => setSelectedIndex(selectable.findIndex(entry => entry.series.id === item.id && entry.point === point))}>
          <title>{`${item.label} · ${formatPointValue(item, point)} · ${formatTime(point.observedAt)}${formatReset(point)}`}</title>
        </circle>;
      }))}
    </svg>
    <div className={styles.legend} aria-label="图例">
      {group.series.map((item, index) => <span key={item.id}><i className={styles.legendDot} style={{ backgroundColor: colorFor(index) }} />{item.label}</span>)}
    </div>
    {hasUnplottable ? <p className={styles.plotNotice} role="note">数值过大，无法绘图；原始值仍显示在提示和摘要中</p> : null}
    <p className={styles.summary} {...(primary ? { role: 'status' } : {})}>
      {selectable.length ? <><span>{selected?.series.label ?? group.title}</span> · <span>{String(selected?.point.value ?? '')}</span> <span>{selected?.series.unit ?? group.unit}</span> · <time dateTime={selected?.point.observedAt}>{selected ? formatTime(selected.point.observedAt) : ''}</time>{selected ? formatReset(selected.point) : ''}</> : '暂无可绘制采样点'}
    </p>
    {selectable.length ? <p className={styles.pointCount}>共 {selectable.length} 个采样点</p> : null}
  </section>;
}

export default function QuotaHistoryChart({ history }: { history: QuotaHistoryDto }) {
  const groups = groupsFor(history);
  if (!groups.length) return <p className={styles.empty}>所选时间范围内暂无额度历史</p>;
  return <div className={styles.chartList} aria-label="额度历史图表">
    {groups.map((group, index) => <HistoryGroup key={group.id} group={group} history={history} primary={index === 0} />)}
  </div>;
}
