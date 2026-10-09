import { expect, test } from '@playwright/test';
import { loginAsTestAdmin } from './helpers';

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
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Codex 登录' }).click();
  await page.getByLabel('账号名称').fill('Codex Personal');
  await page.getByRole('button', { name: '开始 Codex 登录' }).click();
  await expect(page.getByText('ABCD-1234')).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAI 授权页面' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  await expect(page.getByText('等待 ChatGPT 登录完成…')).toBeVisible();
});
