# Codex 网页登录实施计划

> **供执行者使用：**按任务逐项实施；使用 `superpowers:executing-plans` 在当前会话执行，或使用 `superpowers:subagent-driven-development` 分任务执行。以下复选框用于记录进度。

**目标：**让看板管理员通过 ChatGPT 设备码登录添加 Codex 账号，并立即查看额度。

**架构：**Web 服务向 PostgreSQL 写入登录请求并轮询状态；worker 领取任务，在隔离运行目录中运行 Codex App Server。只有验证网址和一次性代码进入浏览器。登录成功后，worker 保存账号及初始额度，后续沿用现有额度刷新机制。

**技术栈：**Next.js 16.3.5、React 19.3.0、TypeScript、PostgreSQL、Codex App Server JSON-RPC、Vitest。

**设计文档：**`docs/superpowers/specs/2026-09-23-codex-web-login-design.md`

## 全局约束

- OAuth 凭据只保存在 worker 的 `runtime-auth` 卷，不进入 PostgreSQL、浏览器、日志或 API 响应。
- 登录接口的读写都要求管理员会话；开始与取消操作需要 CSRF 校验。
- 保持文件配置的 Codex 账号以及 DeepSeek、Kimi 账号创建方式可用。
- 使用官方 `chatgptDeviceCode` 流程，保存前确认登录方式为 ChatGPT。
- 登录接口返回 `private, no-store`，并限制请求数量、输入长度与有效期。
- Codex CLI 只在 worker 中运行，Web 镜像不需要 CLI 或授权卷。

## 重点复核

- 第二个管理员会话轮询他人的请求必须得到 404；登出再登录后亦然。
- 设备码登录被禁用时，显示可操作的错误，且不留下账号或授权缓存。
- 授权期间 worker 重启时，请求不能永久等待，也不能残留子进程。
- 错误或非 OpenAI 的验证网址不能成为可点击链接。
- 网页登录后的账号不能被配置文件同步禁用。

---

### 任务 1：登录请求持久化与账号归属

**文件：**新建 `migrations/008-codex-login-requests.sql`、`src/server/providers/codex/login-repository.ts`、`tests/integration/codex-login-repository.test.ts`；修改 `src/server/quota/repository.ts`。

**接口：**`CodexLoginRepository` 提供 `create(sessionId, label)`、`read(id, sessionId)`、`cancel(id, sessionId)`、`claimNext()`、`markAwaiting(id, verificationUrl, userCode, loginId)`、`complete(id, snapshot)`、`fail(id, code)`、`recoverStale()`。请求记录包含 UUID、`codex_<无连字符UUID>` 账号 ID、创建者会话、名称、状态、可公开的代码字段、错误码和时间戳。

- [ ] 编写失败的集成测试：参照现有管理账号测试创建独立 schema，运行迁移 001、003、008；断言新请求为 `queued`、其他会话读取为 `null`、同会话不能同时启动第二个请求、请求只能被领取一次。
- [ ] 运行 `npx vitest run --config vitest.integration.config.ts tests/integration/codex-login-repository.test.ts`，确认因迁移或仓库文件不存在而失败。
- [ ] 实现表及仓库：会话外键、状态约束、每会话有效请求的部分唯一索引、10 分钟有效期；使用 `FOR UPDATE SKIP LOCKED` 领取任务；`read` 只返回公开字段；`recoverStale` 结束超时任务；事务内以 advisory lock 将全局有效请求上限设为 5。修改配置文件同步逻辑，保留 `credential_ref = 'managed-codex-login'` 的账号。
- [ ] 运行新集成测试与 `npx vitest run tests/unit/provider-bootstrap.test.ts`；补充网页创建账号在空配置同步后仍启用的断言。
- [ ] 只提交本任务涉及文件，提交信息为 `feat: persist Codex login requests`。

### 任务 2：隔离的 App Server 登录进程

**文件：**新建 `src/server/providers/codex/login-rpc.ts`、`tests/unit/codex-login-rpc.test.ts`。

**接口：**`startCodexDeviceLogin(home, signal, onCode): Promise<{ rateLimits: unknown }>`；收到有效的 `account/login/start` 结果后，`onCode` 接收 `{ loginId, verificationUrl, userCode }`。调用方负责运行目录；进程有 10 分钟硬超时，终止、取消或协议失败时清理。

- [ ] 使用模拟 JSON-RPC 子进程编写失败测试，验证 `initialize`、`initialized`、`account/login/start`（`chatgptDeviceCode`）、`account/login/completed`、`account/read`、`account/rateLimits/read` 的顺序；API Key 账号必须被拒绝，结果中不含令牌。
- [ ] 运行 `npx vitest run tests/unit/codex-login-rpc.test.ts`，确认因文件不存在而失败。
- [ ] 复用现有 `codex/rpc.ts` 的逐行协议、1 MiB 行长度上限、进程清理和受限环境变量方式；注入 spawn 工厂供测试。验证登录类型、UUID、代码长度及官方 HTTPS 验证域名；等待匹配 `loginId` 的完成通知，确认 `account/read` 的类型为 `chatgpt`，再读取额度。
- [ ] 测试设备码登录禁用、错误 `loginId`、无效网址、子进程退出、超时、取消和超长消息；所有情况均检查进程终止及等待者清理。
- [ ] 提交本任务文件，提交信息为 `feat: run Codex device login through app server`。

### 任务 3：worker 领取、完成和刷新

**文件：**新建 `src/worker/codex-login.ts`、`tests/integration/codex-login-worker.test.ts`；修改 `src/worker/main.ts`、`src/server/quota/repository.ts`、`src/server/read-model/handlers.ts`。

**接口：**`processCodexLoginOnce(pool, signal, deps?)` 领取一个请求，调用任务 2 的登录函数，经 `normalizeCodex` 规范化额度，再由任务 1 的仓库在事务中保存账号与初始快照。`refreshDueAccountsOnce` 识别 `managed-codex-login`；网页刷新接口只排队，由 worker 执行。

- [ ] 编写失败的集成测试：模拟 App Server 登录成功后，断言新增 Codex 账号、托管运行时标记、额度快照和刷新状态；失败或取消时不新增账号并清理未用运行目录；后续刷新能读取网页登录账号额度。
- [ ] 运行 `npx vitest run --config vitest.integration.config.ts tests/integration/codex-login-worker.test.ts`，确认失败。
- [ ] 在 `CODEX_RUNTIME_ROOT` 下创建权限为 0700 的目录；仅通过 `onCode` 更新等待状态；使用事务提交账号、快照和成功状态；子进程退出后清理失败目录。worker 启动和循环时恢复过期任务，在额度刷新前处理登录。保留文件配置账号的原有刷新路径。
- [ ] 运行本任务测试及 `tests/integration/managed-deepseek-accounts.test.ts`、`tests/integration/quota-refresh.test.ts`。
- [ ] 提交本任务文件，提交信息为 `feat: complete Codex login in provider worker`。

### 任务 4：管理员接口与 Codex 页面

**文件：**新建 `src/app/api/provider-accounts/codex-login/route.ts`、`src/app/api/provider-accounts/codex-login/[id]/route.ts`、`src/components/codex-login-form.tsx`、`tests/integration/codex-login-routes.test.ts`、`tests/unit/codex-login-form.test.tsx`；修改 `src/components/managed-account-form.tsx`。

**接口：**`POST /api/provider-accounts/codex-login` 接收 `{label}`，返回 HTTP 202 与 `{id,status}`；`GET /api/provider-accounts/codex-login/[id]` 仅向创建会话返回状态、网址、代码、账号 ID 或错误；同一路径的 `DELETE` 需要 CSRF，用于取消。

- [ ] 编写失败的接口测试：未登录请求、缺失 CSRF、跨会话 GET 的 404、无效名称以及 `Cache-Control: private, no-store`；组件测试确认选择 Codex 后出现名称和开始按钮，且不出现 API Key 输入框。
- [ ] 运行新接口和组件测试，确认失败。
- [ ] 通过 `CodexLoginRepository`、现有 `requireAdmin`、`verifyCsrf`、`readBoundedJson` 实现接口；数量上限和重复请求分别返回 429、409；响应与异常不得包含凭据。
- [ ] 在添加账号视图加入 Codex 选项；仅在页面可见且请求有效时轮询，展示官方网址、代码、等待和重试状态；新窗口使用 `noopener noreferrer`；成功后调用现有 `onSaved`。保留 DeepSeek/Kimi 批量表单，提示用户启用 ChatGPT 设备码登录。
- [ ] 运行新测试和 `tests/unit/pixel-dashboard.test.tsx`；提交本任务文件，提交信息为 `feat: add Codex login to account form`。

### 任务 5：部署说明和完整验证

**文件：**修改 `docs/self-hosted-deployment.md`、`docs/deployment.md`、`tests/e2e/dashboard.spec.ts`。

**接口：**继续使用现有 Compose 布局：Web 镜像无 Codex CLI，worker 镜像有 Codex CLI 和 `runtime-auth` 卷。

- [ ] 添加端到端测试：打开“添加账号”、选择 Codex，利用模拟登录 API 检查名称、代码、等待及结果状态；运行 `npx playwright test tests/e2e/dashboard.spec.ts`，确认新测试先失败，再完成模拟并重跑。
- [ ] 在两份部署文档中说明网页登录、ChatGPT 设备码开关、失败重试和 CLI 登录备用方法；不得让运维将 `auth.json` 复制进 Web 容器。
- [ ] 运行 `npm run typecheck`、`npm test`、`npm run test:integration`、`npm run test:e2e`；针对实际失败修复。有 Docker 守护进程时构建 Web 与 worker 镜像。
- [ ] 复核令牌泄漏风险、意外跟踪文件和“重点复核”中的五种情况；只提交本任务文件，提交信息为 `docs: verify Codex dashboard login`。

部署后的人工验收：为测试 ChatGPT 账号启用设备码登录，走完页面授权流程，确认出现新的 Codex 额度；重启 worker 后确认额度仍能刷新。CI 模拟测试不能替代真实账号验收。
