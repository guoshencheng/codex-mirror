import { notFound } from 'next/navigation';
import type { DashboardDto } from '../../contracts/dashboard';
import Dashboard from '../../components/dashboard';

export const dynamic = 'force-dynamic';

function demoDashboard(): DashboardDto {
  const generatedAt = new Date();
  const observedAt = generatedAt.toISOString();
  const accounts: DashboardDto['accounts'] = [
    {
      id: 'demo-openai', providerId: 'OpenAI', label: 'Codex Personal',
      snapshot: { accountId: 'demo-openai', providerId: 'openai', observedAt, serviceAvailable: true, metrics: [
        { kind: 'quota-window', key: 'five-hour', label: '5-hour limit', usedPercent: 28, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window', key: 'weekly', label: 'Weekly', usedPercent: 41, windowDurationSeconds: 604_800, resetsAt: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
    {
      id: 'demo-anthropic', providerId: 'Anthropic', label: 'Studio',
      snapshot: { accountId: 'demo-anthropic', providerId: 'anthropic', observedAt, serviceAvailable: true, metrics: [
        { kind: 'quota-window', key: 'five-hour', label: '5-hour limit', usedPercent: 56, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window', key: 'weekly', label: 'Weekly', usedPercent: 28, windowDurationSeconds: 604_800, resetsAt: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
    {
      id: 'demo-minimax', providerId: 'MiniMax', label: 'API balance',
      snapshot: { accountId: 'demo-minimax', providerId: 'minimax', observedAt, serviceAvailable: true, metrics: [
        { kind: 'balance', key: 'wallet', label: '账户余额', currency: 'CNY', total: '128.50', granted: null, toppedUp: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
  ];
  return { generatedAt: observedAt, accounts };
}

export default function DashboardPreviewPage() {
  if (process.env.VERCEL_ENV !== 'preview' && process.env.NODE_ENV !== 'development') notFound();
  return <Dashboard initial={demoDashboard()} readOnly />;
}
