<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Codex 额度：运作方式与部署

## 账号模型

一个 Codex 账号 = 一个运行时目录 + 一条注册记录。

- 目录：`$CODEX_RUNTIME_ROOT/<accountId>/`(compose 中 `CODEX_RUNTIME_ROOT=/var/lib/dashboard-auth/codex`，即 `runtime-auth` named volume)。`accountId` 只允许 `[a-zA-Z0-9_-]{1,64}`，路径校验见 `src/server/providers/bootstrap.ts` 的 `accountRuntimeHome()`。
- 目录内唯一必需的凭据是 `auth.json`(codex CLI 的登录产物）:

```json
{ "auth_mode": "chatgpt",
  "tokens": { "access_token": "...", "refresh_token": "...", "account_id": "..." },
  "last_refresh": "..." }
```

- OAuth 令牌只存于该 volume；数据库和网页不保存令牌，数据库只存账号注册信息和额度快照。

## 额度读取链路

1. 调度器轮询账号 → `CodexQuotaStrategy.fetchSnapshot()`(`src/server/providers/codex/strategy.ts`)。
2. `bootstrap.ts` 按账号 id 算出目录并 `mkdir 0700`，构造 `CodexUsageApi(home)`(`src/server/providers/codex/usage-api.ts`)。
3. `CodexUsageApi` 读 `<home>/auth.json`，取 `tokens.access_token` / `tokens.account_id`，请求 `GET https://chatgpt.com/backend-api/wham/usage`，请求头：`Authorization: Bearer <access_token>`、`ChatGPT-Account-Id: <account_id>`。
4. 响应 `rate_limit.primary_window` / `secondary_window`（字段 `used_percent`、`limit_window_seconds`、`reset_at`，reset_at 可能是 Unix 秒或 ISO 字符串）被归一化为 `normalizeCodex()` 期望的 `{ rateLimits: { primary, secondary } }` 形状（`windowDurationMins = limit_window_seconds / 60`)。
5. 401 时用 `tokens.refresh_token` 刷新：`POST https://auth.openai.com/oauth/token`,`application/x-www-form-urlencoded`,字段 `client_id=app_EMoamEEZ73f0CkXaXp7hrann`、`grant_type=refresh_token`、`refresh_token`；成功后把新令牌**原子写回 auth.json**（临时文件 + rename,0600）并重试一次。因此 auth.json 对容器内 `node` 用户（uid/gid 1000）必须可写。
6. 失败语义：缺文件/缺字段/刷新被拒 → `AUTH_EXPIRED`（需重新登录）;403 → `FORBIDDEN`;429 → `RATE_LIMITED`（带 retryAfter)；超时 → `TIMEOUT`；响应结构变化 → `SCHEMA_CHANGED`。

注意：额度读取**不再 spawn `codex app-server`**（旧的 `codex/rpc.ts` 已删除）。网页设备码登录流程仍用 `login-rpc.ts` 的 app-server 路径，不要混淆两者。

## 注册账号

- 文件配置（自托管主推）:`private/provider-accounts.json`（只读 bind 挂载到 worker 的 `/run/config/`）加一条，改完**重启 worker** 生效：

```json
{ "id": "codex-personal", "providerId": "codex", "label": "Codex (ChatGPT)",
  "credentialRef": "managed-codex-login", "options": {} }
```

`id` 必须与目录名一致；`credentialRef` 对 codex 固定为 `managed-codex-login`（只是管理提示，不是 secret 文件）。
- 或网页"添加账号 → 登录 Codex"走设备码流程，账号入数据库。

## 部署 / 手动注入登录产物

适用于部署机无法直接用网页登录（例如无法直连 OpenAI）的场景：

```sh
# 1. 在能访问 OpenAI 的 shell(可经 mihomo 代理)生成凭据
mkdir -p /tmp/codex-auth/<accountId>
CODEX_HOME=/tmp/codex-auth/<accountId> HOME=/tmp/codex-auth/<accountId> codex login --device-auth

# 2. 放入 runtime-auth 卷(卷名以 docker volume inspect 为准)
V=/var/lib/docker/volumes/<project>_runtime-auth/_data
mkdir -p $V/codex/<accountId>
cp /tmp/codex-auth/<accountId>/auth.json $V/codex/<accountId>/
chmod 700 $V/codex/<accountId> && chmod 600 $V/codex/<accountId>/auth.json
chown -R 1000:1000 $V/codex/<accountId>   # 容器内 node 用户

# 3. provider-accounts.json 加条目,重启 worker;删除 /tmp/codex-auth
```

## 代理

worker 无法直连 OpenAI 时，在 `private/.env` 设 `WORKER_PROXY=http://<host>:<port>`（可选 `WORKER_NO_PROXY`，默认 `localhost,127.0.0.1,db`)。compose 会给 worker 注入 `NODE_USE_ENV_PROXY=1` 和 `HTTP(S)_PROXY/ALL_PROXY/NO_PROXY`,Node 24 的全局 fetch 自动走代理。容器内 `127.0.0.1` 指容器自身：代理在宿主机上时应让代理监听 docker 网桥地址（如 mihomo `allow-lan: true` + `bind-address: <bridge-gateway>`)，`WORKER_PROXY` 填该地址。

## 维护

- 新增账号：换 accountId 重复"手动注入"流程。
- 看板出现 `AUTH_EXPIRED`(refresh_token 失效）：对该账号重新手动登录并替换卷内 auth.json，注册条目不动。
- 不要把开发机的 `~/.codex` 复制进部署；每个账号用设备码独立授权。
