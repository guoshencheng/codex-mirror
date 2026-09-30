'use client';

import { Line } from '@ant-design/plots';
import type { LineConfig } from '@ant-design/plots';
import { useMemo, useState } from 'react';
import type { QuotaHistoryDto, QuotaHistoryPoint, QuotaHistorySeries } from '../contracts/quota-history';
import styles from './quota-history.module.css';

const SERIES_COLORS = ['#9a8cff', '#57c7ff', '#f4b95f', '#68d39b', '#f18497'] as const;

interface Group {
  id: string;
  title: string;
  unit: string;
  kind: QuotaHistorySeries['kind'];
  series: QuotaHistorySeries[];
}

interface ChartPoint {
  observedAt: Date;
  value: number | null;
  series: string;
  originalValue: string;
  resetsAt: string | null;
}

function groupsFor(history: QuotaHistoryDto): Group[] {
  const groups = new Map<string, Group>();
  for (const item of history.series) {
    const id = item.kind === 'balance' ? `balance:${item.unit}` : 'quota-window';
    const group = groups.get(id) ?? {
      id,
      title: item.kind === 'balance' ? `余额 · ${item.unit}` : '额度窗口',
      unit: item.unit,
      kind: item.kind,
      series: [],
    };
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

function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return value.toExponential(2);
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
  } catch {
    return String(value);
  }
}

function formatTime(value: string | Date): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
  } catch {
    return String(value);
  }
}

function formatCompactTime(value: string | Date): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPointValue(series: QuotaHistorySeries, point: QuotaHistoryPoint): string {
  return `${String(point.value)}${series.kind === 'quota-window' ? '%' : ` ${series.unit}`}`;
}

function formatReset(point: QuotaHistoryPoint): string {
  return point.resetsAt ? ` · 重置 ${formatTime(point.resetsAt)}` : '';
}

function valuesFor(group: Group): number[] {
  return group.series
    .flatMap(item => item.points.map(valueNumber))
    .filter((value): value is number => value !== null);
}

function boundsFor(group: Group): { min: number; max: number } | null {
  if (group.kind === 'quota-window') return { min: 0, max: 100 };
  const values = valuesFor(group);
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min !== max) return { min, max };
  const padding = Math.min(Math.max(Math.abs(min) * 0.05, 1), Number.MAX_VALUE / 16);
  const lower = min - padding;
  const upper = max + padding;
  return Number.isFinite(lower) && Number.isFinite(upper) && lower !== upper
    ? { min: lower, max: upper }
    : min === 0 ? { min: -1, max: 1 } : { min: min * 0.99, max: min * 1.01 };
}

function axisTicks(group: Group, bounds: { min: number; max: number } | null): string[] {
  if (group.kind === 'quota-window') return ['100%', '50%', '0%'];
  if (!bounds) return [group.unit];
  const span = bounds.max - bounds.min;
  const middle = Number.isFinite(span) ? bounds.min + span / 2 : bounds.min / 2 + bounds.max / 2;
  return [formatAxisValue(bounds.max), formatAxisValue(middle), formatAxisValue(bounds.min)];
}

function chartData(group: Group): ChartPoint[] {
  const data: ChartPoint[] = [];
  for (const item of group.series) {
    let hasPrevious = false;
    for (const point of item.points) {
      const observedAt = new Date(point.observedAt);
      if (!Number.isFinite(observedAt.getTime())) continue;
      if (point.breakBefore && hasPrevious) {
        data.push({
          observedAt,
          value: null,
          series: item.id,
          originalValue: '',
          resetsAt: null,
        });
      }
      data.push({
        observedAt,
        value: valueNumber(point),
        series: item.id,
        originalValue: String(point.value),
        resetsAt: point.resetsAt,
      });
      hasPrevious = true;
    }
  }
  return data;
}

function configFor(group: Group, data: ChartPoint[], bounds: { min: number; max: number } | null): LineConfig {
  const config: LineConfig = {
    data,
    xField: 'observedAt',
    yField: 'value',
    seriesField: 'series',
    colorField: 'series',
    autoFit: true,
    height: 208,
    scale: {
      x: { type: 'time', tickCount: 5 },
      y: group.kind === 'quota-window'
        ? { domain: [0, 100], nice: false }
        : bounds ? { domain: [bounds.min, bounds.max], nice: true } : { nice: true },
      color: { range: group.series.map((_, index) => colorFor(index)) },
    },
    axis: {
      x: { title: false, labelAutoRotate: false, labelAutoHide: true, labelFormatter: (value: string | Date) => formatCompactTime(value) },
      y: {
        title: false,
        labelFormatter: (value: string | number) => group.kind === 'quota-window' ? `${value}%` : formatAxisValue(Number(value)),
      },
    },
    legend: false,
    theme: { type: 'classicDark' },
    tooltip: {
      title: (datum: ChartPoint) => formatTime(datum.observedAt),
      items: [
        { field: 'value', name: group.unit, valueFormatter: (value: string | number) => group.kind === 'quota-window' ? `${value}%` : `${value} ${group.unit}` },
        { field: 'resetsAt', name: '重置', valueFormatter: (value: string | null) => value ? formatTime(value) : '—' },
      ],
    },
    interaction: {
      tooltip: { series: true },
      elementHighlight: true,
    },
    line: { style: { lineWidth: 0.5, shape: 'smooth' } },
  };
  return config;
}

function HistoryGroup({ group, history, primary }: { group: Group; history: QuotaHistoryDto; primary: boolean }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const data = useMemo(() => chartData(group), [group]);
  const bounds = useMemo(() => boundsFor(group), [group]);
  const ticks = axisTicks(group, bounds);
  const selectable = group.series.flatMap(item => item.points.map(point => ({ point, series: item })));
  const selected = selectable[Math.min(selectedIndex, Math.max(0, selectable.length - 1))];
  const hasUnplottable = group.series.some(item => item.kind === 'balance' && item.points.some(point => valueNumber(point) === null));
  const config = useMemo(() => configFor(group, data, bounds), [bounds, data, group]);

  return <section className={styles.chartGroup} aria-label={`${group.title}历史`}>
    <h4>{group.title}</h4>
    <div className={styles.chartShell} role="img" aria-label={primary ? '额度历史折线图' : `${group.title}历史折线图`}>
      {data.some(point => point.value !== null) ? <Line {...config} /> : <p className={styles.noPlot}>暂无可绘制数值</p>}
    </div>
    <div className={styles.axisMeta} aria-hidden="true">
      <span>{ticks[0]}</span>
      <span>{ticks[1] ?? ''}</span>
      <span>{ticks[2] ?? ''}</span>
      <span className={styles.axisRange} data-testid="quota-history-range">{formatCompactTime(history.from)} — {formatCompactTime(history.to)}</span>
      <span className={styles.axisTime}>时间</span>
    </div>
    <div className={styles.legend} aria-label="图例">
      {group.series.map((item, index) => <span key={item.id}><i className={styles.legendDot} style={{ backgroundColor: colorFor(index) }} />{item.label}</span>)}
    </div>
    {hasUnplottable ? <p className={styles.plotNotice} role="note">数值过大，无法绘图；原始值仍显示在提示和摘要中</p> : null}
    <p className={styles.summary} {...(primary ? { role: 'status' } : {})}>
      {selectable.length ? <><span>{selected?.series.label ?? group.title}</span> · <span>{String(selected?.point.value ?? '')}</span> <span>{selected?.series.kind === 'quota-window' ? '%' : selected?.series.unit ?? group.unit}</span> · <time dateTime={selected?.point.observedAt}>{selected ? formatTime(selected.point.observedAt) : ''}</time>{selected ? formatReset(selected.point) : ''}</> : '暂无可绘制采样点'}
    </p>
    {selectable.length ? <p className={styles.pointCount}>共 {selectable.length} 个采样点</p> : null}
    {selectable.length > 1 ? <div className={styles.pointControls} aria-label="历史采样点">
      <button type="button" onClick={() => setSelectedIndex(index => Math.max(0, index - 1))} disabled={selectedIndex === 0} aria-label="上一个采样点">‹</button>
      <span>{selectedIndex + 1} / {selectable.length}</span>
      <button type="button" onClick={() => setSelectedIndex(index => Math.min(selectable.length - 1, index + 1))} disabled={selectedIndex >= selectable.length - 1} aria-label="下一个采样点">›</button>
    </div> : null}
    {selectable.some(entry => entry.series.kind === 'balance' && valueNumber(entry.point) === null) ? <p className={styles.exactValues}>原始值：{selectable.filter(entry => entry.series.kind === 'balance' && valueNumber(entry.point) === null).map(entry => formatPointValue(entry.series, entry.point)).join('、')}</p> : null}
  </section>;
}

export default function QuotaHistoryChart({ history }: { history: QuotaHistoryDto }) {
  const groups = groupsFor(history);
  if (!groups.length) return <p className={styles.empty}>所选时间范围内暂无额度历史</p>;
  return <div className={styles.chartList} data-testid="quota-history-line-chart" data-series-count={String(history.series.length)}>
    {groups.map((group, index) => <HistoryGroup key={group.id} group={group} history={history} primary={index === 0} />)}
  </div>;
}
