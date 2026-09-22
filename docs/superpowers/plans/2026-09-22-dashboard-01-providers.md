# Provider Quota Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可扩展策略模式，在远程服务器可靠获取并保存 Codex、DeepSeek、Kimi Code 数据。

**Architecture:** Next.js 项目共享纯 TypeScript Provider 契约；独立 worker 调用 Registry 中的策略，通过 PostgreSQL 账号锁和持久刷新请求协调任务。真实授权先验证，解析器使用脱敏样本测试。

**Tech Stack:** Next.js 16.3.5、Node.js 24 LTS、TypeScript、Zod、pg、Vitest、tsx、tsup。

**Spec:** [设计](../specs/2026-09-22-codex-status-dashboard-design.md) §3、§5、§7；[执行索引](2026-09-22-codex-status-dashboard.md)。

## Global Constraints

- Provider 额度由远程服务自行获取；设备端不查询、不转发额度。
- Provider 查询采用策略接口和独立实现，新增 Provider 不修改刷新调度器、存储服务或通用展示组件。
- 凭据留在服务器，设备仅持有自己的上报凭证。
- 默认每个账号 5 分钟刷新一次，加入随机抖动；手动刷新最短间隔 30 秒。
- HTTP 查询默认 15 秒超时，辅助运行时查询默认 30 秒。
- 额度历史保留 90 天；最新成功快照独立保留。

## Review Focus

1. 撤销/过期授权不能反复自动重试：T2/T4。
2. 零余额、货币和小数精度不能丢失：T3。
3. 空额度桶、缺失窗口不是零用量：T3。
4. 同账号并发刷新与 worker 崩溃不覆盖快照：T4。
5. 凭据路径逃逸、上游响应错误不能进入日志/UI：T1/T2/T4。

所有路径相对实现根目录。测试代码省略的只有重复 import；接口、样本输入及期望输出以下文为准。

### Task 1: Engineering Foundation, Contracts, and Registry

**Files:** 新建 `package.json`、`tsconfig.json`、`next.config.ts`、`vitest.config.ts`、`vitest.integration.config.ts`、`.gitignore`、`src/app/layout.tsx`、`src/app/page.tsx`、`src/contracts/quota.ts`、`src/server/providers/registry.ts`、`tests/unit/provider-registry.test.ts`。

**Interfaces:** `src/contracts/quota.ts` 导出设计 §3.2 全部类型；`ProviderRegistry.register(strategy): void`、`ProviderRegistry.get(id): QuotaProviderStrategy`、`ProviderRegistry.list(): readonly QuotaProviderStrategy[]`。构造函数不自动注册，组合根显式注册，重复和未知 ID 抛安全配置错误。

- [ ] **Step 1：创建独立仓库与最小测试环境。** 使用 Node 24；`npm init -y` 后 `npm install --save-exact next@16.3.5 react react-dom pg zod`，开发依赖安装 TypeScript、types、Vitest、tsx、tsup、Playwright、Testing Library、jsdom；记录 lockfile。按索引定义 scripts；拷入设计/计划。

```ts
// next.config.ts
import type { NextConfig } from 'next';
export default { output: 'standalone', poweredByHeader: false } satisfies NextConfig;
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit/**/*.test.{ts,tsx}'] } });
```

`tsconfig` 使用 strict、ES2022、bundler moduleResolution、jsx preserve，include src/collector/scripts/tests。`.gitignore` 包括 `.env*`（排除 `.env.example`）、`secrets/`、`runtime/`、`*.sqlite*`、node_modules、.next、dist-*、测试报告；不忽略 migrations。

- [ ] **Step 2：先写 Registry 契约测试。**

```ts
import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/server/providers/registry';
import type { QuotaProviderStrategy } from '../../src/contracts/quota';
const fake: QuotaProviderStrategy = {
  id: 'test-provider', capabilities: { metricKinds: ['balance'], authModes: ['api-key'] },
  validateConfig: () => [],
  fetchSnapshot: async c => ({ ok: true, snapshot: {
    accountId: c.id, providerId: c.providerId, observedAt: '2026-09-22T00:00:00Z',
    serviceAvailable: true, metrics: [] } }),
};
describe('registry', () => {
  it('accepts a new strategy without dispatch changes', () => {
    const registry = new ProviderRegistry(); registry.register(fake);
    expect(registry.get('test-provider')).toBe(fake);
    expect(() => registry.register(fake)).toThrow('DUPLICATE_PROVIDER');
    expect(() => registry.get('missing')).toThrow('UNKNOWN_PROVIDER');
  });
});
```

- [ ] **Step 3：运行** `npm test -- tests/unit/provider-registry.test.ts`，确认失败原因是缺少实现。
- [ ] **Step 4：实现契约和 Map Registry。**

```ts
import type { QuotaProviderStrategy } from '../../contracts/quota';
export class ProviderRegistry {
  private readonly strategies = new Map<string, QuotaProviderStrategy>();
  register(strategy: QuotaProviderStrategy): void {
    if (this.strategies.has(strategy.id)) throw new Error('DUPLICATE_PROVIDER');
    this.strategies.set(strategy.id, strategy);
  }
  get(id: string): QuotaProviderStrategy {
    const strategy = this.strategies.get(id);
    if (!strategy) throw new Error('UNKNOWN_PROVIDER');
    return strategy;
  }
  list(): readonly QuotaProviderStrategy[] { return [...this.strategies.values()]; }
}
```

Next 初始页面只显示“尚未接入数据”，不填假数据；布局使用本地系统字体。领域模块不能 import Next 或浏览器组件；仅 Next 的组合根使用 `server-only`。

- [ ] **Step 5：运行** 定向测试、`npm run typecheck`、`npx next build`；通过后精确暂存上述文件及 lockfile，提交 `feat: establish provider contracts and Next.js project`。

### Task 2: Server Authorization, Transports, and Secret Boundaries

**Files:** 新建 `src/server/providers/secret-store.ts`、`http.ts`、`codex/rpc.ts`、`kimi-code/client.ts`、`docs/provider-verification.md`、`tests/unit/provider-transports.test.ts`、`tests/fixtures/providers/`。

**Interfaces:** `FileSecretStore(root).read(ref): Promise<string>`；仅 ref 的相对文件名，realpath 必须仍在 root 内。`requestJson(url, {signal, headers, timeoutMs}): Promise<unknown>` 禁止重定向并限制响应 1 MB；失败抛 `ProviderTransportError`，仅携带设计中的 code/retryAfterSeconds。`CodexRpc(home).readRateLimits(signal): Promise<unknown>` 管理一个 home 对应的 stdio 子进程；`KimiUsageClient(baseUrl, token).readUsage(signal): Promise<unknown>`。

- [ ] **Step 1：编写传输失败与敏感路径测试。**

```ts
import { it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '../../src/server/providers/secret-store';
it('refuses symlink escape and path traversal', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'quota-secrets-'));
  const root = await mkdtemp(join(parent, 'root-'));
  await writeFile(join(parent, 'outside'), 'do-not-return');
  await symlink(join(parent, 'outside'), join(root, 'escape'));
  const store = new FileSecretStore(root);
  await expect(store.read('../outside')).rejects.toThrow('INVALID_SECRET_REF');
  await expect(store.read('escape')).rejects.toThrow('INVALID_SECRET_REF');
});
```

另外用本地 `node:http` 服务返回 401/403/429、302、超过 1 MB 数据、延迟响应；断言分别为 AUTH_EXPIRED/FORBIDDEN/RATE_LIMITED、重定向拒绝、SCHEMA_CHANGED、TIMEOUT，且错误对象序列化不含响应中注入的 `SECRET_CANARY`。429 测试 delta 秒和 HTTP 日期两种 Retry-After。

- [ ] **Step 2：运行** `npm test -- tests/unit/provider-transports.test.ts`，先确认红灯。
- [ ] **Step 3：实现传输。** `requestJson` 使用 `fetch` 的 `redirect:'error'`、组合 AbortSignal、流读取字节上限；HTTP 非 2xx 在解析 JSON 前归类，错误不保留 raw body。

```ts
const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
const response = await fetch(url, {
  headers: options.headers, signal, redirect: 'error', cache: 'no-store',
});
```

Codex 使用 child_process.spawn 的参数数组，禁止 shell；独立 CODEX_HOME 目录，不复用开发机账号目录。实现 JSON-RPC initialize/initialized 握手、唯一请求 ID、`account/rateLimits/read` 响应匹配、通知忽略、stdin/stdout framing、30 秒超时及进程退出拒绝所有 pending 请求；stderr 不原样日志输出。从实际安装版本生成协议 schema 并记录到验证文档，mock 子进程覆盖响应乱序、退出和超时。

Kimi 只允许部署配置中的回环地址，附 bearer token，请求 `/api/v1/oauth/usage`；检查 HTTP 和 JSON envelope 的 `code` 及 `data.kind`，HTTP 200 内的上游错误也要失败。Kimi 登录及运行时配置分别以权限 0700 目录持久化。

- [ ] **Step 4：验证 CLI 与记录远程探测。** 记录本地可用 CLI 版本和帮助输出；将 `/user/balance`、Codex JSON-RPC schema、Kimi Code server usage 契约与回环鉴权要求写入 `docs/provider-verification.md`。真实远程服务器探测由 Task 3 的统一策略 probe 在部署授权后执行；不读取开发机凭据，不在聊天粘贴 token。

具备目标 Linux 服务器和受支持授权后执行：

```sh
npm run providers:probe -- --provider deepseek
npm run providers:probe -- --provider codex
npm run providers:probe -- --provider kimi-code
```

策略探测参数 provider 仅允许这三个固定值；通过统一策略、只读账号配置和 secret store 查询。还要重启运行时后再次查询，记录授权是否恢复、续期方式及服务端独立查询证据。将脱敏结构手工生成合成 fixtures，不保存真实标识符。缺少服务器/授权就记录 NOT_RUN 和具体需要的输入，不写“通过”；不阻塞无关模块开发。

- [ ] **Step 5：运行传输测试与 typecheck；提交** `feat: add server-side provider transports`。只有三家真实验证完成，才能将本阶段标记为 live-ready。

### Task 3: Provider Strategies and Metric Normalization

**Files:** 新建 `src/server/providers/codex/strategy.ts`、`deepseek/strategy.ts`、`kimi-code/strategy.ts`、`src/server/providers/metric-schema.ts`、`tests/unit/provider-strategies.test.ts`。

**Interfaces:** 每个策略实现 `QuotaProviderStrategy`；分别导出 `normalizeCodex(raw, accountId, observedAt): ProviderSnapshot`、`normalizeDeepSeek(...)`、`normalizeKimiCode(...)`。构造函数接收传输而非直接读取全局环境，normalize 是纯函数。响应变化抛安全 `SCHEMA_CHANGED`，fetchSnapshot 将异常转换为 ProviderFetchResult。

- [ ] **Step 1：先写以下断言，并参数化覆盖所有真实验证样本。**

```ts
import { it, expect } from 'vitest';
import { normalizeDeepSeek } from '../../src/server/providers/deepseek/strategy';
import { normalizeCodex } from '../../src/server/providers/codex/strategy';
import { normalizeKimiCode } from '../../src/server/providers/kimi-code/strategy';
const at = '2026-09-22T00:00:00Z';
it('keeps zero balances and currency precision', () => {
  const s = normalizeDeepSeek({ is_available: false, balance_infos: [
    { currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0.00' },
    { currency: 'USD', total_balance: '1.123456', granted_balance: '0', topped_up_balance: '1.123456' },
  ] }, 'a', at);
  expect(s.serviceAvailable).toBe(false);
  expect(s.metrics).toMatchObject([{ currency: 'CNY', total: '0.00' }, { currency: 'USD', total: '1.123456' }]);
});
it('keeps dynamic Codex buckets and omits absent windows', () => {
  const s = normalizeCodex({ rateLimitsByLimitId: { test: {
    limitId: 'test', primary: { usedPercent: 12.5, windowDurationMins: 60, resetsAt: 1790038800 }, secondary: null,
  } } }, 'a', at);
  expect(s.metrics).toMatchObject([{ key: 'test:primary', usedPercent: 12.5, windowDurationSeconds: 3600 }]);
  expect(s.metrics).toHaveLength(1);
});
it('converts Kimi ratio without inventing a fixed window', () => {
  const s = normalizeKimiCode({ code: 0, data: { kind: 'ok', quota: {
    usages: { monthCode: { usedRatio: 0.125 } }, extraUsage: null,
  } } }, 'a', at);
  expect(s.metrics).toMatchObject([{ key: 'monthCode', usedPercent: 12.5, resetsAt: null }]);
});
```

- [ ] **Step 2：运行** `npm test -- tests/unit/provider-strategies.test.ts`，确认红灯。
- [ ] **Step 3：实现标准化。** 基于 Zod 校验，不将 null 强转为 0；百分比必须有限且在 0..100，比例 0..1；重置时间必须合法。未知字段忽略，缺少必要根结构报 SCHEMA_CHANGED；已知成功结构里没有额度可返回空 metrics。

```ts
const decimalAmount = z.string().regex(/^-?\d+(\.\d+)?$/);
const usedPercent = z.number().finite().min(0).max(100);
const usedRatio = z.number().finite().min(0).max(1);
```

Codex 多 bucket 字段存在时为权威，只有字段缺失时才回退单 bucket；缺失 limitId 的旧结果使用固定 `codex`。Kimi 按窗口键生成指标，月度窗口不伪造固定秒数；extraUsage 的整数 cents 用 BigInt 除法转换十进制字符串并验证币种，负值保留来源语义、不钳成零。DeepSeek 每种币种保留独立指标，不汇总。

- [ ] **Step 4：补充并运行异常样本。** NaN/Infinity（直接传对象）、越界 ratio、空数组、缺失窗口、旧单 bucket、Kimi `kind:error`、未知 schema、AUTH_EXPIRED、429 均需有断言。策略 capabilities 和 config.options 以 Zod 校验（未知 options 拒绝），返回配置问题而不是网络查询。
- [ ] **Step 5：通过定向测试与 typecheck 后提交** `feat: implement Codex DeepSeek and Kimi quota strategies`。

### Task 4: Persistent Refresh, Account Locks, and Worker

**Files:** 新建 `migrations/001-quota.sql`、`src/server/db/pool.ts`、`src/server/quota/repository.ts`、`refresh.ts`、`requests.ts`、`src/server/providers/bootstrap.ts`、`src/worker/main.ts`、`scripts/migrate.ts`、`tests/integration/quota-refresh.test.ts`。

**Interfaces:** `requestRefresh(accountId, now): Promise<'queued'|'cooldown'|'running'>`；`runAccountRefresh(accountId, deps): Promise<'success'|'failed'|'locked'|'not-due'>`；`QuotaRepository.readLatest(accountId)` 返回 `{snapshot: ProviderSnapshot|null,lastAttemptAt,lastSuccessAt,errorCode,nextAttemptAt}`（后四个为可空 ISO 字符串，errorCode 为 ProviderFailure.code）；`makeProviderRegistry()` 注册三个策略；`runWorker(signal): Promise<void>`。

- [ ] **Step 1：建测试库和集成测试夹具。** `withTestDb`（`tests/support/database.ts`）通过独立 schema 初始化 SQL，回调结束 drop schema；只允许库名以 `_test` 结尾，不打印 URL。测试用 pg PoolClient，不 mock 事务。

```ts
it('only one worker owns an account and preserves successful data on failure', async () => {
  await withTestDb(async db => {
    await db.seedAccount('a', 'fake'); // support helper inserts config without a secret
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const strategy = fakeStrategy(async () => {
      calls++; started.resolve(); await finish.promise;
      return successSnapshot('a');
    });
    const deps = db.refreshDeps(strategy);
    const first = runAccountRefresh('a', deps);
    await started.promise;
    expect(await runAccountRefresh('a', deps)).toBe('locked');
    finish.resolve(); await first;
    expect(calls).toBe(1);
    await db.requestDue('a');
    await runAccountRefresh('a', db.refreshDeps(fakeStrategy(async () => ({ ok: false, error: { code: 'TIMEOUT' } }))));
    expect((await db.readLatest('a')).snapshot).not.toBeNull();
    expect((await db.readLatest('a')).errorCode).toBe('TIMEOUT');
  });
});
```

support helpers：`fakeStrategy(fetchFn)` 返回 id=fake 的策略；`successSnapshot(id)` 返回空 metrics 的成功快照；`seedAccount`、`requestDue`、`readLatest`、`refreshDeps` 包装本任务 repository 与注入时钟，不自建一套持久化逻辑。

- [ ] **Step 2：运行** `npm run test:integration -- tests/integration/quota-refresh.test.ts`，确认尚无实现而失败。
- [ ] **Step 3：建 SQL 和刷新事务。**

```sql
CREATE TABLE provider_accounts (
  id text PRIMARY KEY, provider_id text NOT NULL, label text NOT NULL,
  credential_ref text NOT NULL, options jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE quota_refresh_status (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id), last_attempt_at timestamptz,
  last_success_at timestamptz, error_code text, next_attempt_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0, manual_requested_at timestamptz,
  last_manual_at timestamptz, auth_blocked boolean NOT NULL DEFAULT false
);
CREATE TABLE quota_latest (
  account_id text PRIMARY KEY REFERENCES provider_accounts(id), snapshot jsonb NOT NULL
);
CREATE TABLE quota_snapshots (
  id bigserial PRIMARY KEY, account_id text NOT NULL REFERENCES provider_accounts(id),
  observed_at timestamptz NOT NULL, snapshot jsonb NOT NULL
);
CREATE INDEX quota_history_age ON quota_snapshots(observed_at);
```

每次刷新独占 PoolClient；`pg_try_advisory_lock(hashtextextended(account_id, 0))` 串行化同账号，持有该连接直到 finally 解锁（连接断开自动释放）；网络请求不持有数据库事务。获取锁后再次判断 enabled、auth_blocked、due/manual，避免已完成的并发请求重复查询。开始时记录 lastAttempt；成功时单事务写 latest/history/status 并 `pg_notify('dashboard_changed','quota')`；失败只写状态不覆盖快照。连接损坏时销毁 client 不放回池。

成功间隔 300 秒加 0..30 秒抖动；失败从 30 秒指数退避至 1800 秒，Retry-After 可延后但不提前。AUTH_REQUIRED/AUTH_EXPIRED/FORBIDDEN 阻止自动刷新；管理员修复授权后通过手动刷新清除阻止并重试。手动请求按账号行锁检查 30 秒冷却，仅设置 manual_requested_at；worker 成功或失败后仅清除此轮领取前的请求，保留运行中产生的新请求。

- [ ] **Step 4：实现 worker 与配置装载。**

```ts
// src/worker/main.ts: 实际入口包装 main，import 时不启动
async function main() {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  await runWorker(controller.signal);
}
```

worker 每 1 秒查询额度到期/手动请求（不是设备执行状态轮询），最多并发 3 个账号。重启自动恢复 due 工作；停机取消网络请求、回收子进程与 DB 连接。配置启动时只读导入账号，删除配置对应 enabled=false，不删除历史。每日清理额度历史 90 天之前数据。迁移脚本使用事务、schema_migrations 和迁移锁；失败整体回滚。

- [ ] **Step 5：扩展真实 PostgreSQL 测试并提交。** 模拟杀死持锁连接后可重试、同账号关联两设备仍仅刷新一次、手动冷却、授权暂停/恢复、Retry-After、大量失败、历史清理不删 latest；确认日志无 SECRET_CANARY。通过 unit/integration/typecheck；提交 `feat: persist and schedule server quota refreshes`。阶段验收可用 SQL 查看真实快照，Web 不在本阶段伪装已完成。
