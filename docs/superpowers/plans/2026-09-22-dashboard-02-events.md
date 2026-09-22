# Device Event Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过事件准确汇总多设备 Codex 执行情况，支持断网补报与安全接收。

**Architecture:** Hook 写入本地 SQLite 持久队列，采集器异步上传并发送心跳。Next.js Route Handlers 校验设备身份和事件协议，通过 PostgreSQL 事务按流归约，读模型区分最后状态与可信度。

**Tech Stack:** TypeScript、Node.js 24 LTS、Next.js App Router、Zod、pg、better-sqlite3、Vitest。

**Spec:** [设计](../specs/2026-09-22-codex-status-dashboard-design.md) §4–7；[执行索引](2026-09-22-codex-status-dashboard.md)。前置 P1-T1 工程与 P1-T4 数据库迁移基础。

## Global Constraints

- 各设备的 Codex 执行状态必须由事件上报驱动，不轮询进程、任务列表、会话文件或 UI 来判断执行情况。
- Provider 额度由远程服务自行获取；设备端不查询、不转发额度。
- 队列默认限制为 100 MB，容量耗尽须记录采集健康错误及缺失标记，不静默删除事件。
- 采集器每 20 秒发送一次心跳，仅证明采集器连接正常。
- 超过 60 秒显示连接过期，超过 120 秒显示离线；不将任务改成空闲。
- 工作状态持续 10 分钟没有事件时标记“执行状态未确认”，而不是判定失败。
- 默认保留事件 30 天。

## Review Focus

1. Hook 并发、磁盘满、采集器崩溃：durable ack 前不删除，缺失明确可见。T2。
2. 乱序、重复、相同 ID 不同载荷：不静默覆盖。T1/T3。
3. 旧 turn/旧 epoch 补报：不得回退新会话。T1/T3。
4. 时钟漂移、设备重装、30 天清理：序列不依赖时间，不因删除 dedup 记录重放。T3。
5. 设备冒充、请求过大、原始工具数据泄露：认证绑定设备与字段白名单。T2/T3。

### Task 1: Event Protocol and Pure State Reducer

**Files:** 新建 `src/contracts/events.ts`、`src/server/events/reducer.ts`、`src/server/events/freshness.ts`、`tests/unit/event-reducer.test.ts`、`tests/unit/event-schema.test.ts`。

**Interfaces:**

```ts
export type EventType = 'session.started' | 'turn.started' | 'tool.started'
  | 'tool.finished' | 'approval.requested' | 'turn.stopped'
  | 'turn.interrupted' | 'session.ended';
export interface AgentEvent {
  schemaVersion: 1;
  eventId: string; deviceId: string; collectorEpoch: string;
  sequence: number; sessionId: string; turnId: string | null;
  type: EventType; occurredAt: string;
  metadata: { projectKey?: string; projectName?: string; title?: string; toolName?: string };
}
export interface SessionState {
  state: 'IDLE' | 'WORKING' | 'WAITING_APPROVAL' | 'STOPPED' | 'INTERRUPTED' | 'ENDED' | 'UNKNOWN';
  turnId: string | null; lastSequence: number;
  lastEventAt: string; lastReceivedAt: string;
  confidence: 'confirmed' | 'unconfirmed'; currentTool: string | null;
}
export function reduceSession(previous: SessionState | null, event: AgentEvent, receivedAt: string): SessionState;
export function deriveFreshness(input: {
  state: SessionState; heartbeatAt: string | null; now: string; streamIncomplete: boolean;
}): { connection: 'online'|'stale'|'offline'; confidence: 'confirmed'|'unconfirmed' };
```

`events.ts` 导出严格 Zod `agentEventSchema` 和类型。sequence 为 1..MAX_SAFE_INTEGER，字符串长度上限 device/session/event/epoch=128，title/projectName=160，toolName=120，occurredAt 必须含时区。未列字段拒绝；整个单事件 <=8 KB。

- [ ] **Step 1：写状态测试（事件构造 helper 放在同一个测试文件）。**

```ts
const at = '2026-09-22T00:00:00Z';
const event = (sequence: number, type: EventType, turnId = 't1'): AgentEvent => ({
  schemaVersion: 1, eventId: `e${sequence}`, deviceId: 'd1', collectorEpoch: 'epoch1',
  sequence, sessionId: 's1', turnId, type, occurredAt: at, metadata: {},
});
it('does not end a new turn on a delayed old-turn Stop', () => {
  const first = reduceSession(null, event(1, 'turn.started'), at);
  const next = reduceSession(first, event(2, 'turn.started', 't2'), at);
  const late = reduceSession(next, event(3, 'turn.stopped', 't1'), at);
  expect(late.state).toBe('WORKING');
  expect(late.turnId).toBe('t2');
});
it('Stop means stopped, not project success', () => {
  const running = reduceSession(null, event(1, 'turn.started'), at);
  expect(reduceSession(running, event(2, 'turn.stopped'), at).state).toBe('STOPPED');
});
it('heartbeat cannot confirm silent execution', () => {
  const state = reduceSession(null, event(1, 'turn.started'), at);
  expect(deriveFreshness({ state, now: '2026-09-22T00:11:00Z',
    heartbeatAt: '2026-09-22T00:11:00Z', streamIncomplete: false }))
    .toEqual({ connection: 'online', confidence: 'unconfirmed' });
});
```

- [ ] **Step 2：运行** `npm test -- tests/unit/event-reducer.test.ts tests/unit/event-schema.test.ts`，确认红灯。
- [ ] **Step 3：实现纯归约。**

```ts
const transitions: Record<EventType, SessionState['state']> = {
  'session.started': 'IDLE', 'turn.started': 'WORKING',
  'tool.started': 'WORKING', 'tool.finished': 'WORKING',
  'approval.requested': 'WAITING_APPROVAL', 'turn.stopped': 'STOPPED',
  'turn.interrupted': 'INTERRUPTED', 'session.ended': 'ENDED',
};
```

sequence <= lastSequence 原样返回。不同 turnId 的工具/停止/中断事件只能记录收到，不改变当前状态和 currentTool；只有 turn.started 切换 active turn。缺失 turnId 的终止事件在已有活跃 turn 时保守标记 unconfirmed，不终止新 turn。首次收到工具或审批可建立会话，但因为缺少开始事件 confidence=unconfirmed，后续明确 turn.started 才确认。相同 turn 的迟到 session.started 不重置正在工作的状态。服务端 lastReceivedAt 用于新鲜度，occurredAt 只展示，避免未来设备时间维持永久在线。

- [ ] **Step 4：扩展测试。** 遍历状态表；60/120/600 秒边界；Future occurredAt；null 心跳；重复序号；缺失 turnId；首次工具事件；session.started 迟到；审批后工具继续；工具失败仅 tool.finished。纯归约不用数据库/计时器。
- [ ] **Step 5：通过 tests/typecheck 后提交** `feat: define event protocol and conservative session reducer`。

### Task 2: Local Queue, Hook Adapter, and Uploader

**Files:** 新建 `collector/src/cli.ts`、`queue.ts`、`hook.ts`、`uploader.ts`、`heartbeat.ts`、`project.ts`、`install.ts`、`tests/unit/collector-queue.test.ts`、`tests/unit/collector-hook.test.ts`、`tests/unit/collector-upload.test.ts`、`docs/collector-install.md`。

**Interfaces:** `openQueue(path, maxBytes=100_000_000)` 返回 `append(eventWithoutIds): AgentEvent`、`peek(limit): AgentEvent[]`、`ack(epoch, contiguousSequence): void`、`health()`、`close()`；sequence/epoch/deviceId 由队列补齐。`normalizeHook(raw): Omit<AgentEvent,'eventId'|'sequence'|'collectorEpoch'|'deviceId'>|null`；`uploadOnce(queue, transport): Promise<void>`；`collector hook` 从 stdin 读 JSON，`collector run` 运行上传和心跳，`collector install --dry-run` 展示合并后的 Hook 配置。

- [x] **Step 1：安装 SQLite 依赖并写队列/重试测试。** 使用 better-sqlite3 精确版本，开发类型加入 lockfile；不把原生模块打包进 JS，tsup 标记 external。

```ts
it('retains identical IDs until contiguous acknowledgment', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'collector-')), 'queue.sqlite');
  let queue = openQueue(path);
  const first = queue.append({ sessionId: 's', turnId: 't', type: 'turn.started',
    occurredAt: '2026-09-22T00:00:00Z', schemaVersion: 1, metadata: {} });
  queue.close(); queue = openQueue(path);
  const send = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ epoch: first.collectorEpoch, acknowledgedThrough: first.sequence });
  await expect(uploadOnce(queue, send)).rejects.toThrow('offline');
  expect(queue.peek(100)[0].eventId).toBe(first.eventId);
  await uploadOnce(queue, send);
  expect(queue.peek(100)).toEqual([]);
  queue.close();
});
```

- [x] **Step 2：运行** collector 三个定向测试文件，确认红灯。
- [x] **Step 3：实现 SQLite 队列。**

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=200;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending (
  sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL
);
```

append 在 BEGIN IMMEDIATE 内分配单调 sequence、UUID eventId、写入 payload 和累计字节，commit 后返回。并发 Hook 使用同一库；busy 超时不拖住主任务，在独立小型 health 文件原子记录 eventLoss=true。100 MB 同时检查逻辑待传量和数据库/WAL 实际占用；checkpoint 增量回收，达到上限拒绝新事件并报告，不删除未 ack 事件。epoch 在正常重启保持不变；仅清空/重装队列才创建新 epoch。磁盘满时尽力 stderr 输出固定安全错误，Hook exit 0 以免影响 Codex。

- [x] **Step 4：实现 Hook 白名单、项目归一化和安装。** stdin 上限 1 MB，本地提取允许字段后原始数据立即丢弃；未知 Hook 名返回 null。按设计状态表映射，工具响应和命令正文不入队。Git remote 只在首次遇到 cwd 时用参数数组查询并缓存，移除 username/password/query/fragment；scp 和 HTTPS remote 规范化同一个 host/path，去 `.git`。无 remote 用 SHA-256(deviceId+realpath(cwd))；不上传完整路径。

```ts
const hookTypes = {
  SessionStart: 'session.started', UserPromptSubmit: 'turn.started',
  PreToolUse: 'tool.started', PostToolUse: 'tool.finished',
  PermissionRequest: 'approval.requested', Stop: 'turn.stopped',
  Interrupt: 'turn.interrupted', SessionEnd: 'session.ended',
} as const;
```

安装器先检查目标版本支持的 Hook schema，合并用户现有配置并备份；只改自己标记的 hook 项，重复安装不重复，卸载只移除自己项，不静默覆盖其他 Hooks。事件 Hook 只做有上限的本地 SQLite 写入，使用同步处理来保持事件序列顺序；绝不在 Hook 中联网或返回审批决定。`SessionEnd` 始终同步，Hook 输出不得带提示词或工具内容；`Stop` 始终返回 `{"continue":true}`。安装后提示用户在 `/hooks` 审查并信任。macOS 提供用户 launchd，Linux 提供 systemd --user；含空格路径必须正确参数化。

- [x] **Step 5：实现上传和健康心跳。** 只访问配置的 HTTPS 服务，同一 epoch 按序批量 <=100 条/256 KB；只有服务端返回匹配 epoch 和 <=已发送范围的连续 ack 才删除。网络失败 1 秒至 60 秒抖动退避；401/403 暂停上报并保留队列。413 自动缩小批次，单条协议拒绝不跳过，标记受阻。心跳每 20 秒发送 epoch、queueDepth、eventLoss，不读进程或会话。

重连握手增加 `bootId`（每次采集器启动随机生成）与 `queuedThrough`（此时本地最大序号）。首次联网、bootId 变化或服务端已判离线时，先发心跳注册恢复水位，再上传积压事件；这些历史事件可以更新最后已知状态，但不能重新确认活跃执行。只有恢复水位之后的新事件可以确认状态，防止旧 WORKING 补报被误认为现在仍在工作。心跳失败则继续留队，不提前上传恢复流。

- [x] **Step 6：补齐队列上限、并发写、ack 越界、假 server ack、安装幂等和脱敏测试；提交** `feat: add durable event-only device collector`。临时 Hook CLI/SQLite 集成测试已通过；尚未在 Linux 主机和用户实际 Codex 会话中安装验证。没有修改现有 Codex Hook 配置。

### Task 3: Next.js Ingest Routes, Ordered Streams, and Device Registration

**Files:** 新建 `migrations/002-events.sql`、`src/server/events/ingest.ts`、`device-auth.ts`、`heartbeat.ts`、`src/app/api/agent/events/route.ts`、`src/app/api/agent/heartbeat/route.ts`、`scripts/create-device.ts`、`scripts/revoke-device.ts`、`tests/integration/event-ingest.test.ts`、`tests/integration/device-auth.test.ts`。

**Interfaces:** `authenticateDevice(request): Promise<{id:string}|null>`；`ingestBatch(deviceId, events): Promise<{epoch:string,acknowledgedThrough:number}>`；`recordHeartbeat(deviceId, body, receivedAt): Promise<void>`。batch 不允许混合 epoch，不接受 body 决定认证身份。

- [ ] **Step 1：写真实数据库乱序测试。** 使用 P1 的 withTestDb，新增 `seedDevice(id)` 和 `readSession(deviceId, sessionId)` 包装本任务 SQL；事件 helper 沿用 P2-T1 形状。

```ts
it('buffers gaps, deduplicates retries, rejects identity spoofing', async () => {
  await withTestDb(async db => {
    await db.seedDevice('d1');
    const first = event(1, 'turn.started');
    const stop = event(2, 'turn.stopped');
    expect((await db.ingest('d1', [stop])).acknowledgedThrough).toBe(0);
    expect((await db.ingest('d1', [first])).acknowledgedThrough).toBe(2);
    expect((await db.readSession('d1', 's1')).state).toBe('STOPPED');
    await db.ingest('d1', [first, stop]);
    expect(await db.eventCount('d1')).toBe(2);
    await expect(db.ingest('d1', [{ ...first, deviceId: 'd2' }])).rejects.toThrow('DEVICE_MISMATCH');
  });
});
```

- [ ] **Step 2：运行** 本任务两个 integration 测试，确认红灯。
- [ ] **Step 3：建事务表。** devices 包括 token_hash、revoked_at、last_heartbeat_at；device_streams 唯一 `(device_id,epoch)`，保存 contiguous_sequence、active、incomplete 和 generation；sessions 唯一 `(device_id,session_id)`，保存 active generation 与 SessionState；agent_events 对 eventId 和 `(device_id,epoch,sequence)` 分别唯一，并存 canonical payload hash。另建 projects 和 device_account_links，外键到现有 provider_accounts。

```sql
-- 每个 ingest 事务锁定设备行，使新 epoch 和事件接收串行
SELECT id FROM devices WHERE id = $1 AND revoked_at IS NULL FOR UPDATE;
-- sequence 大于水位时存事件，payload hash 冲突则整个批次 409
-- 从水位 + 1 开始，连续消费已存记录；中间缺口不越过
-- 在同一事务更新 sessions / contiguous_sequence
-- 浏览器在页面可见时轮询 dashboard 快照，不需要 PostgreSQL NOTIFY
```

epoch 切换：已知 retired epoch 只允许返回旧水位，不重激活；未知新 epoch 由首次心跳或上报注册并增加设备 generation，旧会话标 unconfirmed。旧 generation 永远不能覆盖新 generation 状态。保留每个 stream 的水位和 retired 标记，即使 30 天事件已清理，也不重放 sequence<=水位的记录；相同 eventId 不同 payload 在保留期内 409。queueLost 通过心跳显式标 incomplete，不能自动填补缺失。设备重装需新注册 token/deviceId，避免克隆 queue 引起流混乱。

恢复水位保存到 device_streams；bootId 变化或离线恢复将关联活跃会话 confidence 标为 unconfirmed，sequence<=queuedThrough 的补报不解除该标记。测试“设备离线后补报十分钟前 WORKING，心跳恢复，但没有新执行事件”仍为未确认；恢复水位之后收到新 turn.started 才确认。

session/project/title 的字符串按长度限制存储，标题只作为文本输出。离线补报不会用旧 occurredAt 把设备显示在线；接收时间与事件时间分别保留。集成测试涵盖 epoch A→B→A、清理后重放和设备时钟偏移。

- [ ] **Step 4：实现 Route Handlers 与设备初始化。**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// POST: authenticateDevice -> bounded body read -> Zod parse -> ingestBatch -> Response.json
// 成功响应 Cache-Control: no-store；事务 commit 前不返回 ack。
```

request body 流式计数上限 256 KB，反向代理同样限制；Zod errors 返回字段路径不回显值。无/错误/撤销 token 401/403；畸形 400，冲突 409，过大 413。token 为随机 32 字节，数据库保存 SHA-256（高熵 token 无需密码 hash）；CLI 只在创建时显示一次，日志不记录。设备 token 只授权 agent 路径。每设备速率限制 10 请求/秒、突发 20，服务端持久/事务计数窗口，429 提供 Retry-After；正常批量上报远低于此限制。

- [ ] **Step 5：运行协议/队列/事务/认证测试，提交** `feat: ingest device events through Next.js routes`。阶段演练断网、重新上线及采集器重启，验证相同事件重传不重复应用；通过 SQL 检查状态，浏览器将在 P3 完成。
