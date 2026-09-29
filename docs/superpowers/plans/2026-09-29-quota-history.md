# 额度历史与折线图实施计划

> **执行代理必读：** 使用 `superpowers:subagent-driven-development`（子代理方式）或 `superpowers:executing-plans`（当前会话方式）逐任务实施；执行方式由用户审阅计划时选择。以下复选框用于跟踪完成情况。

**目标：** 在现有额度详情中展示最近 90 天的历史折线图，同时支持登录主站和独立展示端。

**架构：** 复用 `quota_snapshots` 及现有采集、清理流程，新增账号时间索引和只读历史服务。服务统一生成序列并降采样，两类鉴权接口共享服务；前端通过注入加载函数复用 React/SVG 图表。

**技术栈：** 现有 Next.js 16.3.5、React 19.3.0、TypeScript、PostgreSQL/pg、Vitest、Playwright、展示端 Vite；不新增图表依赖。

**设计依据：** [已确认设计](../specs/2026-09-29-quota-history-design.md)。执行者必须同时阅读设计与本计划。

## 全局约束

- 历史保留最近 **90 天**。沿用每日物理清理；所有查询独立限制 90 天。
- `range` 仅允许 `24h`、`7d`、`30d`、`90d`，默认 `24h`；时间范围为 `[from, to]`，使用服务器时间。
- 时间桶分别为 5 分钟、30 分钟、2 小时、6 小时；每桶保留首、末、最小、最大实际采样点。最多 361 个桶，每条序列最多 1444 个实际采样点。
- 先识别缺失再降采样；相邻有效采样间隔超过 15 分钟断开；缺指标、空值、服务明确不可用也断开。
- 剩余额度为 `100 - usedPercent`，纵轴固定 0～100%；余额单独绘图且保留原始十进制字符串。
- 详情打开且页面可见时，每 60 秒重取；关闭、隐藏及卸载停止，恢复可见时重取。
- 所有 HTTP 响应设置 `Cache-Control: private, no-store`；保留现有主站鉴权及展示端 Token/CORS 边界。
- 不增加消费预测、告警、跨账号汇总、导出、长期归档或历史失败事件表。
- 设计文档和实现计划都用中文表述。编写 Next.js 代码前阅读本地 `node_modules/next/dist/docs/` 相关指南。

## 审查重点

以下五项均分配了测试，交付前仍需检查实际行为：

1. 降采样省略的点中含缺失或重置：不能跨缺失连线，也不能丢失桶内极值（任务 2）。
2. 账号、范围、Token 改变时旧请求迟到：不能污染新图，旧定时器必须停止（任务 4、5）。
3. worker 清理延迟、范围边界及同时间戳重复快照：不越过 90 天，确定性选择最大 id（任务 1）。
4. 余额高精度、巨大数值或全值相等：提示保留原值，图形不产生 NaN/Infinity（任务 2、3、4）。
5. 展示端只读、跨域错误及静态 demo：有权限的只读用户能查看，非法来源不能访问，demo 不发真实请求（任务 3、5、6）。

## 执行前置与文件边界

本次规划时工作区缺少 `node_modules/next/dist/docs/`。实施阶段先检查依赖；若缺失，使用锁文件执行 `npm ci`，再定位并阅读 Next.js 路由、动态路由参数及客户端组件指南。无法获取本地指南时记录阻碍，不凭旧版本经验编写 Next.js 代码。测试数据库名必须以 `_test` 结尾，不向部署数据库播种测试数据。

新增文件的责任分别为：`src/contracts/quota-history.ts` 定义传输契约；`src/server/quota/history.ts` 整理历史；`src/server/quota/history-handlers.ts` 管理 HTTP；`src/server/auth/display.ts` 共享展示端鉴权；`src/lib/quota-history-client.ts` 验证响应和请求；`src/components/quota-history-chart.tsx` 绘图；`src/components/quota-history.tsx` 请求和交互；`src/components/quota-history.module.css` 局部样式。所有路径均相对仓库根目录。

## 任务 1：可重复验证的历史查询与保留边界

**文件：** 新建 `migrations/010-quota-history-index.sql`、`tests/integration/quota-history.test.ts`；修改 `src/server/quota/repository.ts`、`tests/integration/quota-refresh.test.ts`。

**接口：** 在 repository 导出 `QuotaHistoryRow = { id: string; observedAt: string; snapshot: ProviderSnapshot }`；新增 `QuotaRepository.readHistory(accountId: string, from: Date, to: Date): Promise<QuotaHistoryRow[] | null>`。`null` 表示账号不存在或停用，`[]` 表示账号有效但无历史。内部将下界钳制为 `max(from, to - 90 天)`；to 由服务传入服务器当前时间。

- [ ] **1. 编写失败测试。** 沿用 `withTestDb` 的隔离 schema，在新测试中显式应用 010（该辅助函数目前仅执行 001）。使用固定 `to = 2026-09-29T00:00:00Z`，断言如下；序列化 id 保持字符串，不转换为 JS number。

  ```ts
  expect(await repository.readHistory('missing', from, to)).toBeNull();
  expect(await repository.readHistory('empty', from, to)).toEqual([]);
  expect(rows!.map(row => row.id)).toEqual([boundaryId, largerDuplicateId, endId]);
  expect(await repository.cleanupHistory(from)).toBe(1);
  expect((await repository.readLatest('a')).snapshot).toEqual(latestBeforeCleanup);
  ```

  夹具同时包含其他账号、已停用账号、下界前 1 毫秒、上下界、上界后 1 毫秒和重复时间戳。补充两次成功刷新（额度值相同、采集时间不同）产生两条记录，失败后数量仍为 2；查询 `pg_indexes` 确认复合索引列次序。
- [ ] **2. 运行失败验证。** `npm run test:integration -- tests/integration/quota-history.test.ts tests/integration/quota-refresh.test.ts`；新用例应因方法或迁移不存在失败，而非连接错误。
- [ ] **3. 实现查询和迁移。** 创建 `quota_history_account_time` 索引 `(account_id, observed_at, id)`。参数化查询过滤启用账号和时间，按时间去重取最大 id，再升序输出；在同一 SQL 读取账号存在性和历史，避免检查账号与查询之间的竞态。保留现有写入、清理和最新值行为。
- [ ] **4. 重跑步骤 2。** 所有相关用例通过，确认迁移可作用于已经有历史记录的表。
- [ ] **5. 提交。** 仅暂存本任务文件，提交 `feat: add indexed quota history queries`。

## 任务 2：明确的历史契约、断点与降采样

**文件：** 新建 `src/contracts/quota-history.ts`、`src/server/quota/history.ts`、`tests/unit/quota-history.test.ts`。

**消费：** 任务 1 的 `QuotaRepository.readHistory` 与 `QuotaHistoryRow`。

**产出接口：**

```ts
type QuotaHistoryRange = '24h' | '7d' | '30d' | '90d';
type QuotaHistoryPoint = {
  observedAt: string; value: number | string; resetsAt: string | null; breakBefore: boolean;
};
type QuotaHistorySeries = {
  id: string; key: string; label: string; kind: 'quota-window' | 'balance';
  unit: string; windowDurationSeconds: number | null; points: QuotaHistoryPoint[];
};
type QuotaHistoryDto = {
  accountId: string; range: QuotaHistoryRange; from: string; to: string;
  generatedAt: string; retentionDays: 90; bucketSeconds: number; series: QuotaHistorySeries[];
};
type QuotaHistoryLoader = (
  accountId: string, range: QuotaHistoryRange, signal: AbortSignal
) => Promise<QuotaHistoryDto>;
```

服务导出 `buildQuotaHistory(accountId: string, range: QuotaHistoryRange, rows: readonly QuotaHistoryRow[], now: Date): QuotaHistoryDto` 和 `readQuotaHistory(repository: QuotaRepository, accountId: string, range: QuotaHistoryRange, now: Date): Promise<QuotaHistoryDto | null>`；后者算范围、读取、调用前者。契约文件仅导出类型及无服务端依赖的范围常量。

- [ ] **1. 编写失败测试。** 固定 now；构造已排序采样验证下面的断言。额度窗口序列 id 用 `JSON.stringify([kind, key, windowDurationSeconds])`，余额用 `[kind, key, currency]`，避免分隔符碰撞；同一序列名称取最后出现的 label，按 id 排序返回。

  ```ts
  expect(dto.retentionDays).toBe(90);
  expect(dto.series[0].points[0].value).toBe(72); // usedPercent = 28
  expect(wallet.points[0].value).toBe('0.00000001');
  expect(afterMissing.breakBefore).toBe(true);
  expect(atExactly15Minutes.breakBefore).toBe(false);
  expect(after15MinutesAnd1ms.breakBefore).toBe(true);
  expect(resetSeries.points.map(p => p.value)).toContain(100);
  expect(longSeries.points.length).toBeLessThanOrEqual(1444);
  ```

  补充四种范围及桶秒数 `[300,1800,7200,21600]`；空指标、空值、服务不可用、指标消失后恢复、同 key 窗口/币种改变、缺失被采样省略、同桶多次峰谷、全值相等、首末极值重合。余额极值比较用字符串十进制精确排序测试，例如 `9007199254740992.01` 与 `9007199254740992.02` 不能误判相等。
- [ ] **2. 运行失败验证。** `npm test -- tests/unit/quota-history.test.ts`，应因模块缺失失败。
- [ ] **3. 实现服务。** 用 `floor(observedAtMillis / bucketMillis)` 定位 UTC 桶。先逐快照标记原始连续段，再每桶选首末极值，最后将原始断点传播到相邻保留点。第一点 `breakBefore=true`；空值不绘制但必须终止连续段；无有效点的序列不输出。缺失期间保持其他序列独立。余额比较规范化整数长度、整数和补零小数部分，不先转换 Number；提示保留原始值。响应只选择契约字段。
- [ ] **4. 重跑步骤 2 及任务 1 集成测试。** 确认旧历史无需回填、查询无记录时 DTO 合法且为空。
- [ ] **5. 提交。** 提交本任务文件，消息 `feat: build sampled quota history series`。

## 任务 3：主站和展示端历史接口

**文件：** 新建 `src/server/quota/history-handlers.ts`、`src/server/auth/display.ts`、`src/app/api/provider-accounts/[id]/history/route.ts`、`src/app/api/display/provider-accounts/[id]/history/route.ts`、`src/lib/quota-history-client.ts`、`tests/unit/quota-history-api.test.ts`、`tests/unit/quota-history-client.test.ts`；修改 `src/app/api/display/dashboard/route.ts`，复用现有 `tests/unit/display-api.test.ts`。

**消费：** 任务 2 的 DTO、范围及 `readQuotaHistory`。

**产出接口：** `createQuotaHistoryHandlers(pool: Pool, now?: () => Date)` 返回 `admin(request, context)`、`display(request, context)` 两个 Promise<Response> 方法，context 为 `{ params: Promise<{id: string}> }`；`authorizeDisplayRequest(request: Request): Response | { headers: HeadersInit }` 和 `displayPreflight(request: Request): Response`；客户端 `parseQuotaHistory(value: unknown): QuotaHistoryDto`、`createQuotaHistoryLoader(options: { apiOrigin?: string; token?: string }): QuotaHistoryLoader`。

- [ ] **1. 编写失败测试。** mock 查询与主站鉴权，展示端沿用现有临时 Token 文件模式。固定同样的数据，检查两接口 DTO 完全一致；矩阵断言为 `200/400/401/403/404/503`，分别覆盖成功、非法/重复 range、无权限、来源拒绝、无效/停用/未知账号、服务故障；省略 range 得到 24h。认证失败不得执行历史查询。

  ```ts
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(JSON.stringify(body)).not.toContain('SECRET_CANARY');
  expect(preflight.status).toBe(204);
  expect(parseQuotaHistory(body)).toEqual(body);
  expect(() => parseQuotaHistory({ ...body, retentionDays: 91 })).toThrow();
  ```

  客户端同时拒绝非法日期、非有限百分比、非法余额文本及结构错误；接受巨大但合法的十进制余额字符串，绘图安全由任务 4 负责。请求用例检查同源 Cookie 行为和展示端 Authorization，signal 透传、15 秒超时、no-store、URL 账号编码、HTTP 错误与响应账号/范围不匹配。
- [ ] **2. 运行失败验证。** `npm test -- tests/unit/quota-history-api.test.ts tests/unit/quota-history-client.test.ts tests/unit/display-api.test.ts`。
- [ ] **3. 实现辅助函数、接口和客户端。** 抽取现有展示接口的来源判断、Token 和预检逻辑，原快照接口继续共享它们。历史 handler 先鉴权，再校验 id 与 range，再调用服务；错误只返回稳定错误码，不泄露数据库详情。Next 路由保留 `runtime='nodejs'`、`dynamic='force-dynamic'`，await params。客户端校验 DTO；余额值保持字符串，额度值为 0～100 的有限数字。
- [ ] **4. 重跑步骤 2。** 原展示 API 测试全部通过；无 Origin、允许 Origin、拒绝 Origin 及错误响应的 CORS 行为与原逻辑一致。
- [ ] **5. 提交。** 提交本任务文件，消息 `feat: expose authenticated quota history APIs`。

## 任务 4：可访问的 SVG 图表与按需加载区域

**文件：** 新建 `src/components/quota-history-chart.tsx`、`src/components/quota-history.tsx`、`src/components/quota-history.module.css`、`tests/unit/quota-history-chart.test.tsx`、`tests/unit/quota-history-panel.test.tsx`。

**消费：** 任务 2 的 `QuotaHistoryDto` 和 `QuotaHistoryLoader`。

**产出接口：** 默认组件 `QuotaHistoryChart({ history }: { history: QuotaHistoryDto })`；默认组件 `QuotaHistory({ accountId, loadHistory }: { accountId: string; loadHistory: QuotaHistoryLoader })`。

- [ ] **1. 编写失败测试。** jsdom 下验证标题、四种范围按钮、百分比及按币种分图、单点、空态和精确提示。图表 `breakBefore` 必须生成新路径起点，横轴坐标用真实时间。鼠标/触摸选择最近点，键盘左右切换点、Home/End 定位首末点，摘要通过可访问文本读取。

  ```ts
  expect(screen.getByText('所选时间范围内暂无额度历史')).toBeInTheDocument();
  expect(screen.getByText('0.00000001', { exact: true })).toBeInTheDocument();
  expect(svgMarkup).not.toMatch(/NaN|Infinity/);
  expect(requestSignal.aborted).toBe(true); // 改范围或卸载后
  expect(loader).toHaveBeenCalledTimes(2); // 初次 + 60 秒
  ```

  使用假定时器测试隐藏期间不发请求、显示后立即重取；延期 Promise 测试旧账号/旧范围迟到不覆盖新图；同范围重取失败保留旧图并标注“历史更新失败”，切换范围不展示旧范围数据。失败可重试，不显示 AbortError；刷新在途时不叠加同一请求。
- [ ] **2. 运行失败验证。** `npm test -- tests/unit/quota-history-chart.test.tsx tests/unit/quota-history-panel.test.tsx`。
- [ ] **3. 实现图表。** 使用 SVG 直线段，不做曲线平滑；百分比固定轴、余额按币种分组自适应，余额上下界相等时扩展显示范围。Number 转换非有限的值不参与几何绘制，提供“数值过大，无法绘图”与原值文本；转换仅用于坐标，Tooltip 使用原值。SVG 使用 viewBox，局部样式允许范围按钮换行，单个可聚焦图表控制键盘交互而非为每点创建 Tab 停靠位。
- [ ] **4. 实现请求区域。** 默认 24h，显示加载、空态、错误及重试；使用 AbortController 和请求代次防止过期结果提交。账号、范围或加载器身份改变时清空旧图并重取（包括 Token 改变）；同账号同范围同加载器的定时重取才保留旧图。监听 visibilitychange，隐藏立即停表并取消在途请求，恢复后重取。卸载清理定时器与监听；长范围显示“采样趋势”。
- [ ] **5. 重跑步骤 2。** 加入常量余额、巨大余额、全部无有效点的用例，确保图表没有无效坐标且文字信息可用。
- [ ] **6. 提交。** 提交本任务文件，消息 `feat: add accessible quota history charts`。

## 任务 5：共享额度详情接入双端

**文件：** 修改 `src/components/dashboard.tsx`、`src/components/quota-card.tsx`、`display/src/api.ts`、`display/src/App.tsx`、`tests/unit/pixel-dashboard.test.tsx`、`tests/unit/display-app.test.tsx`；按需修改 `tests/unit/quota-card.test.tsx` 保持独立卡片用例。

**消费：** 任务 3 的加载器工厂及任务 4 的 `QuotaHistory`。

**产出接口：** `DashboardProps` 和 `QuotaCardProps` 增加 `historyLoader?: QuotaHistoryLoader`。Dashboard 中未传加载器且非 readOnly 时选用模块级同源加载器；readOnly 时只采用显式传入的加载器。QuotaCard 仅在有加载器时挂载历史区域，按钮是否可写继续由原 readOnly 决定。

- [ ] **1. 编写失败测试。** 首页加载不触发历史查询，打开账号详情后请求该账号 24h；返回后 signal 已取消且没有后续历史轮询。现有卡片显式 readOnly 仍显示历史区域。展示端通过保存的 API 地址发 `/api/display/provider-accounts/<id>/history` 且携带 Token，修改 Token 后旧加载器结果不得继续展示。

  ```ts
  expect(historyLoader).not.toHaveBeenCalled(); // 打开详情之前
  expect(historyLoader).toHaveBeenCalledWith('a', '24h', expect.any(AbortSignal));
  expect(screen.queryByRole('button', { name: '刷新额度' })).toBeNull();
  expect(historyFetchesForStaticDemo).toHaveLength(0);
  ```

- [ ] **2. 运行失败验证。** `npm test -- tests/unit/pixel-dashboard.test.tsx tests/unit/display-app.test.tsx tests/unit/quota-card.test.tsx`。
- [ ] **3. 接入。** Dashboard 将选定加载器传给详情卡，历史放在当前指标后；以账号 id 作为历史组件 key，避免跨账号保留状态。展示端用 useMemo 按 origin/token 创建工厂结果并显式注入 readOnly Dashboard。静态 demo 不传加载器，显示“静态预览不提供额度历史”，不访问真实历史接口。
- [ ] **4. 重跑步骤 2 及任务 4 测试。** 核对组件既支持主站默认加载器，也支持外部快照和展示端的独立加载器；账号在快照中消失时历史组件卸载。
- [ ] **5. 提交。** 提交本任务文件，消息 `feat: connect quota history to dashboard and display`。

## 任务 6：双端浏览器验收与部署说明

**文件：** 新建 `tests/e2e/quota-history.spec.ts`；修改 `tests/e2e/web-server.ts`、`playwright.config.ts`、`docs/self-hosted-deployment.md`；复用 `tests/e2e/helpers.ts` 的登录流程。

**消费：** 完整双端 UI 与真实 history API。

- [ ] **1. 建立失败的验收用例。** 在现有临时数据库 schema 中播种 `history-e2e` 账号、quota_latest 和覆盖 90 天边界、连续采样、重置、缺失的历史。配置 Playwright 的第二个 webServer：`npm run display:dev -- --host 127.0.0.1 --port 3120 --strictPort`，就绪 URL `http://127.0.0.1:3120/display/`；现有 Next 服务 env 加入该展示来源白名单。展示测试通过 addInitScript 设置 display-api-origin 为测试 API 地址，使用已有测试 Token 打开 `/display/#token=...`。所有播种和 Token 限于测试环境。

  断言：登录后打开“额度历史”默认 24h，切换 90 天观察请求参数及正确响应；真实展示端 Token/CORS 请求成功；鼠标、触摸和键盘能查看点值；400×400 视口详情不横向溢出；返回后推进浏览器时钟 61 秒没有 history 请求。非法 Token 请求返回 401。大段缺失的折线确实断开，重置有对应真实采样值。
- [ ] **2. 运行验收验证。** `npm run test:e2e -- tests/e2e/quota-history.spec.ts`；失败先区分产品问题与 PostgreSQL/浏览器环境问题，修正后重跑受影响用例。
- [ ] **3. 补充部署说明。** 部署前执行现有 `npm run db:migrate` 流程应用 010，再更新主站和展示端；不要求回填。说明 worker 持续采集、每日清理、查询 90 天、停机缺失不可恢复、索引创建可能短暂影响写入；本任务不实际部署。
- [ ] **4. 完成验证。** 运行 `npm test`、`npm run test:integration`、`npm run typecheck`、`npm run build`、`npm run display:build`、`npm run test:e2e` 和 `git diff --check`。记录实际结果；依赖不可用时记录未验证项，不以静态检查替代。构建脚本会打包 collector，检查生成文件避免误提交无关产物。检查本地指南阅读及包锁文件无意外版本变化。
- [ ] **5. 提交与交付。** 提交本任务测试和文档，消息 `test: verify quota history across dashboard clients`；报告实现行为、测试结果和限制，不自动部署或创建 PR。

## 计划审阅与执行建议

推荐当前会话执行：任务依赖按查询 → 契约 → API → 图表 → 双端接入展开，共享接口较多，顺序实施便于保持口径一致。另可选择子代理逐任务实现与复核，成本更高。

本计划需用户审阅并选择执行方式后开始实现。实施前采用所选方式对应的 Superpowers 技能；当前会话方式在完成后按技能要求进行独立复核。无需在规划阶段创建 worktree 或运行产品测试。
