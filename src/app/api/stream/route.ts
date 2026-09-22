import { eventDatabasePool } from '../../../server/events/database';
import { createDashboardHandlers } from '../../../server/read-model/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return createDashboardHandlers(eventDatabasePool()).stream(request);
}
