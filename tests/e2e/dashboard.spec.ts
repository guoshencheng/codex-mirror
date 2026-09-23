import { expect, test } from '@playwright/test';
import { loginAsTestAdmin, postTestDeviceEvent } from './helpers';

test('applies reported events on the next dashboard poll, shows an offline device, and fits a 390px viewport', async ({ page, request }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsTestAdmin(page);

  let dashboardReads = 0;
  let streamReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/dashboard' && request.method() === 'GET') dashboardReads += 1;
    if (new URL(request.url()).pathname === '/api/stream') streamReads += 1;
  });
  await page.goto('/');
  const syncStatus = page.getByLabel('面板同步状态');
  await expect(syncStatus).toHaveText('同步正常');
  await expect.poll(() => dashboardReads).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '查看设备状态' })).toContainText('1 未在线');

  let lastDashboardRead = dashboardReads;
  await postTestDeviceEvent(request, 'turn.started', 'Streamed session');
  await expect(page.getByRole('heading', { name: 'Streamed session' })).toBeVisible({ timeout: 12_000 });
  await expect.poll(() => dashboardReads, { timeout: 1_000 }).toBeGreaterThan(lastDashboardRead);
  lastDashboardRead = dashboardReads;

  await postTestDeviceEvent(request, 'approval.requested', 'Approval update');
  await expect(page.getByRole('heading', { name: 'Approval update' })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('最近：待审批', { exact: true })).toBeVisible();
  await expect.poll(() => dashboardReads, { timeout: 1_000 }).toBeGreaterThan(lastDashboardRead);
  expect(streamReads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: '面板菜单' }).click();
  await page.getByRole('link', { name: '设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设备接入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成一次性安装命令' })).toBeVisible();
  await expect(page.getByText(/15 分钟有效、只能注册一台设备/)).toBeVisible();
  await page.getByRole('button', { name: '生成一次性安装命令' }).click();
  const command = await page.getByRole('code').textContent();
  const installUrl = command?.match(/^curl -fsSL '([^']+)' \| bash$/)?.[1];
  expect(installUrl).toBeTruthy();
  const parsedInstallUrl = new URL(installUrl!);
  expect(parsedInstallUrl.pathname).toBe('/api/collector/install');
  expect(parsedInstallUrl.searchParams.get('grant')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const installerResponse = await request.get(parsedInstallUrl.toString());
  expect(installerResponse.status()).toBe(200);
  expect(await installerResponse.text()).toContain('COLLECTOR_ENROLLMENT_GRANT=');
  await expect(page.getByText(/安装采集器之前的会话无法回填/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('redirects unauthenticated dashboard visitors to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Codex 状态面板' })).toBeVisible();
});

test('starts Codex device login from the account view', async ({ page }) => {
  await loginAsTestAdmin(page);
  const id = '11111111-1111-4111-8111-111111111111';
  await page.route('**/api/provider-accounts/codex-login', route => route.fulfill({
    status: 202, contentType: 'application/json', body: JSON.stringify({ id, status: 'queued' }),
  }));
  await page.route('**/api/provider-accounts/codex-login/*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ id, status: 'awaiting',
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '面板菜单' }).click();
  await page.getByRole('button', { name: '添加账号' }).click();
  await page.getByRole('button', { name: '登录 Codex' }).click();
  await page.getByLabel('账号名称').fill('Codex Personal');
  await page.getByRole('button', { name: '开始 Codex 登录' }).click();
  await expect(page.getByText('ABCD-1234')).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAI 授权页面' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  await expect(page.getByText('等待 ChatGPT 登录完成…')).toBeVisible();
});
