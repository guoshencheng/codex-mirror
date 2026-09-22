import type { ProviderFailureCode } from '../../contracts/quota';

export class ProviderTransportError extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ProviderTransportError';
  }
}

export interface JsonRequestOptions {
  signal: AbortSignal;
  headers?: HeadersInit;
  timeoutMs: number;
  maxBytes?: number;
}

function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ProviderTransportError('SCHEMA_CHANGED');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderTransportError('SCHEMA_CHANGED');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function requestJson<T = unknown>(url: string | URL, options: JsonRequestOptions): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('REQUEST_TIMEOUT')), options.timeoutMs);

  try {
    if (options.signal.aborted) throw options.signal.reason ?? new Error('REQUEST_ABORTED');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: options.headers,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (controller.signal.aborted) throw new ProviderTransportError('TIMEOUT');
      throw new ProviderTransportError('UNAVAILABLE');
    }

    if (response.status === 401) throw new ProviderTransportError('AUTH_EXPIRED');
    if (response.status === 403) throw new ProviderTransportError('FORBIDDEN');
    if (response.status === 429) {
      throw new ProviderTransportError('RATE_LIMITED', retryAfterSeconds(response.headers.get('retry-after')));
    }
    if (!response.ok) throw new ProviderTransportError('UNAVAILABLE');

    const bytes = await readLimited(response, options.maxBytes ?? 1_048_576);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    } catch {
      throw new ProviderTransportError('SCHEMA_CHANGED');
    }
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    if (options.signal.aborted) throw new Error('REQUEST_ABORTED');
    if (controller.signal.aborted) throw new ProviderTransportError('TIMEOUT');
    throw new ProviderTransportError('UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', onAbort);
  }
}
