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
    ...[
      { id: 'demo-codex-work', providerId: 'OpenAI', label: 'Codex Work', fiveHour: 84, weekly: 66 },
      { id: 'demo-kimi', providerId: 'Kimi', label: 'Kimi Code', fiveHour: 47, weekly: 81 },
      { id: 'demo-deepseek', providerId: 'DeepSeek', label: 'DeepSeek API', fiveHour: 63, weekly: 37 },
      { id: 'demo-studio-backup', providerId: 'Anthropic', label: 'Backup', fiveHour: 92, weekly: 74 },
      { id: 'demo-codex-test', providerId: 'OpenAI', label: 'Test', fiveHour: 15, weekly: 24 },
    ].map(item => ({
      id: item.id, providerId: item.providerId, label: item.label, deviceIds: ['demo-mac'],
      snapshot: { accountId: item.id, providerId: item.providerId, observedAt, serviceAvailable: true, metrics: [
        { kind: 'quota-window' as const, key: 'five-hour', label: '5-hour limit', usedPercent: 100 - item.fiveHour, windowDurationSeconds: 18_000, resetsAt: null },
        { kind: 'quota-window' as const, key: 'weekly', label: 'Weekly', usedPercent: 100 - item.weekly, windowDurationSeconds: 604_800, resetsAt: null },
      ] },
      lastAttemptAt: observedAt, lastSuccessAt: observedAt, errorCode: null, refreshStatus: 'idle' as const,
    })),
  ];
  const devices: DashboardDto['devices'] = [
    { id: 'demo-mac', name: 'Mac mini', heartbeatAt: observedAt, connection: 'online', streamIncomplete: false },
    { id: 'demo-studio', name: 'Studio PC', heartbeatAt: observedAt, connection: 'online', streamIncomplete: false },
    { id: 'demo-laptop', name: 'Travel laptop', heartbeatAt: null, connection: 'offline', streamIncomplete: false },
  ];
  const sessions: DashboardDto['sessions'] = [
    { id: 'demo-approval', deviceId: 'demo-studio', projectId: 'dashboard', projectName: 'Dashboard', title: 'Review pixel dashboard', state: 'WAITING_APPROVAL', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-active-1', deviceId: 'demo-mac', projectId: 'codex-mirror', projectName: 'codex-mirror', title: 'Compact quota rows', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'edit_file' },
    { id: 'demo-active-2', deviceId: 'demo-studio', projectId: 'design-system', projectName: 'design-system', title: 'Check small display scaling', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'browser' },
    { id: 'demo-active-3', deviceId: 'demo-mac', projectId: 'insight-studio', projectName: 'insight-studio', title: 'Export voice snippets', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'terminal' },
    { id: 'demo-active-4', deviceId: 'demo-studio', projectId: 'website', projectName: 'Website', title: 'Polish landing page', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'edit_file' },
    { id: 'demo-active-5', deviceId: 'demo-mac', projectId: 'api', projectName: 'API', title: 'Verify API responses', state: 'WORKING', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: 'terminal' },
    { id: 'demo-idle', deviceId: 'demo-mac', projectId: 'cabinet-builder', projectName: 'cabinet-builder', title: 'Check cabinet measurements', state: 'IDLE', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-idle-2', deviceId: 'demo-studio', projectId: 'research', projectName: 'Research', title: 'Review research notes', state: 'IDLE', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-finished', deviceId: 'demo-studio', projectId: 'docs', projectName: 'docs', title: 'Update setup notes', state: 'ENDED', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-finished-2', deviceId: 'demo-mac', projectId: 'tests', projectName: 'Tests', title: 'Run component checks', state: 'ENDED', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-interrupted', deviceId: 'demo-studio', projectId: 'deploy', projectName: 'Deploy', title: 'Inspect deployment logs', state: 'INTERRUPTED', confidence: 'confirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: null, currentTool: null },
    { id: 'demo-offline', deviceId: 'demo-laptop', projectId: 'mobile', projectName: 'Mobile', title: 'Check mobile layout', state: 'WORKING', confidence: 'unconfirmed', lastEventAt: observedAt, lastReceivedAt: observedAt, turnStartedAt: observedAt, currentTool: null },
  ];
  return { generatedAt: observedAt, devices, sessions, accounts };
}

export default function DashboardPreviewPage() {
  if (process.env.VERCEL_ENV !== 'preview' && process.env.NODE_ENV !== 'development') notFound();
  return <Dashboard initial={demoDashboard()} readOnly />;
}
