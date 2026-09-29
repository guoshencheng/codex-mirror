import type { Pool } from 'pg';
import { requireAdmin } from '../auth/session';
import { authorizeDisplayRequest, displayPreflight } from '../auth/display';
import { readQuotaHistory, isQuotaHistoryRange } from './history';
import { QuotaRepository } from './repository';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type HistoryContext = { params: Promise<{ id: string }> };

function errorResponse(error: string, status: number, headers: HeadersInit = NO_STORE): Response {
  return Response.json({ error }, { status, headers });
}

function validAccountId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function readRange(request: Request) {
  const values = new URL(request.url).searchParams.getAll('range');
  if (!values.length) return '24h' as const;
  return values.length === 1 && isQuotaHistoryRange(values[0]) ? values[0] : null;
}

export function createQuotaHistoryHandlers(pool: Pool, now: () => Date = () => new Date()) {
  const repository = new QuotaRepository(pool);

  async function params(context: HistoryContext): Promise<string | null> {
    try {
      const id = (await context.params).id;
      return validAccountId(id) ? id : null;
    } catch {
      return null;
    }
  }

  async function read(request: Request, context: HistoryContext, headers: HeadersInit): Promise<Response> {
    const id = await params(context);
    if (!id) return errorResponse('NOT_FOUND', 404, headers);
    const range = readRange(request);
    if (!range) return errorResponse('INVALID_INPUT', 400, headers);
    try {
      const result = await readQuotaHistory(repository, id, range, now());
      return result === null ? errorResponse('NOT_FOUND', 404, headers) : Response.json(result, { headers });
    } catch {
      return errorResponse('HISTORY_UNAVAILABLE', 503, headers);
    }
  }

  return {
    async admin(request: Request, context: HistoryContext): Promise<Response> {
      let admin;
      try { admin = await requireAdmin(request, pool); }
      catch { return errorResponse('AUTH_UNAVAILABLE', 503); }
      if (!admin) return errorResponse('UNAUTHORIZED', 401);
      return read(request, context, NO_STORE);
    },
    async display(request: Request, context: HistoryContext): Promise<Response> {
      const authorization = authorizeDisplayRequest(request);
      if ('response' in authorization) return authorization.response;
      return read(request, context, authorization.headers);
    },
    options(request: Request): Response {
      return displayPreflight(request);
    },
  };
}
