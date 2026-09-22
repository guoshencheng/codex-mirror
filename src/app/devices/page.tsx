import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import DeviceList from '../../components/device-list';
import { requireAdmin } from '../../server/auth/session';
import { getDashboard } from '../../server/read-model/dashboard';

export const dynamic = 'force-dynamic';

async function requestFromCookies(): Promise<Request> {
  const cookieHeader = (await cookies()).getAll().map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  return new Request('http://dashboard.internal/', { headers: { cookie: cookieHeader } });
}

export default async function DevicesPage() {
  const admin = await requireAdmin(await requestFromCookies());
  if (!admin) redirect('/login');

  const dashboard = await getDashboard();
  const hasIncompleteStream = dashboard.devices.some(device => device.streamIncomplete);
  const configExample = [
    '~/.config/codex-status-dashboard/config.json',
    '{',
    '  "schemaVersion": 1,',
    '  "deviceId": "命令输出的设备 ID",',
    '  "deviceToken": "命令输出的一次性令牌",',
    '  "serverUrl": "https://你的面板域名",',
    '  "queuePath": "./events.sqlite"',
    '}',
  ].join('\n');
  const installCommands = [
    'npm ci',
    'npm run collector:build',
    'node dist/collector/cli.js install --dry-run',
    'node dist/collector/cli.js install',
    'node dist/collector/cli.js run',
  ].join('\n');

  return <main className="ds-app">
    <header className="ds-topbar">
      <Link className="ds-topbar__brand" href="/">Codex 状态面板</Link>
      <nav className="ds-topbar__nav" aria-label="主导航">
        <Link href="/">状态面板</Link>
        <Link href="/devices" aria-current="page">设备</Link>
      </nav>
    </header>

    <header className="ds-page-header">
      <div>
        <span className="ds-page-header__context">采集端管理</span>
        <h1 className="ds-page-header__title">设备接入</h1>
        <p className="ds-page-header__description">每台运行 Codex 的设备安装一次本地 Hook 采集器，再通过 HTTPS 上报事件。</p>
      </div>
      <Link className="ds-btn" href="/">返回状态面板</Link>
    </header>

    <div className="ds-content-grid">
      <section className="ds-panel ds-stack" aria-labelledby="create-device-heading">
        <h2 className="ds-panel-title" id="create-device-heading">创建一次性设备令牌</h2>
        <p>在能访问部署数据库的运维终端中执行；请让 DATABASE_DIRECT_URL 指向此面板使用的数据库。</p>
        <pre className="ds-card"><code>npm run device:create -- &quot;设备名称&quot;</code></pre>
        <p>命令只显示一次设备令牌。将它安全地写入该设备的配置文件；面板不会再次显示或保存明文令牌。</p>
        <pre className="ds-card"><code>{configExample}</code></pre>
      </section>

      <section className="ds-panel ds-stack" aria-labelledby="install-heading">
        <h2 className="ds-panel-title" id="install-heading">安装 Codex Hooks</h2>
        <p>在设备上安装 Node.js 24 或更高版本，并在采集器项目目录运行：</p>
        <pre className="ds-card"><code>{installCommands}</code></pre>
        <p>先检查 dry-run 输出，再安装 Hook。配置文件权限应为 0600；设备令牌不要写入 shell 历史或 Git。</p>
      </section>
    </div>

    <section className="ds-panel ds-stack" aria-labelledby="device-health-heading">
      <div>
        <h2 className="ds-panel-title" id="device-health-heading">连接状态</h2>
        <p className="ds-meta">最近心跳用于判断设备在线情况；事件流缺口会降低会话状态可信度。</p>
      </div>
      {hasIncompleteStream
        ? <p className="ds-notice">至少一台设备报告事件丢失或事件流缺口。缺失的事件无法从面板恢复，请检查设备采集器本地队列。</p>
        : null}
      <DeviceList devices={dashboard.devices} />
      <p className="ds-notice">安装采集器之前的会话无法回填。面板只会从安装完成后收到的 Hook 事件开始记录。</p>
    </section>
  </main>;
}
