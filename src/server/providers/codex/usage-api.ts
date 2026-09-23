import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderTransportError, requestJson } from '../http';

const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const DEFAULT_REFRESH_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const usageWindowSchema = z.object({
  used_percent: z.number().finite().min(0).max(100),
  limit_window_seconds: z.number().int().positive(),
  reset_at: z.union([z.number().finite(), z.string()]).nullish(),
}).passthrough();

const usagePayloadSchema = z.object({
  rate_limit: z.object({
    primary_window: usageWindowSchema.nullish(),
    secondary_window: usageWindowSchema.nullish(),
  }).passthrough(),
}).passthrough();

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
}).passthrough();

interface CodexAuthDocument {
  tokens?: Record<string, unknown>;
  [key: string]: unknown;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readAuthDocument(home: string): Promise<CodexAuthDocument> {
  let raw: string;
  try {
    raw = await readFile(join(home, 'auth.json'), 'utf8');
  } catch {
    throw new ProviderTransportError('AUTH_EXPIRED');
  }
  try {
    const doc: unknown = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object');
    return doc as CodexAuthDocument;
  } catch {
    throw new ProviderTransportError('AUTH_EXPIRED');
  }
}

async function writeAuthDocument(home: string, doc: CodexAuthDocument): Promise<void> {
  const temp = join(home, `.auth.json.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  await rename(temp, join(home, 'auth.json'));
}

function resetEpochSeconds(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Math.floor(value);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ProviderTransportError('SCHEMA_CHANGED');
  return Math.floor(ms / 1000);
}

function normalizeWindow(window: z.infer<typeof usageWindowSchema> | null | undefined) {
  if (!window) return null;
  return {
    usedPercent: window.used_percent,
    windowDurationMins: Math.max(1, Math.round(window.limit_window_seconds / 60)),
    resetsAt: resetEpochSeconds(window.reset_at),
  };
}

function normalizeUsage(payload: unknown): unknown {
  const parsed = usagePayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');
  const { primary_window: primary, secondary_window: secondary } = parsed.data.rate_limit;
  if (!primary && !secondary) throw new ProviderTransportError('SCHEMA_CHANGED');
  return { rateLimits: { primary: normalizeWindow(primary), secondary: normalizeWindow(secondary) } };
}

/**
 * Reads ChatGPT quota through the wham usage HTTP API with the OAuth tokens the
 * Codex CLI stored in the account's auth.json, refreshing expired tokens itself.
 * Honours HTTP(S)_PROXY when the runtime enables Node's env proxy support.
 */
export class CodexUsageApi {
  constructor(
    private readonly home: string,
    private readonly usageUrl = DEFAULT_USAGE_URL,
    private readonly refreshUrl = DEFAULT_REFRESH_URL,
  ) {}

  async readRateLimits(signal: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
    const auth = await this.credentials();
    try {
      return normalizeUsage(await this.fetchUsage(auth.accessToken, auth.accountId, signal, timeoutMs));
    } catch (error) {
      if (!(error instanceof ProviderTransportError) || error.code !== 'AUTH_EXPIRED') throw error;
    }
    await this.refresh(signal, timeoutMs);
    const refreshed = await this.credentials();
    return normalizeUsage(await this.fetchUsage(refreshed.accessToken, refreshed.accountId, signal, timeoutMs));
  }

  private async credentials(): Promise<{ accessToken: string; accountId: string }> {
    const doc = await readAuthDocument(this.home);
    const accessToken = nonEmpty(doc.tokens?.access_token);
    const accountId = nonEmpty(doc.tokens?.account_id);
    if (!accessToken || !accountId) throw new ProviderTransportError('AUTH_EXPIRED');
    return { accessToken, accountId };
  }

  private async fetchUsage(accessToken: string, accountId: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    return requestJson(this.usageUrl, {
      signal,
      timeoutMs,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        accept: 'application/json',
      },
    });
  }

  private async refresh(signal: AbortSignal, timeoutMs: number): Promise<void> {
    const doc = await readAuthDocument(this.home);
    const refreshToken = nonEmpty(doc.tokens?.refresh_token);
    if (!refreshToken) throw new ProviderTransportError('AUTH_EXPIRED');

    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await fetch(this.refreshUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: REFRESH_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: combined,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (combined.aborted) throw new ProviderTransportError('TIMEOUT');
      throw new ProviderTransportError('UNAVAILABLE');
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new ProviderTransportError('AUTH_EXPIRED');
    }
    if (response.status === 429) throw new ProviderTransportError('RATE_LIMITED');
    if (!response.ok) throw new ProviderTransportError('UNAVAILABLE');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderTransportError('SCHEMA_CHANGED');
    }
    const parsed = refreshResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderTransportError('SCHEMA_CHANGED');

    const tokens = (doc.tokens ??= {});
    tokens.access_token = parsed.data.access_token;
    if (parsed.data.refresh_token) tokens.refresh_token = parsed.data.refresh_token;
    if (parsed.data.id_token) tokens.id_token = parsed.data.id_token;
    doc.last_refresh = new Date().toISOString();
    await writeAuthDocument(this.home, doc);
  }
}
