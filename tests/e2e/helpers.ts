import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';

export const TEST_ADMIN_USERNAME = 'owner@example.test';
export const TEST_ADMIN_PASSWORD = 'correct horse battery staple 7';

interface E2EFixture {
  deviceId: string;
  deviceToken: string;
  epoch: string;
}

let fixturePromise: Promise<E2EFixture> | undefined;
let eventSequence = 0;

function fixture(): Promise<E2EFixture> {
  fixturePromise ??= (async () => {
    const path = process.env.E2E_FIXTURE_FILE;
    if (!path) throw new Error('E2E_FIXTURE_FILE_REQUIRED');
    return JSON.parse(await readFile(path, 'utf8')) as E2EFixture;
  })();
  return fixturePromise;
}

export async function loginAsTestAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('管理员账号').fill(TEST_ADMIN_USERNAME);
  await page.getByLabel('密码').fill(TEST_ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('/');
}

export async function postTestDeviceEvent(
  request: APIRequestContext,
  type: 'turn.started' | 'approval.requested',
  title: string,
): Promise<void> {
  const { deviceId, deviceToken, epoch } = await fixture();
  eventSequence += 1;
  const response = await request.post('/api/agent/events', {
    headers: { authorization: `Bearer ${deviceToken}` },
    data: {
      epoch,
      events: [{
        schemaVersion: 1,
        eventId: randomUUID(),
        deviceId,
        collectorEpoch: epoch,
        sequence: eventSequence,
        sessionId: 'playwright-session',
        turnId: 'playwright-turn',
        type,
        occurredAt: new Date().toISOString(),
        metadata: { title, projectKey: 'playwright-project', projectName: 'Playwright project' },
      }],
    },
  });
  if (!response.ok()) throw new Error(`TEST_EVENT_REJECTED_${response.status()}`);
}
