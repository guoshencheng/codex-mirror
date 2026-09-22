import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Dashboard from '../components/dashboard';
import { requireAdmin } from '../server/auth/session';
import { getDashboard } from '../server/read-model/dashboard';

export const dynamic = 'force-dynamic';

async function requestFromCookies(): Promise<Request> {
  const cookieHeader = (await cookies()).getAll().map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  return new Request('http://dashboard.internal/', { headers: { cookie: cookieHeader } });
}

export default async function HomePage() {
  if (process.env.VERCEL_ENV === 'preview') redirect('/demo');
  const admin = await requireAdmin(await requestFromCookies());
  if (!admin) redirect('/login');

  const dashboard = await getDashboard();
  return <Dashboard initial={dashboard} />;
}
