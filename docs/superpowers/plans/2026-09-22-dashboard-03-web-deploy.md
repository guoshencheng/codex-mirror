# Next.js Dashboard and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付登录保护、实时更新的远程 Web 面板及可恢复部署。

**Architecture:** Next.js App Router 部署到 Vercel，提供 Web、事件接收、管理员 API 与 SSE。托管 PostgreSQL 保存业务数据。额度 worker 与 Codex/Kimi 持久授权运行在独立远程 Provider Runtime；它共享 PostgreSQL，Vercel Functions 不运行常驻进程。

**Tech Stack:** Next.js 16.3.5、React、TypeScript、pg、Playwright、Vitest、Vercel、托管 PostgreSQL、Docker Compose（Provider Runtime only）。

**Spec:** [设计](../specs/2026-09-22-codex-status-dashboard-design.md) §5–8；[执行索引](2026-09-22-codex-status-dashboard.md)。前置 P1/P2。

## Global Constraints

- 所有对外业务 HTTP 接口由 Next.js 提供，不额外引入 Fastify。
- Provider 额度由远程服务自行获取；设备端不查询、不转发额度。
- 凭据留在服务器，设备仅持有自己的上报凭证。
- Web 与服务端同源；Vercel Functions 可水平扩展，无需 Redis。
- 首期个人统一看板，不包含团队租户与角色权限。
- 单管理员登录、服务端会话 cookie（Secure、HttpOnly、SameSite）及写操作 CSRF 防护。

## Review Focus

1. 未登录/设备 token/退出后的 SSE 不可读敏感数据：T1/T2。
2. 断线、通知丢失、数据库连接重建仍恢复全量真值：T2。
3. 前端缓存跨账号泄露、冻结的新鲜度标签：T2/T3。
4. 缺失额度与零额度、多币种、多设备同账号：T3。
5. Vercel 冷启动/扩容、Provider Runtime 重启、迁移失败与恢复备份不丢数据或重复刷新：T4。

### Task 1: Administrator Authentication and Sessions

**Files:** 新建 `migrations/003-admin.sql`、`src/server/auth/password.ts`、`session.ts`、`csrf.ts`、`rate-limit.ts`、`src/app/api/auth/login/route.ts`、`logout/route.ts`、`session/route.ts`、`src/app/login/page.tsx`、`scripts/create-admin.ts`、`tests/integration/admin-auth.test.ts`。

**Interfaces:** `hashPassword(password): Promise<string>`、`verifyPassword(password, hash): Promise<boolean>` 使用 node:crypto scrypt；`createAdminSession(adminId): Promise<{token:string,csrfToken:string,expiresAt:string}>`；`requireAdmin(request): Promise<{id:string,sessionId:string}|null>`；`verifyCsrf(request,sessionId): Promise<boolean>`。session token 仅 cookie，csrfToken 可通过登录成功 JSON 或 `/api/auth/session` 返回。

- [x] **Step 1：写真实 HTTP 登录/登出和权限测试。** 测试服务使用独立端口和测试库，无生产凭据；support `authHttp` 仅封装 fetch 与 cookie jar。

```ts
it('does not accept device tokens as an admin session', async () => {
  const token = await fixture.createDevice('device-a');
  const r = await fetch(`${fixture.baseUrl}/api/provider-accounts`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'manual',
  });
  expect(r.status).toBe(401);
});
it('rejects refresh without CSRF and destroys session on logout', async () => {
  const auth = await fixture.login();
  expect((await auth.post('/api/provider-accounts/a/refresh', {}, false)).status).toBe(403);
  expect((await auth.post('/api/auth/logout', {}, true)).status).toBe(204);
  expect((await auth.get('/api/auth/session')).status).toBe(401);
});
```

provider routes 在 T2 才可返回业务结果；T1 测试先覆盖 auth/session 和受保护的测试处理器，T2 将以上完整断言接到实际端点。fixture.login 使用测试管理员密码，只保存内存 cookie，返回 get/post helper；false 参数省略 CSRF，true 添加。

- [x] **Step 2：运行 auth 定向测试确认红灯；建立 admins、admin_sessions、login_attempts 表。** admins 单行约束，不提供注册；CLI 从隐藏终端输入密码（不使用命令行参数），随机盐 scrypt，密码至少 12 字符、UTF-8 字节上限 1024。会话 token 32 字节随机数、SHA-256 后入库，8 小时绝对有效期。CSRF 使用独立随机 token，hash 入库。
- [x] **Step 3：实现登录和 CSRF。**

```ts
const cookieOptions = {
  httpOnly: true, secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const, path: '/', maxAge: 8 * 60 * 60,
};
// 生产 cookie 名 __Host-dashboard_session；开发使用 dashboard_session
```

所有受保护的 route 每次执行 requireAdmin；页面在服务端同样检查，不依靠客户端隐藏。POST 验证 Origin 与部署固定 APP_ORIGIN 相等，再验证 CSRF；登录尚无会话，仅允许匹配 Origin 和 JSON Content-Type。登录失败统一 401，按源 IP+账号每 15 分钟最多 5 次；仅信任反向代理覆盖后的源地址，不信任公网任意 X-Forwarded-For。登出删除 DB session、清 cookie，通知 SSE 关闭对应会话。密码更新撤销所有会话。

- [x] **Step 4：运行正确/错误密码、枚举防护、速率限制、过期、Origin、退出测试并提交** `feat: secure dashboard with administrator sessions`。响应和 HTML 设置 no-store，密码与 cookie 不记录日志。

### Task 2: Read APIs, Manual Refresh, and SSE

**Files:** 新建 `src/contracts/dashboard.ts`、`src/server/read-model/dashboard.ts`、`src/server/db/notifications.ts`、`src/server/stream/sse.ts`、`src/app/api/devices/route.ts`、`sessions/route.ts`、`provider-accounts/route.ts`、`provider-accounts/[id]/refresh/route.ts`、`dashboard/route.ts`、`stream/route.ts`、`tests/integration/read-model.test.ts`、`tests/integration/sse.test.ts`。

**Interfaces:**

```ts
export interface DashboardDto {
  generatedAt: string;
  devices: Array<{ id: string; name: string; heartbeatAt: string|null;
    connection: 'online'|'stale'|'offline'; streamIncomplete: boolean }>;
  sessions: Array<{ id: string; deviceId: string; projectId: string|null;
    projectName: string|null; title: string; state: SessionState['state'];
    confidence: SessionState['confidence']; lastEventAt: string;
    lastReceivedAt: string; turnStartedAt: string|null; currentTool: string|null }>;
  accounts: Array<{ id: string; providerId: string; label: string;
    deviceIds: string[]; snapshot: ProviderSnapshot|null;
    lastAttemptAt: string|null; lastSuccessAt: string|null;
    errorCode: ProviderFailure['code']|null; refreshStatus: 'idle'|'queued'|'running'|'error' }>;
}
export function getDashboard(now: Date): Promise<DashboardDto>;
export function createAdminStream(request: Request, sessionId: string): Promise<Response>;
```

devices/sessions/provider-accounts API 分别返回 DTO 子集；dashboard 返回单一 repeatable-read 事务下的一致快照。对外 DTO 不含 credentialRef、options、token hash 或原始事件。

- [x] **Step 1：写泄露和重连测试。**

```ts
it('exposes one account linked to two devices without credentials', async () => {
  await fixture.seedAccountWithDevices('a', ['d1', 'd2'], 'SECRET_CANARY');
  const body = await fixture.adminJson('/api/dashboard');
  expect(body.accounts).toHaveLength(1);
  expect(body.accounts[0].deviceIds).toEqual(['d1', 'd2']);
  expect(JSON.stringify(body)).not.toContain('SECRET_CANARY');
  expect(body.accounts[0]).not.toHaveProperty('credentialRef');
});
it('sends sync on each connect and closes on logout', async () => {
  const stream = await fixture.openAdminStream();
  expect((await stream.next()).event).toBe('sync');
  await fixture.commitEvent();
  expect((await stream.nextData()).event).toBe('invalidate');
  await fixture.logout();
  await expect(stream.closed()).resolves.toBeUndefined();
  expect((await fixture.rawStreamRequest()).status).toBe(401);
});
```

fixture.openAdminStream 解析标准 SSE 行并忽略 comment keepalive；commitEvent 通过真实 ingest 接口写数据；closed 有 20 秒上限，不永久等待。重连测试断开 LISTEN 的专用连接后重建，断言收到新的 sync。

- [x] **Step 2：运行定向 integration 测试确认红灯。**
- [x] **Step 3：实现读模型与 refresh 路由。** Next Route Handlers 使用 runtime=nodejs、dynamic=force-dynamic，响应 Cache-Control: private,no-store。服务器页面直接调 getDashboard 不内网绕 API。手动刷新 requireAdmin+CSRF 后调用 P1 requestRefresh，queued/running=202、cooldown=429+Retry-After、未知账号=404。不在 handler 内 await Provider 查询、不调用 after。

动态路由参数按 Next.js 16 的异步 params 读取，账号 ID 经长度/字符约束后作为参数化 SQL 参数；数据库连接延迟到请求或 worker 启动时创建，不在模块 import 和 next build 时连接数据库。首页也使用 dynamic=force-dynamic，禁止构建时生成真实账号页面。

```ts
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const admin = await requireAdmin(request);
  if (!admin) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  if (!await verifyCsrf(request, admin.sessionId))
    return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
  const outcome = await requestRefresh(id, new Date());
  return Response.json({ status: outcome }, {
    status: outcome === 'cooldown' ? 429 : 202,
    headers: { 'Cache-Control': 'no-store', ...(outcome === 'cooldown' ? { 'Retry-After': '30' } : {}) },
  });
}
```

- [x] **Step 4：实现 SSE。** PostgreSQL 专用连接 LISTEN `dashboard_changed`，进程内 fan-out；payload 仅 topic。先注册订阅再发 sync，避免连接快照竞态；每 15 秒发送 comment keepalive 并复核 session 是否仍有效。收到 DB 重连信号再次 sync；客户端在连接建立、invalidate 或 sync 时拉全量 dashboard 并合并重叠刷新，不建立定时任务轮询。

```ts
return new Response(stream, { headers: {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'private, no-store, no-transform',
  'X-Accel-Buffering': 'no',
} });
// data 帧: event: invalidate\ndata: {"topic":"quota"}\n\n
```

ReadableStream cancel/request.signal abort 时移除 listener 和 timer。慢客户端最多积压一个 invalidate，超限关闭让其重连；每管理员最多 5 条连接。NOTIFY 不是持久日志，断线后必须全量拉取。保活重新校验仅查询管理员会话，不查询各端 Codex。页面本地计时器更新新鲜度，无需轮询设备。

- [x] **Step 5：运行权限、读模型和 SSE 集成测试并提交** `feat: serve live dashboard data through Next.js`。覆盖跨请求缓存不复用、通知先于数据 fetch、logout、session 到期、DB 断连、浏览器取消后资源回收。

### Task 3: Dashboard, Quota Cards, and Device Onboarding

**Files:** 修改 `src/app/page.tsx`；新建 `src/app/devices/page.tsx`、`src/components/dashboard.tsx`、`quota-card.tsx`、`metric-view.tsx`、`device-list.tsx`、`session-list.tsx`、`use-dashboard-stream.ts`、`src/app/globals.css`、`tests/unit/metric-view.test.tsx`、`tests/e2e/dashboard.spec.ts`、`playwright.config.ts`。

**Interfaces:** `MetricView({metric: QuotaMetric})`；`Dashboard({initial: DashboardDto})`；`useDashboardStream(initial): {data:DashboardDto,connected:boolean,refresh():Promise<void>}`。UI 分支只依据 metric.kind；Provider 名称由通用 label 数据显示，不为某个 Provider 硬编码窗口。

- [x] **Step 1：先写显示语义和扩展性测试。**

```tsx
it('renders a new provider balance without adding a provider branch', () => {
  render(<MetricView metric={{ kind: 'balance', key: 'new:CNY', label: '余额',
    currency: 'CNY', total: '0.00', granted: null, toppedUp: null }} />);
  expect(screen.getByText(/0.00/)).toBeVisible();
  expect(screen.getByText(/CNY/)).toBeVisible();
});
it('shows unknown usage rather than zero remaining', () => {
  render(<MetricView metric={{ kind: 'quota-window', key: 'x', label: '窗口',
    usedPercent: null, windowDurationSeconds: null, resetsAt: null }} />);
  expect(screen.getByText('额度数据不可用')).toBeVisible();
  expect(screen.queryByText('100%')).toBeNull();
});
```

Vitest 为本文件使用 jsdom，setup 引入 jest-dom；其余服务端测试保持 node。

- [x] **Step 2：运行 MetricView 测试确认红灯；实现通用指标。**

```tsx
function MetricView({ metric }: { metric: QuotaMetric }) {
  if (metric.kind === 'balance')
    return <p>{metric.label}：{metric.currency} {metric.total}</p>;
  return <p>{metric.label}：{metric.usedPercent === null
    ? '额度数据不可用' : `剩余 ${Math.max(0, Math.min(100, 100 - metric.usedPercent))}%`}</p>;
}
```

补充 progressbar 可访问标签、原始金额精度、赠送/充值明细、余额 `details` 明细、浏览器时区重置时间。未知时间显示“未提供”；空 metrics 显示“服务未提供额度”，fetch 失败显示安全错误文案和上次成功时间，保留旧指标并标过期。

- [x] **Step 3：实现面板与接入说明。** 上方 Provider/账号卡片，下方设备或项目分组；待审批优先。状态同时显示 lastKnown 与 confidence，离线不显示确定工作中；Stop 文案“本轮停止”。设备页展示 token 创建 CLI 命令说明、连接健康、eventLoss、安装前会话无法回填说明。手机 390px 单列，桌面多列，无横向溢出。这里实现功能布局，视觉风格可在后续独立调整。

useDashboardStream 使用同源 EventSource；invalidate 刷新期间再来事件时标 dirty，当前 fetch 完成后再取一次，避免旧响应覆盖新数据。网络失败保留数据显示“连接中断”；登录失效跳登录并清内存状态。计时器每秒计算持续时间，每 10 秒重新计算 stale/offline 标签，不发请求。提供手动全量刷新兜底；额度刷新按钮走 POST+CSRF。

- [x] **Step 4：浏览器测试。**

```ts
test('updates from an event and remains usable on mobile', async ({ page }) => {
  await loginAsTestAdmin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await postTestDeviceEvent('approval.requested');
  await expect(page.getByText('待审批', { exact: true })).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
```

helpers 位于 `tests/e2e/helpers.ts`：loginAsTestAdmin 通过真实表单登录；postTestDeviceEvent 使用测试设备 bearer token 和连续序号请求真实 API，不拦截前端网络来伪造成功。其余用例：同账号两设备一张卡、三种 Provider、零/未知余额、断线重连、30 秒冷却、XSS 标题作为文本、按项目聚合、时间阈值。真实 Provider 不参与 CI。

- [x] **Step 5：通过组件测试与 Playwright，提交** `feat: build responsive status and quota dashboard`。

### Task 4: Vercel Deployment, Provider Runtime, and Acceptance

**Files:** 新建 `vercel.json`、`deploy/Dockerfile.provider-runtime`、`deploy/compose.provider-runtime.yaml`、`deploy/provider-accounts.example.json`、`.env.example`、`.dockerignore`、`src/app/api/health/route.ts`、`scripts/backup.sh`、`scripts/restore.sh`、`docs/deployment.md`、`docs/acceptance.md`、`tests/integration/retention.test.ts`、`tests/e2e/deployment.spec.ts`。

**Interfaces:** `GET /api/health` 仅返回 `{ok:boolean}`，不返回版本、账号或连接串。Provider Runtime 配置含 id/providerId/label/credentialRef/options，不含明文 secret。

- [x] **Step 1：先写保留策略与部署配置测试。** 使用真实 DB 插入 31 天事件、91 天额度历史、latest 和 stream 水位，运行清理函数后断言历史删除但 latest、水位、账号和会话保留。静态校验 Vercel build 不产出 standalone 镜像、不允许 secret 进入 `NEXT_PUBLIC_*`，Provider Runtime 不暴露 Kimi API 端口。
- [x] **Step 2：运行定向测试确认红灯；实现 worker 日清理和 health。** 每日清理在 Provider Runtime worker 中执行，使用事务与清理锁；事件缺口尚待处理的记录不能随保留期静默删除。Vercel health 不回显数据库错误或运行时配置。
- [x] **Step 3：准备 Vercel 与 Provider Runtime。** Vercel 项目从仓库根目录部署 Next.js，不设置 `output: standalone`；Web/API 环境变量使用托管 PostgreSQL serverless/pooler URL。Provider Runtime 使用独立 Docker Compose 和持久授权卷，共享托管 PostgreSQL，使用 direct URL 供 session advisory lock、迁移和 LISTEN。Codex 使用 stdio；Kimi 服务只监听 worker 容器 loopback。Vercel 仅托管 Web/API，不假设 serverless 文件系统可保存 Provider 登录目录。

```yaml
# deploy/compose.provider-runtime.yaml；数据库由托管服务提供，Web 部署在 Vercel
services:
  worker:
    build: { context: '..', dockerfile: 'deploy/Dockerfile.provider-runtime' }
    environment:
      DATABASE_URL: '${DATABASE_DIRECT_URL}'
      PROVIDER_ACCOUNTS_FILE: '/run/config/accounts.json'
    volumes:
      - './accounts.json:/run/config/accounts.json:ro'
      - './secrets:/run/secrets:ro'
      - 'runtime-auth:/var/lib/dashboard-auth'
volumes:
  runtime-auth:
```

- [x] **Step 4：写 Vercel 部署、授权和备份恢复文档。** 从 Git 部署 Next.js 到 Vercel，配置 APP_ORIGIN、session secret、托管 PostgreSQL pooled URL；迁移以显式 release 命令运行。Vercel Cron 不承担五分钟额度刷新，调度由独立 Provider worker 完成。Provider Runtime 在服务器独立登录并持久化授权，不复制开发机 credential。管理员和设备初始化 CLI 在 worker 镜像执行，token 只显示一次。
- [x] **Step 5：完成产物检查与运行手册。** Provider Runtime 镜像固定 Codex/Kimi CLI 版本，包含 scripts/、migrations/、package.json 和 tsx；Kimi API 端口不映射公网。backup 使用 `pg_dump -Fc` 和受限授权卷备份（umask 077）；restore 默认恢复到新的测试数据库并检查 schema version，绝不自动覆盖生产库。Vercel region 与托管数据库 region 对齐，SSE Route Handler 设置有限 maxDuration 并允许浏览器自动重连。
- [ ] **Step 6：执行完整验收并记录证据。** unit、integration、typecheck、Vercel production build、Playwright、Provider Runtime compose config；Vercel preview/production 冷启动都可读托管 DB；worker 重启不丢会话/额度且 advisory lock 避免重复刷新；关闭两台设备后 Provider Runtime 仍能查询额度；正常事件 5 秒内可见；未登录/设备 token 不能读 SSE；备份恢复到隔离库可读取既有状态。**本地可执行项目已通过，远程 Vercel/Provider Runtime、Compose 解析和真实账号设备仍标记 NOT_RUN，见 `docs/acceptance.md`。**

`docs/acceptance.md` 每条记录 PASS/FAIL/NOT_RUN、版本、时间和不含敏感信息的证据。三家真实账号、两台真实设备、Vercel 项目、Provider Runtime 主机缺任何一个，都单独列 NOT_RUN，不能以合成 fixtures 代替真实验收。

- [x] **Step 7：提交** `feat: deploy dashboard to Vercel with provider runtime`；全量审查最终 diff 与设计约束。没有用户提供的 Vercel 项目和 Runtime 主机时只交付可部署产物，不声称已发布。
