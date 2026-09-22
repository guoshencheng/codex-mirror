import { ProviderTransportError, requestJson } from '../http';

interface KimiUsageEnvelope {
  code?: unknown;
  data?: { kind?: unknown; status?: unknown };
}

function assertLoopback(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('INVALID_KIMI_BASE_URL');
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname) || url.username || url.password) {
    throw new Error('KIMI_LOOPBACK_REQUIRED');
  }
  return url;
}

export class KimiUsageClient {
  private readonly baseUrl: URL;

  constructor(baseUrl: string, private readonly bearerToken: string) {
    this.baseUrl = assertLoopback(baseUrl);
    if (!bearerToken) throw new Error('KIMI_TOKEN_REQUIRED');
  }

  async readUsage(signal: AbortSignal): Promise<unknown> {
    const url = new URL('/api/v1/oauth/usage', this.baseUrl);
    const envelope = await requestJson<KimiUsageEnvelope>(url, {
      signal,
      timeoutMs: 30_000,
      headers: { Authorization: `Bearer ${this.bearerToken}`, Accept: 'application/json' },
    });

    if (!envelope || envelope.code !== 0 || !envelope.data || typeof envelope.data.kind !== 'string') {
      throw new ProviderTransportError('SCHEMA_CHANGED');
    }
    if (envelope.data.kind === 'ok') return envelope;
    if (envelope.data.kind !== 'error') throw new ProviderTransportError('SCHEMA_CHANGED');

    const status = envelope.data.status;
    if (status === 401) throw new ProviderTransportError('AUTH_EXPIRED');
    if (status === 403) throw new ProviderTransportError('FORBIDDEN');
    if (status === 429) throw new ProviderTransportError('RATE_LIMITED');
    throw new ProviderTransportError('UNAVAILABLE');
  }
}
