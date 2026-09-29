import { eventDatabasePool } from '../../../../../server/events/database';
import { createQuotaHistoryHandlers } from '../../../../../server/quota/history-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return createQuotaHistoryHandlers(eventDatabasePool()).admin(request, context);
}
