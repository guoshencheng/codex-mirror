import { expect, test } from '@playwright/test';
import { TEST_ADMIN_PASSWORD, loginAsTestAdmin } from './helpers';

test('shows stored quota history with range switching and responsive detail layout', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsTestAdmin(page);
  await page.goto('/');
  await page.getByRole('button', { name: '查看 E2E 历史账号 额度详情' }).click();
  await expect(page.getByRole('heading', { name: '额度历史' })).toBeVisible();
  await expect(page.getByRole('button', { name: '24 小时' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: '额度窗口历史折线图' })).toBeVisible();
  await page.getByRole('button', { name: '90 天' }).click();
  await expect(page.getByText('采样趋势')).toBeVisible();
  await expect(page.getByRole('button', { name: '90 天' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
  await page.getByRole('button', { name: '返回面板' }).click();
  await expect(page.getByRole('list', { name: 'Provider 额度' })).toBeVisible();
});

test('standalone display reads quota history with its configured token and API origin', async ({ page, baseURL }) => {
  test.setTimeout(45_000);
  await page.addInitScript(({ apiOrigin }) => {
    localStorage.setItem('display-api-origin', apiOrigin);
  }, { apiOrigin: baseURL! });
  await page.goto(`http://127.0.0.1:${process.env.E2E_DISPLAY_PORT ?? '3120'}/display/#token=${TEST_ADMIN_PASSWORD}`);
  await expect(page.getByRole('button', { name: '查看 E2E 历史账号 额度详情' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '查看 E2E 历史账号 额度详情' }).click();
  await expect(page.getByRole('heading', { name: '额度历史' })).toBeVisible();
  await expect(page.getByRole('img', { name: '额度窗口历史折线图' })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新额度' })).toHaveCount(0);
});
