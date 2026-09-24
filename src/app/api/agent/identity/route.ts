import { eventDatabasePool } from '../../../../server/events/database';
import { createAgentHandlers } from '../../../../server/events/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createAgentHandlers(eventDatabasePool()).identity(request);
}
