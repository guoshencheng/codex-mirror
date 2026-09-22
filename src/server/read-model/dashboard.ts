import type { Pool, PoolClient } from 'pg';
import type { DashboardAccount, DashboardDevice, DashboardDto, DashboardSession, RefreshStatus } from '../../contracts/dashboard';
import type { SessionState } from '../../contracts/events';
import type { ProviderFailureCode, ProviderSnapshot } from '../../contracts/quota';
import { validateProviderSnapshot } from '../providers/metric-schema';
import { deriveFreshness } from '../events/freshness';
import { eventDatabasePool } from '../events/database';

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function connectionState(heartbeatAt: string | null, now: Date): DashboardDevice['connection'] {
  if (!heartbeatAt) return 'offline';
  const age = Math.max(0, now.getTime() - Date.parse(heartbeatAt)) / 1_000;
  if (!Number.isFinite(age) || age >= 120) return 'offline';
  return age >= 60 ? 'stale' : 'online';
}

function refreshState(row: {
  manual_requested_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_success_at: Date | string | null;
  error_code: string | null;
}, now: Date): RefreshStatus {
  const manual = row.manual_requested_at ? new Date(row.manual_requested_at).getTime() : null;
  const attempt = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : null;
  const success = row.last_success_at ? new Date(row.last_success_at).getTime() : null;
  if (attempt !== null && (success === null || attempt > success) && now.getTime() - attempt < 120_000) return 'running';
  if (manual !== null && (attempt === null || attempt < manual)) return 'queued';
  if (row.error_code) return 'error';
  return 'idle';
}

function accountFailure(value: string | null): ProviderFailureCode | null {
  const values: readonly string[] = ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'FORBIDDEN', 'RATE_LIMITED', 'TIMEOUT', 'UNAVAILABLE', 'SCHEMA_CHANGED', 'UNSUPPORTED'];
  return value && values.includes(value) ? value as ProviderFailureCode : null;
}

async function readDevices(client: PoolClient, now: Date): Promise<DashboardDevice[]> {
  const result = await client.query(`SELECT d.id, d.name, d.last_heartbeat_at, COALESCE(s.incomplete, false) AS stream_incomplete
    FROM devices d LEFT JOIN device_streams s ON s.device_id = d.id AND s.epoch = d.current_epoch AND s.active
    WHERE d.revoked_at IS NULL ORDER BY lower(d.name), d.id`);
  return result.rows.map(raw => {
    const row = raw as { id: string; name: string; last_heartbeat_at: Date | string | null; stream_incomplete: boolean };
    const heartbeatAt = toIso(row.last_heartbeat_at);
    return { id: row.id, name: row.name, heartbeatAt, connection: connectionState(heartbeatAt, now), streamIncomplete: row.stream_incomplete };
  });
}

async function readSessions(client: PoolClient, now: Date): Promise<DashboardSession[]> {
  const result = await client.query(`SELECT s.session_id, s.device_id, s.project_key, p.name AS project_name,
      s.title, s.state, started.occurred_at AS turn_started_at, d.last_heartbeat_at,
      COALESCE(ds.incomplete, false) AS stream_incomplete
    FROM sessions s
    JOIN devices d ON d.id = s.device_id AND d.revoked_at IS NULL
    LEFT JOIN device_streams ds ON ds.device_id = d.id AND ds.epoch = d.current_epoch AND ds.active
    LEFT JOIN projects p ON p.project_key = s.project_key
    LEFT JOIN LATERAL (
      SELECT e.occurred_at FROM agent_events e
      JOIN device_streams ds ON ds.device_id = e.device_id AND ds.epoch = e.epoch AND ds.generation = s.generation
      WHERE e.device_id = s.device_id AND e.session_id = s.session_id AND e.event_type = 'turn.started'
        AND e.applied = true AND e.payload->>'turnId' = s.state->>'turnId'
      ORDER BY e.sequence DESC LIMIT 1
    ) started ON true
    ORDER BY (s.state->>'state' = 'WAITING_APPROVAL') DESC, s.updated_at DESC, s.session_id`);
  return result.rows.map(raw => {
    const row = raw as {
      session_id: string; device_id: string; project_key: string | null; project_name: string | null;
      title: string | null; state: SessionState; turn_started_at: Date | string | null;
      last_heartbeat_at: Date | string | null; stream_incomplete: boolean;
    };
    const freshness = deriveFreshness({
      state: row.state,
      heartbeatAt: toIso(row.last_heartbeat_at),
      now: now.toISOString(),
      streamIncomplete: row.stream_incomplete,
    });
    return {
      id: row.session_id,
      deviceId: row.device_id,
      projectId: row.project_key,
      projectName: row.project_name,
      title: row.title ?? `会话 ${row.session_id.slice(0, 8)}`,
      state: row.state.state,
      confidence: freshness.confidence,
      lastEventAt: row.state.lastEventAt,
      lastReceivedAt: row.state.lastReceivedAt,
      turnStartedAt: toIso(row.turn_started_at),
      currentTool: row.state.currentTool,
    };
  });
}

async function readAccounts(client: PoolClient, now: Date): Promise<DashboardAccount[]> {
  const result = await client.query(`SELECT a.id, a.provider_id, a.label, l.device_ids, q.snapshot,
      s.last_attempt_at, s.last_success_at, s.error_code, s.manual_requested_at
    FROM provider_accounts a
    LEFT JOIN LATERAL (
      SELECT array_agg(d.id ORDER BY d.id) AS device_ids
      FROM device_account_links link JOIN devices d ON d.id = link.device_id AND d.revoked_at IS NULL
      WHERE link.account_id = a.id
    ) l ON true
    LEFT JOIN quota_latest q ON q.account_id = a.id
    LEFT JOIN quota_refresh_status s ON s.account_id = a.id
    WHERE a.enabled = true ORDER BY lower(a.label), a.id`);
  return result.rows.map(raw => {
    const row = raw as {
      id: string; provider_id: string; label: string; device_ids: string[] | null; snapshot: unknown;
      last_attempt_at: Date | string | null; last_success_at: Date | string | null;
      error_code: string | null; manual_requested_at: Date | string | null;
    };
    let snapshot: ProviderSnapshot | null = null;
    if (row.snapshot) {
      try { snapshot = validateProviderSnapshot(row.snapshot); }
      catch { snapshot = null; }
    }
    return {
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      deviceIds: row.device_ids ?? [],
      snapshot,
      lastAttemptAt: toIso(row.last_attempt_at),
      lastSuccessAt: toIso(row.last_success_at),
      errorCode: accountFailure(row.error_code),
      refreshStatus: refreshState(row, now),
    };
  });
}

export async function getDashboard(now = new Date(), pool: Pool = eventDatabasePool()): Promise<DashboardDto> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const devices = await readDevices(client, now);
    const sessions = await readSessions(client, now);
    const accounts = await readAccounts(client, now);
    await client.query('COMMIT');
    return { generatedAt: now.toISOString(), devices, sessions, accounts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function getDevices(now = new Date(), pool: Pool = eventDatabasePool()): Promise<DashboardDevice[]> {
  return (await getDashboard(now, pool)).devices;
}

export async function getSessions(now = new Date(), pool: Pool = eventDatabasePool()): Promise<DashboardSession[]> {
  return (await getDashboard(now, pool)).sessions;
}

export async function getAccounts(now = new Date(), pool: Pool = eventDatabasePool()): Promise<DashboardAccount[]> {
  return (await getDashboard(now, pool)).accounts;
}
