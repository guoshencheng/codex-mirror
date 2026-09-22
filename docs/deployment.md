# 部署手册：Vercel Web 与远程 Provider Runtime

Next.js Web/API 部署到 Vercel；托管 PostgreSQL 保存业务状态；独立 Docker Compose Provider Runtime 负责 Codex、DeepSeek、Kimi Code 额度查询。设备事件直接发送给 Vercel API，worker 不读取设备状态，也不依赖 Vercel Cron。Provider Runtime 每秒查询数据库中的到期额度任务，额度刷新成功后按约 5 分钟间隔调度；它不会轮询 Codex 进程或会话。

## 连接与配置边界

| 位置 | 环境变量或文件 | 用途 |
| --- | --- | --- |
| Vercel | `APP_ORIGIN` | 面板公开 HTTPS 来源，登录和 CSRF 校验使用 |
| Vercel | `DATABASE_URL` | 托管 PostgreSQL 的 serverless/pooler URL |
| Vercel | `DATABASE_SESSION_URL` | SSE 的 session-compatible URL，需支持 `LISTEN` 与 session advisory lock；限制每个函数实例的连接池为 6 |
| 发布/运维 shell | `DATABASE_DIRECT_URL` | 直连数据库，用于 migration、初始化 CLI、worker、备份和恢复 |
| Provider Runtime | `deploy/provider-accounts.json` | Provider 账号别名、策略 ID 和 secret 文件引用，不存放凭据 |
| Provider Runtime | `deploy/secrets/*` | DeepSeek API Key、Kimi server bearer token；容器只读挂载 |
| Provider Runtime | Docker named volume `codex-status-dashboard-provider-runtime-auth` | Codex 分账号登录目录及 Kimi Code 持久配置/授权 |

从 `.env.example` 复制出本地 `.env`，设置生产域名和数据库连接。`DATABASE_URL` 必须使用托管服务为 serverless/Web 推荐的 pooled URL；`DATABASE_SESSION_URL` 必须使用支持持久会话、`LISTEN` 和 session advisory lock 的连接（direct URL 或 session-mode pooler），供 Vercel SSE stream 使用；不能使用 transaction-mode pooler。`DATABASE_DIRECT_URL` 必须用 provider runtime、运维 shell 能访问的 direct URL，并按数据库服务要求启用 TLS。将 `APP_ORIGIN` 设为面板的精确 HTTPS origin，不带路径。不要把 worker 使用的 `DATABASE_DIRECT_URL` 配到 Vercel，也不要把 transaction pooler 配给 SSE 或使用 advisory lock 的 worker。

## Vercel 部署

1. 从 Git 导入仓库，Project Root Directory 保持仓库根目录，Framework 使用 Next.js 默认配置；仓库内的 `vercel.json` 已声明 `framework: nextjs`。不要设置 `output: standalone`，也不要把 Provider Runtime 当成 Vercel Function。
2. 在 Vercel 项目环境变量中配置 `APP_ORIGIN`、pooled `DATABASE_URL` 和 session-compatible `DATABASE_SESSION_URL`。登录/CSRF 校验严格匹配固定 `APP_ORIGIN`，不会动态信任请求的 `Host` 或 `VERCEL_URL`。Production 使用稳定的生产域名；Preview 需绑定稳定的 Preview/branch domain，并为 Preview 环境设置与其完全一致的 `APP_ORIGIN`。不要让每次部署变化的随机 URL 共用 Production origin，也不要设置 `NEXT_PUBLIC_*` 数据库或 Provider 凭据。
3. 将 Vercel Functions region 与托管数据库 region 对齐，减少数据库往返延迟。Region 需按实际数据库位置在 Vercel 项目设置中选择，本仓库不猜测具体区域。
4. 每次需要新增 schema 时，从受限的发布环境显式运行 `npm run db:migrate`，该命令使用 `DATABASE_DIRECT_URL`。不要把 migration 隐式放进 Web Function 冷启动。
5. 首次发布后访问 `https://<面板域名>/api/health`。它只返回 `{ "ok": true }`，用于进程存活探测，不回显数据库错误或环境变量。完成管理员初始化后，测试登录、设备上报和面板读取。

`vercel.json` 为流式 API 配置最多 60 秒单次执行时间，让浏览器有机会通过 SSE 自动重连。每个暖实例最多为 SSE/session 查询建立 6 个 session connections；托管数据库或 session pooler 需设置足够的并发连接预算。Vercel 函数不是常驻服务；额度刷新每 5 分钟由远程 Provider Runtime 完成，不建立 5 分钟 Vercel Cron。Vercel Cron 的频率依计划类型受限，且无论如何不应承载需要持久 CLI 登录目录的工作进程。

## Provider Runtime 准备

在受控 Linux 主机检出同一发布版本，安装 Docker Engine/Compose v2、PostgreSQL 客户端工具（`pg_dump`、`pg_restore`、`psql`）。`.env` 至少填写 `DATABASE_DIRECT_URL`、精确 CLI 版本；示例锁定 Codex CLI `0.146.0` 和 Kimi Code CLI `2.0.2`。构建运行时镜像时版本作为精确 npm 版本安装，不将授权文件复制到镜像层。Provider Runtime 使用官方支持的 `KIMI_CODE_NO_AUTO_UPDATE=1` 保持 Kimi 版本锁定；升级要先查看 Provider 官方 release notes，再更新 Compose 版本并重建镜像，还要对服务 API 合约做验证。

```sh
cp .env.example .env
chmod 600 .env
mkdir -p deploy/secrets
chmod 750 deploy/secrets
cp deploy/provider-accounts.example.json deploy/provider-accounts.json
chmod 640 deploy/provider-accounts.json
: > deploy/secrets/kimi-code-server-token
chmod 640 deploy/secrets/kimi-code-server-token
sudo chgrp -R 1000 deploy/secrets
sudo chgrp 1000 deploy/provider-accounts.json
find deploy/secrets -type f -exec chmod 0640 {} \;
```

创建 DeepSeek API Key 文件时关闭 shell tracing，并避免把 key 放在命令参数、shell 历史、环境变量或日志里：

```sh
umask 077
read -rsp 'DeepSeek API key: ' DEEPSEEK_API_KEY
printf '\n'
printf '%s' "$DEEPSEEK_API_KEY" > deploy/secrets/deepseek-primary-api-key
unset DEEPSEEK_API_KEY
chmod 400 deploy/secrets/deepseek-primary-api-key
sudo chgrp 1000 deploy/secrets/deepseek-primary-api-key
chmod 640 deploy/secrets/deepseek-primary-api-key
```

官方 Node 镜像内 `node` 用户使用 UID/GID 1000。配置与 secret 文件采用 owner 可写、GID 1000 可读的 `0640`，secret 目录 `0750`，让 worker 读取但不能写入。根据主机权限调整 `sudo` 命令；不要为了容器读取而将 secret 设成 world-readable。

`credentialRef` 是相对于 `/run/secrets` 的文件名。`codex-personal` 的 `credentialRef` 只是管理登录提示，不是 secret 文件；Codex CLI 授权目录使用账号 ID 隔离，位于持久卷 `/var/lib/dashboard-auth/codex/<account-id>`。可在 `provider-accounts.json` 增删账号条目；修改后只需重启 worker 使配置重新载入。

### 初始化 Codex 和 Kimi Code 登录

先运行 runtime，容器内的 Kimi Web server 只绑定 `127.0.0.1:58627`，Compose 不映射任何端口：

```sh
docker compose --env-file .env -f deploy/compose.provider-runtime.yaml up -d --build
```

每个 Codex 账号使用单独的持久 `CODEX_HOME`。账号 ID 必须与 accounts JSON 中相同：

```sh
docker compose --env-file .env -f deploy/compose.provider-runtime.yaml exec -it \
  -e CODEX_HOME=/var/lib/dashboard-auth/codex/codex-personal \
  -e HOME=/var/lib/dashboard-auth/codex/codex-personal \
  worker codex login
```

按 Codex CLI 登录流程在远端完成 ChatGPT 授权。不要把开发机 `~/.codex`、OAuth 数据库或授权文件复制到服务器。

Kimi 使用官方 `@moonshot-ai/kimi-code` CLI。先以 `node` 用户完成 OAuth 登录，授权目录位于运行时 named volume：

```sh
docker compose --env-file .env -f deploy/compose.provider-runtime.yaml exec -it -u node \
  -e HOME=/var/lib/dashboard-auth/kimi -e KIMI_CODE_NO_AUTO_UPDATE=1 worker kimi login
```

Kimi 的本地 Web API token 由 `kimi web rotate-token` 写入 `~/.kimi-code/server.token`。accounts JSON 引用的 secret 文件应包含同一 token。以下命令把 rotate-token 的所有输出丢弃，通过受限临时文件接收 token，再写入 Compose 只读挂载的主机文件；不会把 token 打到终端或 Docker 日志。部署前已在 `deploy/secrets` 创建该空文件；同一个 Compose volume 提供给 worker 和初始化命令：

```sh
(
umask 077
token_file="$(mktemp)"
chmod 600 "$token_file"
cleanup_token_file() { rm -f "$token_file"; }
trap cleanup_token_file EXIT
if docker compose --env-file .env -f deploy/compose.provider-runtime.yaml run --rm --no-deps -T \
  -e HOME=/var/lib/dashboard-auth/kimi --entrypoint sh worker \
  -c 'KIMI_CODE_NO_AUTO_UPDATE=1 kimi web rotate-token >/dev/null 2>&1 && cat "$HOME/.kimi-code/server.token"' > "$token_file"; then
  test -s "$token_file"
  cat "$token_file" > deploy/secrets/kimi-code-server-token
  chmod 640 deploy/secrets/kimi-code-server-token
  sudo chgrp 1000 deploy/secrets/kimi-code-server-token
else
  printf 'Kimi token initialization failed; inspect status without printing secret data.\n' >&2
  exit 1
fi
rm -f "$token_file"
)
```

不要删掉或重建挂载中的 token 文件：容器必须能挂载该文件，主机原位写入会更新已挂载文件的内容。重新轮换 token 后，旧 token 会立即失效；确保本地文件和运行中的 server 使用相同 token。secret 目录不得上传到 Git、镜像仓库、工单或日志。

### 启动、迁移与检查

在 Vercel 第一次接收请求前，从受限发布环境执行 migration 和管理员初始化：

```sh
set -a
. ./.env
set +a
npm ci
npm run db:migrate
npm run admin:create
npm run device:create -- 'MacBook Pro'
```

`admin:create` 密码使用隐藏终端输入；`device:create` 只显示一次设备 token。将 token 安全配置到每台采集端，不要粘贴到截图、聊天或日志。worker 日志不显示上游响应正文和凭据；Compose 也限制日志轮替。可用以下命令查看服务是否运行：

```sh
docker compose --env-file .env -f deploy/compose.provider-runtime.yaml ps
docker compose --env-file .env -f deploy/compose.provider-runtime.yaml logs --tail=100 worker
```

本地 CLI 自检只报告策略状态与错误代码：

```sh
npm run providers:probe -- --provider codex
npm run providers:probe -- --provider deepseek
npm run providers:probe -- --provider kimi-code
```

## 备份与恢复

备份包含 PostgreSQL 自定义格式 dump、Provider 配置与 secret 文件，以及整个 Codex/Kimi 授权卷。它包含可登录凭据，必须存入加密磁盘或受控加密备份目的地。脚本使用 `umask 077`，输出只允许当前主机用户读取，拒绝在代码 checkout 内写备份。建议安排与数据库服务 PITR/快照配合的定期备份；不要只保留一份本机归档。

主机安装 `pg_dump`/`psql`，在受限运维 shell 中通过 secret manager 提供 `DATABASE_DIRECT_URL` 和外部 `BACKUP_DIR`，再运行：

```sh
BACKUP_DIR=/mnt/encrypted-backups/codex-dashboard \
  scripts/backup.sh
```

脚本短暂停止运行中的 Provider Runtime，以便授权卷文件稳定；数据库 dump 使用 PostgreSQL 一致性快照，设备事件仍可继续进入 Vercel/API。结束时脚本会尝试恢复 worker。归档解密密钥和授权人员应与运行主机分离管理。

恢复必须先创建一个全新、空的隔离数据库，名称以 `_restore`、`_test` 或 `_staging` 结尾。恢复脚本要求显式确认；它检查目标无应用表，使用单事务导入且不执行 `--clean` / `DROP DATABASE`，最后核对数据库中迁移版本与当前 checkout 完全一致。运行用户需能读写目标 DB。配置与授权文件只解压到一个新的受限目录，脚本不会覆盖生产配置或挂载正在运行的 volume：

```sh
RESTORE_DATABASE_DIRECT_URL='postgresql://.../dashboard_restore?sslmode=require' \
RESTORE_CONFIRM=restore-into-isolated-empty-database \
RESTORE_OUTPUT_DIR=/mnt/restore-check/provider-runtime \
  scripts/restore.sh /mnt/encrypted-backups/codex-dashboard/codex-status-dashboard-<timestamp>.tar.gz
```

恢复目标中应能查询既有设备、会话、账号和额度快照。手工检查隔离目录中的配置与授权，再按受控运维变更将其挂载到新的 Provider Runtime。恢复输出与源归档同样包含秘密，应限制访问并在验证结束后按保留策略销毁。

## 限制和官方资料

- Codex CLI 安装方式及账号授权参考 [OpenAI Codex CLI 官方说明](https://github.com/openai/codex#quickstart)。镜像以官方 npm 包 `@openai/codex` 安装。
- Kimi Code CLI 已使用当前的 [Kimi Code CLI 安装指南](https://moonshotai.github.io/kimi-code/en/guides/getting-started) 与 [命令参考](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)，没有沿用已归档的旧 `kimi-cli` 安装文档。官方文档确认 `kimi web --no-open --host 127.0.0.1` 与持久 token 文件路径。
- 镜像关闭 Kimi CLI 自动更新以保证锁定版本；参考官方 [Kimi Code 环境变量文档](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html)。
- [Kimi Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html) 标记为 experimental，虽然列出 `/api/v1/oauth/usage` 和 usage schema，仍需在目标远程 Linux Runtime 上验证精确版本、真实 Kimi Code OAuth、server bearer token、挂载路径和响应合约。该真实账号探测目前为 **NOT_RUN**。
- Vercel 的 [静态项目配置](https://vercel.com/docs/project-configuration/vercel-json)、[Function duration](https://vercel.com/docs/functions/configuring-functions/duration) 与 [Cron 使用限制](https://vercel.com/docs/cron-jobs/usage-and-pricing) 解释了本项目为何让 Vercel 承担请求、事件 API 与 SSE，而让独立常驻 Runtime 调度 5 分钟额度刷新。

真实 Vercel 项目、托管数据库账户、Provider 主机和远端 Provider 账号未在此提交中创建或验证；见 [部署验收记录](./acceptance.md)。
