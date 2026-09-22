import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createDirectDatabasePool } from './pool';

export type DashboardNotification = { type: 'sync' } | { type: 'invalidate'; topic: 'events' | 'heartbeat' | 'quota' };
export type NotificationListener = (notification: DashboardNotification) => void;

export interface NotificationHubOptions {
  applicationName?: string;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const knownTopics = new Set(['events', 'heartbeat', 'quota']);

export class PgNotificationHub {
  readonly applicationName: string;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly listeners = new Set<NotificationListener>();
  private readonly clientListeners = new WeakMap<PoolClient, { notification: (message: { channel?: string; payload?: string }) => void; failure: () => void }>();
  private client: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private connectedOnce = false;
  private closed = false;

  constructor(private readonly pool: Pool, options: NotificationHubOptions = {}) {
    this.applicationName = (options.applicationName ?? `dashboard-listen-${randomUUID()}`).slice(0, 63);
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  }

  async subscribe(listener: NotificationListener): Promise<() => void> {
    if (this.closed) throw new Error('NOTIFICATION_HUB_CLOSED');
    this.listeners.add(listener);
    try { await this.ensureConnected(); }
    catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => { this.listeners.delete(listener); };
  }

  private ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.connecting = this.connectListener().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connectListener(): Promise<void> {
    if (this.closed) throw new Error('NOTIFICATION_HUB_CLOSED');
    const client = await this.pool.connect();
    if (this.closed) { client.release(true); throw new Error('NOTIFICATION_HUB_CLOSED'); }
    this.client = client;
    const onNotification = (message: { channel?: string; payload?: string }) => {
      if (message.channel !== 'dashboard_changed' || !message.payload || !knownTopics.has(message.payload)) return;
      this.broadcast({ type: 'invalidate', topic: message.payload as 'events' | 'heartbeat' | 'quota' });
    };
    const onFailure = () => { this.connectionLost(client); };
    this.clientListeners.set(client, { notification: onNotification, failure: onFailure });
    client.on('notification', onNotification);
    client.on('error', onFailure);
    client.on('end', onFailure);
    try {
      await client.query('SELECT set_config($1, $2, false)', ['application_name', this.applicationName]);
      await client.query('LISTEN dashboard_changed');
      if (this.closed || this.client !== client) {
        if (this.client === client) this.client = undefined;
        this.discard(client);
        return;
      }
      this.retryCount = 0;
      if (this.connectedOnce) this.broadcast({ type: 'sync' });
      this.connectedOnce = true;
    } catch (error) {
      this.connectionLost(client);
      throw error;
    }
  }

  private connectionLost(client: PoolClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.discard(client);
    this.scheduleReconnect();
  }

  private discard(client: PoolClient): void {
    const callbacks = this.clientListeners.get(client);
    if (callbacks) {
      client.removeListener('notification', callbacks.notification);
      client.removeListener('error', callbacks.failure);
      client.removeListener('end', callbacks.failure);
      this.clientListeners.delete(client);
    }
    client.release(true);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer || this.connecting) return;
    const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** Math.min(this.retryCount, 8));
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private broadcast(notification: DashboardNotification): void {
    for (const listener of this.listeners) {
      try { listener(notification); } catch { /* one slow stream must not block other subscribers */ }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.listeners.clear();
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      this.discard(client);
    }
    await this.connecting?.catch(() => undefined);
  }
}

let directPool: Pool | undefined;
let defaultHub: PgNotificationHub | undefined;

export function notificationDatabasePool(): Pool {
  directPool ??= createDirectDatabasePool();
  return directPool;
}

export function notificationHub(): PgNotificationHub {
  defaultHub ??= new PgNotificationHub(notificationDatabasePool());
  return defaultHub;
}

export function adminStreamLockKey(adminId: string, slot: number): string {
  return `codex-status-dashboard:sse:${adminId}:${slot}`;
}
