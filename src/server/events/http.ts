export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413) { super(status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON'); }
}

export async function readBoundedJson(request: Request, maxBytes = 256_000): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new RequestBodyError(413);
  if (!request.body) throw new RequestBodyError(400);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError(413);
      }
      parts.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400);
  } finally { reader.releaseLock(); }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts.map(part => Buffer.from(part))));
    return JSON.parse(text) as unknown;
  } catch { throw new RequestBodyError(400); }
}

export function noStoreJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set('cache-control', 'no-store');
  outputHeaders.set('content-type', 'application/json; charset=utf-8');
  return Response.json(body, { status, headers: outputHeaders });
}
