# 自托管部署：codex-status.icerock.top

当前部署使用 `/opt/codex-status-dashboard/app` 中的 `deploy/compose.self-hosted.yaml`，私有配置位于 `/opt/codex-status-dashboard/private`。数据库、Web/API、Provider Runtime 与独立展示页分开运行。Web/API 仅监听服务器 `127.0.0.1:3100`，展示页仅监听 `127.0.0.1:3101`，数据库只在 Compose 内网开放。

## 1Panel 站点与证书

在 1Panel 创建 `codex-status.icerock.top` 的 HTTPS 站点并配置证书，然后设置两个反向代理：

| 公开路径 | 上游 | 要求 |
| --- | --- | --- |
| `/display/` | `http://127.0.0.1:3101` | 保留原始路径；包含静态资源请求 |
| `/` 及其他路径 | `http://127.0.0.1:3100` | 传递原始 Host、协议和请求路径 |

`/display/` 规则必须先于 `/`。如果 1Panel 的代理路径会删掉前缀，请改用保留 `/display/` 的规则；否则展示页资源会返回 404。完成后访问 `https://codex-status.icerock.top/api/health` 和 `https://codex-status.icerock.top/display/`。展示页默认使用这一 HTTPS API origin，也可在“连接设置”中指定其他 HTTPS API 地址；跨域来源需加入 Web 的 `DASHBOARD_DISPLAY_ORIGINS` 配置并重启 Web。

## 管理和 Token

服务器私有文件 `private/user-token` 存放唯一全局用户 Token，文件权限为 0640，属组为容器中的 `node` 用户（GID 1000）。登录管理页面或连接独立展示页时使用同一 Token；持有它的人同时拥有管理权限。不要将其写入 1Panel 公共环境、前端构建配置或代码仓库。轮换时原位更新该文件中的 `cdu_` 加 43 位 base64url Token，保持原有属组和权限；旧管理会话将失效。展示页在浏览器会话存储中保存 Token，关闭会话后需重新输入。

每台设备继续拥有独立随机 deviceId 与设备 Token；服务端数据库仅保存设备 Token 的 SHA-256 哈希。迁移已有设备时需先恢复原数据库和相应的设备 Token 哈希，不能仅复制全局用户 Token。更换服务 URL 后，采集器可通过现有迁移流程验证旧设备身份并切换上报地址。

`private/.env` 中的 `PROVIDER_CREDENTIAL_KEY` 用于解密数据库中的 DeepSeek/Kimi API Key，必须连同数据库备份长期保存。`private/provider-accounts.json` 和 `private/secrets/` 管理文件配置的 Provider；Web 新增的管理账号由 worker 自动刷新。Codex/Kimi CLI 授权位于 Compose 的 `runtime-auth` 卷。

worker 的 Codex 额度读取直接请求 ChatGPT 用量 API（`chatgpt.com/backend-api/wham/usage`），凭据为账号目录中的 `auth.json`，访问令牌过期时由 worker 自行刷新。若部署机无法直连 OpenAI，在 `private/.env` 设置 `WORKER_PROXY=http://<代理地址>:<端口>`（可选 `WORKER_NO_PROXY`，默认 `localhost,127.0.0.1,db`），worker 的全部出站 HTTPS 会经该代理；代理只作用于 worker 容器，宿主机与其他容器不受影响。

### 在看板中添加 Codex 账号

管理员登录后打开“面板菜单 → 添加账号 → 登录 Codex”，输入账号名称并开始登录。看板显示 OpenAI 官方验证网址和一次性代码；在新窗口完成 ChatGPT 授权后，worker 会读取额度并把账号加入看板。此流程使用 ChatGPT 套餐的 Codex 登录，凭据只存于 worker 的 `runtime-auth` 卷，网页和数据库不保存 OAuth 令牌。

使用前需在个人 ChatGPT 安全设置或工作区权限中启用设备码登录。若页面提示设备码登录不可用，请检查该开关；也可继续使用下方“CLI 登录”方式配置文件管理的账号。登录请求约 10 分钟后过期，失败或过期时可重新开始。更新部署时迁移服务会创建 `codex_login_requests` 表。

## 日常命令

以下命令在服务器上执行：

```sh
cd /opt/codex-status-dashboard/app
docker compose --env-file ../private/.env -f deploy/compose.self-hosted.yaml ps
docker compose --env-file ../private/.env -f deploy/compose.self-hosted.yaml logs --tail=100 web worker
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:3101/display/ >/dev/null
```

更新源码后执行 `docker compose --env-file ../private/.env -f deploy/compose.self-hosted.yaml up -d --build --remove-orphans`；迁移服务先运行，再启动 Web 和 worker。Token 和数据库密码不会随源码更新覆盖。

备份至少包含 PostgreSQL `database` 卷或一致性 `pg_dump`、`private/` 目录和 `runtime-auth` 卷；把加密备份存到服务器之外。公开 HTTPS 的最终验收需在 1Panel 站点和证书完成后进行。
