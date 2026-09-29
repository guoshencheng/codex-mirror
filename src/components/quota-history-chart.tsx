'use client';

import { useMemo, useState } from 'react';
import type { QuotaHistoryDto, QuotaHistoryPoint, QuotaHistorySeries } from '../contracts/quota-history';
import styles from './quota-history.module.css';

const WIDTH = 360;
const HEIGHT = 150;
const PLOT_LEFT = 30;
const PLOT_RIGHT = 350;
const PLOT_TOP = 15;
const PLOT_BOTTOM = 120;

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

function pointX(point: QuotaHistoryPoint, from: number, to: number): number {
  const timestamp = Date.parse(point.observedAt);
  const ratio = to > from && Number.isFinite(timestamp) ? Math.min(1, Math.max(0, (timestamp - from) / (to - from))) : 0;
  return PLOT_LEFT + ratio * (PLOT_RIGHT - PLOT_LEFT);
}

function yScale(value: number, kind: QuotaHistorySeries['kind'], bounds: { min: number; max: number }): number {
  const ratio = kind === 'quota-window'
    ? value / 100
    : (bounds.max - bounds.min === 0 ? 0.5 : (value - bounds.min) / (bounds.max - bounds.min));
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
  const padding = Math.max(Math.abs(min) * 0.05, 1);
  return { min: min - padding, max: max + padding };
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp); }
  catch { return value; }
}

function HistoryGroup({ group, history, primary }: { group: Group; history: QuotaHistoryDto; primary: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const bounds = useMemo(() => boundsFor(group), [group]);
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  const selectable = group.series.flatMap(item => item.points.map(point => ({ point, series: item })));
  const selected = selectable[Math.min(selectedIndex, Math.max(0, selectable.length - 1))];
  const move = (delta: number) => setSelectedIndex(index => Math.min(Math.max(index + delta, 0), Math.max(0, selectable.length - 1)));

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
      {group.series.map(item => <path key={item.id} data-testid="quota-history-series-path" className={styles.line} data-series={item.id}
        d={pathFor(item, from, to, bounds)} />)}
      {group.series.map(item => item.points.map((point, index) => {
        const value = valueNumber(point);
        if (value === null) return null;
        const x = pointX(point, from, to);
        const y = yScale(value, item.kind, bounds);
        return <circle key={`${item.id}:${index}`} className={styles.point} cx={x} cy={y} r="3" data-history-point="true"
          onClick={() => setSelectedIndex(selectable.findIndex(entry => entry.series.id === item.id && entry.point === point))}>
          <title>{`${item.label} · ${String(point.value)} · ${formatTime(point.observedAt)}`}</title>
        </circle>;
      }))}
    </svg>
    <div className={styles.legend} aria-label="图例">
      {group.series.map(item => <span key={item.id}><i className={styles.legendDot} />{item.label}</span>)}
    </div>
    <p className={styles.summary} {...(primary ? { role: 'status' } : {})}>
      {selectable.length ? <><span>{selected?.series.label ?? group.title}</span> · <span>{String(selected?.point.value ?? '')}</span> · <time dateTime={selected?.point.observedAt}>{selected ? formatTime(selected.point.observedAt) : ''}</time></> : '暂无可绘制采样点'}
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
