import { applicationDatabasePool } from '../../../../../server/db/application-pool';
import { createDashboardHandlers } from '../../../../../server/read-model/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return createDashboardHandlers(applicationDatabasePool()).refresh(request, context);
}
