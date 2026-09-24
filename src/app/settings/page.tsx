import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import SettingsPanel from '../../components/settings-panel';
import { requireAdmin } from '../../server/auth/session';
import { getDashboard } from '../../server/read-model/dashboard';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const cookieHeader = (await cookies()).getAll().map(cookie => cookie.name + '=' + cookie.value).join('; ');
  const admin = await requireAdmin(new Request('http://dashboard.internal/settings', { headers: { cookie: cookieHeader } }));
  if (!admin) redirect('/login');
  const { tab } = await searchParams;
  return <SettingsPanel initial={await getDashboard()} initialTab={tab === 'devices' || tab === 'display' ? tab : 'accounts'} />;
}
