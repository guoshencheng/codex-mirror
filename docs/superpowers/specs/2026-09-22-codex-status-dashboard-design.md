# Codex 多端状态与 Provider 额度面板设计

日期：2026-09-22
状态：用户已批准进入实现计划；按 2026-09-22 最新要求改为 Next.js 研发框架。

## 1. 目标与已确认约束

用户通过部署在远程服务器上的 Web 面板，查看多台设备上的 Codex 执行情况，以及 Codex 额度、DeepSeek 余额和 Kimi Code 订阅额度。

- 各设备的 Codex 执行状态必须由事件上报驱动，不轮询进程、任务列表、会话文件或 UI 来判断执行情况。
- Provider 额度由远程服务自行获取；设备端不查询、不转发额度。
- Provider 查询采用策略接口和独立实现，新增 Provider 不修改刷新调度器、存储服务或通用展示组件。
- 首期为个人统一看板；“多个端”指多台执行设备，暂不包含团队租户与角色权限。
- 凭据留在服务器，设备仅持有自己的上报凭证。
- 本次产出为设计文档，不部署服务、不读取真实凭据、不修改 Codex Hooks 配置。

## 2. 架构与边界

```text
设备 A/B/C
  Codex Hooks → 事件写入器 → 本地持久队列 → 上传器
  采集器心跳 ────────────────────────────┘
                         HTTPS
                           ↓
远程服务
  设备认证 → 事件接收 → 事务去重/状态归约 → PostgreSQL
  调度器 → Provider Registry → 具体策略 → Provider 服务
                              ↓
                         额度快照/历史
                              ↓
                       登录保护的 API + SSE
                              ↓
                       响应式 Web 面板
```

技术栈：TypeScript、Next.js App Router（页面与 Route Handlers）、Node.js LTS、Vercel、托管 PostgreSQL。Vercel 部署 Web/API；额度 worker 与 Provider CLI 的持久授权运行在独立远程 Provider Runtime。计划基线为 Next.js 16.3.5、Node.js 24 LTS、PostgreSQL 17；安装时核验安全补丁并锁定依赖。

所有 Web 和设备业务 HTTP 接口由 Next.js 提供，不额外引入 Fastify。额度调度作为独立 Node.js Provider worker 运行，共用领域模块；不在 Vercel Route Handler、instrumentation 或 after 回调里启动周期任务。手动刷新只入持久请求队列，由 worker 消费。SSE 使用 PostgreSQL LISTEN/NOTIFY 通知失效，全量查询为真值；通知不承载敏感数据。Vercel Functions 负责请求生命周期，不能假设其文件系统可持久保存 Codex/Kimi 登录态。

Web 与服务端同源。首期一个服务实例即可，数据库管理事件和额度刷新锁，无需 Redis。设备端先覆盖 macOS、Linux，Windows 作为后续适配；这是当前平台假设，不影响上报协议。

现有 `codex-quota/` 是独立 macOS 应用，不改造为服务端，也不把新文档或代码放进其仓库。后续实现使用当前工作区内独立的新项目目录。

## 3. Provider 策略模式

### 3.1 分层

- `QuotaProviderStrategy`：描述能力、校验本 Provider 配置、查询并标准化数据。
- `ProviderRegistry`：按 providerId 注册和解析策略，无默认回退 Provider。
- `QuotaRefreshService`：统一超时、并发控制、刷新锁、重试退避、错误归类及持久化。
- `CredentialStore`：按服务端配置的 credentialRef 提供凭据，策略仅在查询期间使用；不传给浏览器。
- `QuotaRepository`：保存最新成功快照、刷新状态与历史，不保存原始响应或凭据。
- Web：根据指标类型渲染，不根据 providerId 写业务分支。

推荐模块边界：`providers/core`、`providers/codex`、`providers/deepseek`、`providers/kimi-code`、`quota-refresh`。避免一个函数内堆叠 Provider 分支。

### 3.2 策略契约草案

以下为设计契约，具体类型在后续实现计划中固定。

```ts
type ProviderId = string;
type MetricKind = 'quota-window' | 'balance';

interface ProviderCapabilities {
  metricKinds: readonly MetricKind[];
  authModes: readonly ('api-key' | 'managed-login')[];
}

interface ProviderAccountConfig {
  id: string;                  // 内部稳定账号 ID
  providerId: ProviderId;
  label: string;
  credentialRef: string;       // 仅服务端可见
  options: Readonly<Record<string, unknown>>;
}

interface QuotaWindowMetric {
  kind: 'quota-window';
  key: string;                // bucket/window 的稳定标识
  label: string;
  usedPercent: number | null;
  windowDurationSeconds: number | null;
  resetsAt: string | null;     // UTC ISO 8601
}

interface BalanceMetric {
  kind: 'balance';
  key: string;
  label: string;
  currency: string;
  total: string;              // 十进制金额字符串，禁止浮点汇总
  granted: string | null;
  toppedUp: string | null;
  details?: readonly { key: string; label: string; value: string }[];
}

type QuotaMetric = QuotaWindowMetric | BalanceMetric;

interface ProviderSnapshot {
  accountId: string;
  providerId: ProviderId;
  observedAt: string;
  metrics: readonly QuotaMetric[];
  serviceAvailable: boolean | null;
}

type ProviderFailure = {
  code: 'AUTH_REQUIRED' | 'AUTH_EXPIRED' | 'FORBIDDEN'
      | 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE'
      | 'SCHEMA_CHANGED' | 'UNSUPPORTED';
  retryAfterSeconds?: number;
};

type ProviderFetchResult =
  | { ok: true; snapshot: ProviderSnapshot }
  | { ok: false; error: ProviderFailure };

interface ProviderContext {
  signal: AbortSignal;
  readSecret(ref: string): Promise<string>;
}

interface QuotaProviderStrategy {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  validateConfig(config: ProviderAccountConfig): readonly string[];
  fetchSnapshot(
    config: ProviderAccountConfig,
    context: ProviderContext,
  ): Promise<ProviderFetchResult>;
}
```

策略只负责一次查询，不自行启动轮询、写库或推送 SSE；传输细节由各实现封装。调度器兜底捕获非预期异常，禁止把上游错误正文返回前端。

余额和额度不合并成一个“总额度百分比”。不同币种分别展示，不自动汇率换算。不根据模型名称猜测额度桶映射；只展示来源明确提供的关联。

### 3.3 首批具体策略

| 策略 | 数据源与授权 | 标准化规则 |
| --- | --- | --- |
| CodexQuotaStrategy | 服务器侧 Codex App Server 的 `account/rateLimits/read`，使用服务器上的受支持账号登录 | 优先读取多 bucket 结果；兼容单 bucket；窗口长度以响应为准；剩余百分比由 100-usedPercent 得到 |
| DeepSeekBalanceStrategy | 官方 `GET /user/balance`，服务端 API Key | 按币种映射 total/granted/toppedUp；保留 `is_available` 语义 |
| KimiCodeQuotaStrategy | 服务器本地 `kimi web` 的 `/api/v1/oauth/usage`，服务器侧受管理登录 | 将 usedRatio 转为百分比；显示实际返回的窗口；可用时单独展示 extraUsage 钱包 |

Codex 与 Kimi 的运行时是服务端内部辅助进程，不负责管理设备任务。仅使用查询能力；Kimi 本地接口必须鉴权并仅绑定回环地址，不对公网暴露会话管理 API。

Kimi 接口标记为实验性，绑定已验证版本，并使用契约样本测试。尚未验证服务器无头登录、授权续期和部署打包：这些是可行性验证交付项，而非已完成能力。验证失败应报告具体阻塞，不替换为设备端额度采集，不静默使用未公开接口。

### 3.4 调度与账号

默认每个账号 5 分钟刷新一次，加入随机抖动；手动刷新最短间隔 30 秒，与定时刷新共享账号级锁。普通失败指数退避，上限 30 分钟；遇到 Retry-After 遵循服务端指示。授权失效暂停自动重试并要求重新登录。

HTTP 查询默认 15 秒超时，辅助运行时查询默认 30 秒，可按策略调整。终止信号必须传递到实际请求；失败不得清空旧快照。前端分别显示 lastAttemptAt、lastSuccessAt、refreshStatus，超过 15 分钟未成功则标记数据过期。

同一 Provider 可配置多个账号。账号与设备为可选多对多关联，同一账号只刷新和展示一份；账号 ID 不从设备名推导。首期由管理员配置关联，界面标明其为配置关系，不声称实时识别任务实际扣费账号。

## 4. Codex 事件采集

Hook 写入器将最小事件原子写入本地持久队列，上传器收到服务端确认后删除。不上报提示词、对话正文、工具参数、文件内容或凭据。项目名、任务标题仅在有明确事件来源或人工别名时展示，缺失时使用会话短 ID。

事件包含 schemaVersion、eventId、deviceId、collectorEpoch、sequence、sessionId、turnId、type、occurredAt 和允许的元数据。会话在服务端用 `(deviceId, sessionId)` 标识；序号由本地采集器分配并持久化，重试保持 eventId 不变。设备标识由认证凭证决定，不能信任请求内自行指定的 deviceId。

上传按设备序列顺序批量进行，服务端事务内按 eventId 去重，并维护已应用的序号。已知缺口记录为采集不完整，等待补报；缺口未恢复时不能把后来的非终态事件当作确定状态。事件时间用于展示，序列用于排序，避免设备时钟漂移影响状态机。

队列默认限制为 100 MB，容量耗尽须记录采集健康错误及缺失标记，不静默删除事件。Hook 不因上传失败阻塞 Codex，也不返回审批决定。

### 4.1 状态语义

| 事件 | 任务视图 |
| --- | --- |
| SessionStart | 空闲 |
| UserPromptSubmit | 工作中 |
| PreToolUse / PostToolUse | 工作中；更新最近活动 |
| PermissionRequest | 待审批 |
| Stop | 本轮停止；不推断项目成功完成 |
| Interrupt | 已中断 |
| SessionEnd | 会话结束 |

映射必须经过目标客户端实机验证。Hook-only 不猜测自然语言提问是否在等待用户，也不把某个工具失败直接判为整个任务失败。缺少明确事件时展示未知或最后已知状态。旧 turn 的迟到事件不能覆盖新 turn。

### 4.2 连通性与局限

采集器每 20 秒发送一次心跳，仅证明采集器连接正常。超过 60 秒显示连接过期，超过 120 秒显示离线；不将任务改成空闲。

严格事件模式无法保证发现没有终止事件的 Codex 崩溃。界面始终显示“最近事件时间”；工作状态持续 10 分钟没有事件时标记“执行状态未确认”，而不是判定失败。后续事件可恢复确认。采集器重启或离线恢复时，保留最后已知状态但标记未确认，直到收到新事件。

采集器安装前已运行的会话不能靠轮询回填；需等后续事件或重新开启会话。此限制应在设备接入页说明。

## 5. 服务端数据与接口

主要表：devices、projects、sessions、agent_events、provider_accounts、device_account_links、quota_snapshots、quota_refresh_status。

- 事件接收与状态更新在同一数据库事务提交，提交后才确认上传。
- 项目可用规范化 Git remote 汇总，去除 URL 凭据；无 remote 时使用设备内路径摘要，不把不同机器的同名目录自动合并。
- 默认保留事件 30 天、额度历史 90 天；最新会话状态和最新成功快照独立保留。
- 最新快照唯一键为账号 ID；历史记录按账号和观测时间组织，禁止跨账号覆盖。

接口职责：

- `POST /api/agent/events`：设备认证、批量接收、去重确认。
- `POST /api/agent/heartbeat`：设备连通性及队列健康。
- `GET /api/devices`、`GET /api/sessions`：登录用户读取状态。
- `GET /api/provider-accounts`：返回不含凭据的配置概要与额度。
- `POST /api/provider-accounts/:id/refresh`：请求刷新，返回执行中或冷却状态。
- `GET /api/stream`：带版本标识的变更通知；断线重连重新拉取全量快照，避免错过更新。

首期以部署配置管理账号与 secret 文件引用，Web 不提供任意上游 URL 输入和凭据编辑器。

## 6. Web 与部署

首页上方为额度卡片，下面是设备与任务列表。可按设备或项目分组，待审批任务优先。设备离线、事件不完整和额度过期都要用文字说明，不仅依赖颜色。

每张额度卡片展示 Provider、账号别名、实际返回的窗口或余额、重置时间、最近成功刷新时间、错误状态及手动刷新。没有值时显示不可用，不显示零。金额保留来源币种；重置时间按浏览器时区显示。

Vercel 提供 Web/API；托管 PostgreSQL 保存状态、快照与手动刷新队列。独立远程 Provider Runtime 使用容器运行额度 worker 和必要的 Kimi 辅助服务，持久化账号授权目录；Kimi 端口只监听容器 loopback，不开放公网。设备事件直接上报 Vercel API。

首期采用单管理员登录、服务端会话 cookie（Secure、HttpOnly、SameSite）及写操作 CSRF 防护。设备使用单独可撤销 token，只允许事件和心跳写入，不能读取面板或额度。凭据以服务器权限受限的 secret 文件或运行时授权卷保存，不写入数据库快照、日志、镜像、Git 或浏览器响应。备份授权卷与数据库时保持访问控制。

## 7. 验证与验收

1. 在两台真实设备上分别提交、停止和触发审批；面板在联网正常时 5 秒内反映事件，确认没有任务轮询。
2. 断网后产生事件，恢复连接可补报；重复上传不重复应用，乱序和旧 turn 不导致状态回退。
3. 采集器在线但 Codex 无终止事件退出时，不谎报已完成，展示最后事件及未确认状态。
4. 单独从远程服务器获取三家真实账号数据，与官方显示核对；不依赖执行设备在线。
5. 用脱敏样本测试策略：多 bucket、缺失窗口、零余额、多币种、非整数百分比、失效授权、429、超时和响应结构变化。
6. 用假 Provider 策略接入 Registry，验证无需修改调度器和通用 UI 即能展示其标准指标。
7. 同一账号关联两台设备只产生一份额度；并发手动/定时刷新只查询一次。
8. 验证设备凭证不能读面板、未登录不能读 SSE，响应与日志不含凭据。
9. 新服务器按部署文档启动、重启及恢复备份后，账号配置与快照仍可用。

## 8. 实施阶段与可行性门槛

先验证服务端三家授权与读取，以及目标 Codex Desktop/CLI 的 Hook 覆盖，记录版本、脱敏响应和限制。不在验证阶段更改用户的工作流程。

验证通过后，按以下可独立验收的模块拆分详细计划：

1. Provider 契约、Registry、三种策略和服务器额度刷新闭环。
2. 设备事件协议、本地持久队列、上传和服务端归约闭环。
3. Web 汇总、登录、SSE、部署与完整验收。

远程任务控制、审批操作、任务派发、通知、自动充值、额度重置操作、Windows 安装器和原生 Widget 不属于首期范围。

## 9. 依据与未验证范围

- 已阅读参考对话《Codex任务通知Hooks》，仅作为设计背景；接口能力以官方文档及实机验证为准。
- Codex Hooks：https://learn.chatgpt.com/docs/hooks
- Codex App Server：https://learn.chatgpt.com/docs/app-server
- DeepSeek Balance：https://api-docs.deepseek.com/api/get-user-balance/
- Kimi Code Server API：https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html

上述接口在本次对话中查阅过文档，尚未对用户真实账号和服务器运行验证。不存在已部署或已完成接入的声明。
