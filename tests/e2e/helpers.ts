import type { Page } from '@playwright/test';

export const TEST_ADMIN_USERNAME = 'owner@example.test';
export const TEST_ADMIN_PASSWORD = 'cdu_' + 'a'.repeat(43);

export async function loginAsTestAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户 Token').fill(TEST_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('/');
}
