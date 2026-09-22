import { expect, test } from '@playwright/test';
import { loginAsTestAdmin, postTestDeviceEvent } from './helpers';

test('applies event invalidations, shows an offline device, and fits a 390px viewport', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsTestAdmin(page);

  let dashboardReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/dashboard' && request.method() === 'GET') dashboardReads += 1;
  });
  await page.goto('/');
  const streamStatus = page.getByLabel('实时流状态');
  await expect(streamStatus).toHaveText('实时流已连接');
  await expect.poll(() => dashboardReads).toBe(1);
  await expect(page.getByText('离线', { exact: true })).toBeVisible();

  await postTestDeviceEvent(request, 'turn.started', 'Streamed session');
  await expect(page.getByRole('heading', { name: 'Streamed session' })).toBeVisible();
  await expect.poll(() => dashboardReads).toBe(2);

  await postTestDeviceEvent(request, 'approval.requested', 'Approval update');
  await expect(page.getByRole('heading', { name: 'Approval update' })).toBeVisible();
  await expect(page.getByText('待审批', { exact: true }).first()).toBeVisible();
  await expect.poll(() => dashboardReads).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('link', { name: '设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设备接入' })).toBeVisible();
  await expect(page.getByText('npm run device:create -- "设备名称"')).toBeVisible();
  await expect(page.getByText(/安装采集器之前的会话无法回填/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('redirects unauthenticated dashboard visitors to login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Codex 状态面板' })).toBeVisible();
});
