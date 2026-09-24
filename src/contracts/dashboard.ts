import type { ClientType, Harness, SessionState } from './events';
import type { ProviderFailureCode, ProviderSnapshot } from './quota';

export type DeviceConnection = 'online' | 'stale' | 'offline';
export type RefreshStatus = 'idle' | 'queued' | 'running' | 'error';

export interface DashboardDevice {
  id: string;
  name: string;
  heartbeatAt: string | null;
  connection: DeviceConnection;
  streamIncomplete: boolean;
}

export interface DashboardSession {
  id: string;
  deviceId: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  harness: Harness | null;
  clientType: ClientType | null;
  state: SessionState['state'];
  confidence: SessionState['confidence'];
  lastEventAt: string;
  lastReceivedAt: string;
  turnStartedAt: string | null;
  currentTool: string | null;
}

export interface DashboardAccount {
  id: string;
  providerId: string;
  label: string;
  deviceIds: string[];
  snapshot: ProviderSnapshot | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorCode: ProviderFailureCode | null;
  refreshStatus: RefreshStatus;
}

export interface DashboardDto {
  generatedAt: string;
  devices: DashboardDevice[];
  sessions: DashboardSession[];
  accounts: DashboardAccount[];
}
