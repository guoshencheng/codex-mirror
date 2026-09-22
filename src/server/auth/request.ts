export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid' | 'too_large' };

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<BoundedJsonResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { ok: false, reason: 'invalid' };
    if (Number(declaredLength) > maximumBytes) return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: false, reason: 'invalid' };

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: JSON.parse(text) };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'invalid' };
  } finally {
    reader.releaseLock();
  }
}
