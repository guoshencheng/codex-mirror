export type ProviderId = string;
export type MetricKind = 'quota-window' | 'balance';
export type AuthMode = 'api-key' | 'managed-login';

export interface ProviderCapabilities {
  metricKinds: readonly MetricKind[];
  authModes: readonly AuthMode[];
}

export interface ProviderAccountConfig {
  id: string;
  providerId: ProviderId;
  label: string;
  credentialRef: string;
  options: Readonly<Record<string, unknown>>;
}

export interface QuotaWindowMetric {
  kind: 'quota-window';
  key: string;
  label: string;
  usedPercent: number | null;
  windowDurationSeconds: number | null;
  resetsAt: string | null;
}

export interface BalanceMetric {
  kind: 'balance';
  key: string;
  label: string;
  currency: string;
  total: string;
  granted: string | null;
  toppedUp: string | null;
}

export type QuotaMetric = QuotaWindowMetric | BalanceMetric;

export interface ProviderSnapshot {
  accountId: string;
  providerId: ProviderId;
  observedAt: string;
  metrics: readonly QuotaMetric[];
  serviceAvailable: boolean | null;
}

export type ProviderFailureCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'SCHEMA_CHANGED'
  | 'UNSUPPORTED';

export interface ProviderFailure {
  code: ProviderFailureCode;
  retryAfterSeconds?: number;
}

export type ProviderFetchResult =
  | { ok: true; snapshot: ProviderSnapshot }
  | { ok: false; error: ProviderFailure };

export interface ProviderContext {
  signal: AbortSignal;
  readSecret(ref: string): Promise<string>;
}

export interface QuotaProviderStrategy {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  validateConfig(config: ProviderAccountConfig): readonly string[];
  fetchSnapshot(
    config: ProviderAccountConfig,
    context: ProviderContext,
  ): Promise<ProviderFetchResult>;
}
