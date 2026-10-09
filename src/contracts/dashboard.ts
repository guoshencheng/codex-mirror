import type { ProviderFailureCode, ProviderSnapshot } from './quota';

export type RefreshStatus = 'idle' | 'queued' | 'running' | 'error';

export interface DashboardAccount {
  id: string;
  providerId: string;
  label: string;
  snapshot: ProviderSnapshot | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorCode: ProviderFailureCode | null;
  refreshStatus: RefreshStatus;
}

export interface DashboardDto {
  generatedAt: string;
  accounts: DashboardAccount[];
}
