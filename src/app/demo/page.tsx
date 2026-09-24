import { notFound } from 'next/navigation';
import type { DashboardDto } from '../../contracts/dashboard';
import Dashboard from '../../components/dashboard';

export const dynamic = 'force-dynamic';

function demoDashboard(): DashboardDto {
  const generatedAt = new Date();
  const observedAt = generatedAt.toISOString();
  const accounts: DashboardDto['accounts'] = [
    {
      id: 'demo-openai', providerId: 'OpenAI', label: 'Codex Personal', deviceIds: ['demo-mac', 'demo-studio'],
      snapshot: { accountId: 'demo-openai', providerId: 'openai', observedAt, serviceAvailable: true, metrics: [
        { kind: 'quota-window', key: 'five-hour', label: '5-hour limit', usedPercent: 28, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window', key: 'weekly', label: 'Weekly', usedPercent: 41, windowDurationSeconds: 604_800, resetsAt: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
    {
      id: 'demo-anthropic', providerId: 'Anthropic', label: 'Studio', deviceIds: ['demo-studio'],
      snapshot: { accountId: 'demo-anthropic', providerId: 'anthropic', observedAt, serviceAvailable: true, metrics: [
        { kind: 'quota-window', key: 'five-hour', label: '5-hour limit', usedPercent: 56, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window', key: 'weekly', label: 'Weekly', usedPercent: 28, windowDurationSeconds: 604_800, resetsAt: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
    {
      id: 'demo-minimax', providerId: 'MiniMax', label: 'API balance', deviceIds: ['demo-mac'],
      snapshot: { accountId: 'demo-minimax', providerId: 'minimax', observedAt, serviceAvailable: true, metrics: [
        { kind: 'balance', key: 'wallet', label: '账户余额', currency: 'CNY', total: '128.50', granted: null, toppedUp: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle',
    },
  ];
  const devices: DashboardDto['devices'] = [
    { id: 'demo-mac', name: 'Mac mini', heartbeatAt: observedAt, connection: 'online', streamIncomplete: false },
    { id: 'demo-studio', name: 'Studio PC', heartbeatAt: observedAt, connection: 'online', streamIncomplete: false },
    { id: 'demo-laptop', name: 'Travel laptop', heartbeatAt: null, connection: 'offline', streamIncomplete: false },
  ];
  const sessions: DashboardDto['sessions'] = [
    { id: 'demo-approval', deviceId: 'demo-studio', projectId: 'dashboard', projectName: 'Dashboard', title: 'Review pixel dashboard', harness: 'codex', clientType: 'desktop', state: 'WAITING_APPROVAL', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-active-1', deviceId: 'demo-mac', projectId: 'codex-mirror', projectName: 'codex-mirror', title: 'Compact quota rows', harness: 'codex', clientType: 'cli', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'edit_file' },
    { id: 'demo-active-2', deviceId: 'demo-studio', projectId: 'design-system', projectName: 'design-system', title: 'Check small display scaling', harness: 'kimi', clientType: 'desktop', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'browser' },
    { id: 'demo-active-3', deviceId: 'demo-mac', projectId: 'insight-studio', projectName: 'insight-studio', title: 'Export voice snippets', harness: 'kimi', clientType: 'cli', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'terminal' },
    { id: 'demo-idle', deviceId: 'demo-mac', projectId: 'cabinet-builder', projectName: 'cabinet-builder', title: 'Check cabinet measurements', harness: 'codex', clientType: null, state: 'IDLE', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-finished', deviceId: 'demo-studio', projectId: 'docs', projectName: 'docs', title: 'Update setup notes', harness: 'codex', clientType: null, state: 'ENDED', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
  ];
  return { generatedAt: observedAt, devices, sessions, accounts };
}

export default function DashboardPreviewPage() {
  if (process.env.VERCEL_ENV !== 'preview' && process.env.NODE_ENV !== 'development') notFound();
  return <Dashboard initial={demoDashboard()} readOnly />;
}
