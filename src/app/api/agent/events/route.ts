import { eventDatabasePool } from '../../../../server/events/database';
import { createAgentHandlers } from '../../../../server/events/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return createAgentHandlers(eventDatabasePool()).events(request);
}
