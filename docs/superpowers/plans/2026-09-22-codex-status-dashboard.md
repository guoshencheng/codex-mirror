# Codex Status Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文件是执行索引，具体任务见三个子计划。

**Goal:** 用远程 Next.js 服务汇总各设备事件与三家 Provider 额度。

**Architecture:** Next.js App Router 部署到 Vercel，提供 Web、事件 API 和管理员 API；浏览器页面可见时每 10 秒读取 dashboard 快照。PostgreSQL 使用托管服务。独立 Provider worker 部署在有持久存储的远程运行时，共享领域模块并获取 Codex、DeepSeek、Kimi Code 额度；设备采集器仅持久化并上报 Codex 生命周期事件。

> 2026-09-22 实现调整：原计划的 SSE 页面推送已由受保护的 10 秒轮询替代；远端设备仍由 Hook/采集器主动上报事件。

**Tech Stack:** Next.js 16.3.5、React、TypeScript strict、Node.js 24 LTS、Vercel、托管 PostgreSQL 17、pg、Zod、Vitest、Playwright、Docker Compose（仅 Provider Runtime）。Node/Next 安装时核验安全补丁；全部依赖使用精确版本和 lockfile。不引入独立 API 框架、Redis 或 Codex 执行状态轮询。

**Spec:** [已批准设计及 Next.js 调整](../specs/2026-09-22-codex-status-dashboard-design.md)

## Global Constraints

- 各设备的 Codex 执行状态必须由事件上报驱动，不轮询进程、任务列表、会话文件或 UI 来判断执行情况。
- Provider 额度由远程服务自行获取；设备端不查询、不转发额度。
- Provider 查询采用策略接口和独立实现，新增 Provider 不修改刷新调度器、存储服务或通用展示组件。
- 凭据留在服务器，设备仅持有自己的上报凭证。
- 先覆盖 macOS、Linux，Windows 作为后续适配。
- 额度默认 5 分钟刷新，手动冷却 30 秒；成功数据超过 15 分钟标记过期。
- 心跳 20 秒，60 秒连接过期，120 秒离线；工作状态 10 分钟无新事件标记未确认。
- 本地队列限制 100 MB；事件保存 30 天，额度历史保存 90 天。
- 不以单个工具失败判定任务失败，不以 Stop 判定项目完成。

## Review Focus

1. 多进程同时刷新或 worker 崩溃：锁释放、请求重试，不覆盖新快照。P1-T4。
2. 补报、重复、乱序、epoch 切换：状态不回退，缺失不伪装确定。P2-T1/T3。
3. 管理员退出或会话过期：清空面板数据，设备 token 无法访问读接口。P3-T1/T2。
4. 同账号多设备及不同货币：不重复统计、不做隐式换算。P1-T3/T4、P3-T3。
5. Next 构建/重载与进程重启：无重复调度、无缓存泄漏、状态与授权持久化。P3-T4。

## 项目位置与分阶段交付

实现根目录：`/Users/guoshencheng/Documents/work/codex-mirror/codex-status-dashboard`；当前功能分支在 `.worktrees/native-implementation/`。
项目已初始化独立 Git 仓库和隔离分支，设计文档与三个子计划已复制到该仓库并提交为基线。后续不改动 `codex-quota/`。

| 顺序 | 子计划 | 独立可验收交付 |
| --- | --- | --- |
| 1 | [Provider 服务](2026-09-22-dashboard-01-providers.md) | 注册策略可查询三家额度；worker 可持续刷新并保存快照 |
| 2 | [设备事件链路](2026-09-22-dashboard-02-events.md) | 两台采集器可上报，服务端可准确归约、断网补报 |
| 3 | [Next.js 面板与部署](2026-09-22-dashboard-03-web-deploy.md) | 登录、实时面板、手机布局、Vercel 部署及 Provider Runtime 联通 |

各子计划都读取本索引与设计文档。先完成 P1-T1/T2 的契约与可行性验证，再实现真实策略。某一家真实授权未就绪时，可继续不依赖该授权的单元测试和事件/UI 工作，但不能声称三家已接入或用模拟数据冒充成功。

## 最终目录职责

```text
codex-status-dashboard/
  src/app/                     Next.js 页面和 API
  src/components/              纯展示和客户端轮询
  src/contracts/               可共享 DTO、Provider 指标、事件 schema
  src/server/providers/        Registry、策略、传输与凭据读取
  src/server/quota/            刷新请求、账号锁、快照持久化
  src/server/events/           事务接收、状态归约、设备认证
  src/server/auth/             管理员登录、会话、CSRF
  src/server/read-model/       对外只读 DTO、项目和设备汇总
  src/server/db/               连接、迁移、事务通知
  src/worker/                 独立调度入口，不导入 Next.js
  collector/src/              Hook 写入器、SQLite 队列、上传、心跳
  scripts/                    配置校验、管理员/设备初始化、采集器安装
  migrations/                 版本化 SQL
  tests/                      单元、PostgreSQL 集成、浏览器验收
  deploy/                     Vercel 配置、Provider Runtime 容器与启动说明
  docs/                       接入、版本验证和部署说明
```

## 命令约定

P1-T1 建立以下脚本，后续任务直接使用。单元测试不得调用真实 Provider。集成测试只连接独立 `TEST_DATABASE_URL`，必须拒绝非测试库名。

```json
{
  "dev": "next dev",
  "build": "next build && tsup src/worker/main.ts --format esm --platform node --out-dir dist-worker --no-splitting && tsup collector/src/cli.ts --format esm --platform node --out-dir dist-collector --no-splitting",
  "start": "next start",
  "worker": "tsx src/worker/main.ts",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:e2e": "playwright test",
  "db:migrate": "tsx scripts/migrate.ts",
  "providers:probe": "tsx scripts/probe-providers.ts",
  "admin:create": "tsx scripts/create-admin.ts",
  "device:create": "tsx scripts/create-device.ts",
  "device:revoke": "tsx scripts/revoke-device.ts",
  "collector": "tsx collector/src/cli.ts"
}
```

Worker/collector 入口在各自任务创建；此前用 `next build` 检查 Next.js，不把不存在的入口当作已完成构建。所有提交命令由实际交付目录精确暂存，不使用 `git add .` 导入 secrets。

## 最终验收清单

- [ ] 三家查询均从服务器发出；关闭执行设备后仍能刷新。
- [ ] 两设备事件能在正常联网下 5 秒内显示；无执行状态轮询。
- [ ] 离线/乱序/重复/崩溃场景与设计一致。
- [ ] 真实授权失效、429、结构变化有安全错误提示。
- [ ] 假 Provider 注册后无需修改通用 UI 或调度器。
- [ ] 数据库迁移、备份恢复、服务器重启和浏览器重连已验证。
- [ ] `typecheck`、单元、集成、Playwright 与生产 build 全通过；真实账号/设备验收单独记录，不能用单元测试代替。

## 技术依据与实现边界

Next.js Route Handlers 使用 Node runtime 和标准 Request/Response。面板在页面可见时通过短时 `GET /api/dashboard` 请求每 10 秒更新，不使用 SSE 或长连接。出处：[Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)。文档与 npm registry 在 2026-09-22 核对到 Next.js 16.3.5。

Web、登录会话与设备事件接收运行在 Vercel Functions。额度 worker 不运行在 Vercel：Codex App Server 与 Kimi Code Server API 依赖持久授权目录/本地运行时，需要在远程 Provider Runtime 中运行；它与 Vercel Web 共用托管 PostgreSQL，并通过账号 advisory lock 协调。部署文档必须把 Vercel 项目与 Runtime 分开说明。不要把后台任务挂在 Vercel 请求生命周期、`after()`、`instrumentation` 或客户端页面上。页面隐藏时暂停 dashboard 轮询；设备事件仍由采集器主动上报。

Vercel 当前 Cron 限制：Hobby 最多每天一次，Pro/Enterprise 可每分钟调度；本项目五分钟额度刷新不依赖 Cron，使用独立 Provider worker。参考：[Vercel Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)、[Function duration](https://vercel.com/docs/functions/configuring-functions/duration)、[Streaming](https://vercel.com/docs/functions/streaming-functions)。

## 执行交接

推荐 Native：三个阶段共享协议和数据库契约，在当前任务连续执行更容易保持一致；完成后进行独立全量复核。若选择 Subagent-driven，则按任务分别实现和审查。用户已选择当前任务直接实施，按 Native 执行顺序推进。

## 设计覆盖自检

| 设计要求 | 实现任务与验证 |
| --- | --- |
| Provider 策略和通用展示 | P1-T1/T3、P3-T3 的假 Provider / metric 测试 |
| 服务端三家授权与独立获取 | P1-T2 实机验证、P3-T4 关闭设备后查询 |
| 调度、重试、旧快照、历史 | P1-T4 锁/退避测试、P3-T4 保留与恢复测试 |
| 事件采集、持久化、脱敏 | P2-T2 队列、Hook 白名单和安装测试 |
| 乱序/重复/旧 turn/epoch | P2-T1/T3 纯归约及 PostgreSQL 事务测试 |
| 离线重连积压不伪装实时执行 | P2-T2/T3 恢复水位与 unconfirmed 测试 |
| 多账号、多设备与项目归并 | P1-T4、P2-T2/T3、P3-T2/T3 |
| 登录、CSRF、设备隔离、dashboard 读取授权 | P3-T1/T2 集成测试 |
| 远程 HTTPS、容器、备份恢复 | P3-T4 |
| 数据未知/过期/零值区别、手机查看 | P3-T3 组件及 Playwright 测试 |

自检结果：已核对章节覆盖、相对链接、代码块配对、关键命名和任务依赖；真实接口验证、代码测试与部署仍属于执行阶段，尚未执行。
