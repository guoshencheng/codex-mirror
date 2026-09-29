# 自托管部署：codex-status.shemu.top

Web/API 与 worker 以 PM2 进程运行在服务器(tt,180.184.45.232)宿主机上,构建在 GitHub Actions 完成;PostgreSQL 与展示页 nginx 保持容器化(服务器不构建镜像)。数据库在 Compose `database` 卷,授权与登录产物在宿主机 `/opt/codex-status-dashboard/runtime-auth/`。Web 监听 `127.0.0.1:3100`,展示页 nginx 监听 `127.0.0.1:3101`,数据库映射 `127.0.0.1:5432` 供宿主进程连接。私有配置位于 `/opt/codex-status-dashboard/private`。

改为 CI 构建的原因:服务器访问 npm registry 不稳定,服务器侧 Docker 构建经常失败。现在服务器只安装/复用依赖,不构建。

## 架构与目录

| 组件 | 运行方式 | 说明 |
| --- | --- | --- |
| web | PM2 `dashboard-web`,`next start -H 127.0.0.1 -p 3100` | `.next` 与 collector 安装包来自 CI 产物 |
| worker | PM2 `dashboard-worker`,`tsx src/worker/provider-runtime.ts` | codex/kimi CLI 全局安装于宿主机 |
| display | docker nginx(不构建),bind 挂载 active release 的 `dist-display` | 1Panel 反代不变 |
| db | docker postgres,`127.0.0.1:5432:5432` | 数据卷沿用原 Compose `database` |
| migrate | 部署激活时一次性执行 `tsx scripts/migrate.ts` | 替代原 migrate 容器 |

- release 目录:`/opt/codex-status-dashboard/pm2-releases/<commit>-run<id>-a<n>`,由 CI 上传解包,原子切换。
- PM2 ecosystem:`/etc/codex-status-dashboard/ecosystem.config.cjs`(0600,含秘密,由激活脚本生成,不要手改)。
- PM2 使用 `/opt/node-v24.21.0-linux-x64`,进程以 root 运行。
- `deploy/self-hosted/activate.mjs` 是激活脚本:写 display 指针 → 起边缘容器 → 跑迁移 → 重写 ecosystem → `pm2 startOrReload` + `pm2 save` → 等健康检查。

## CI 部署(日常更新唯一入口)

工作流 `.github/workflows/deploy-self-hosted.yml`,在 GitHub 页面手动触发(Actions → "Build and deploy self-hosted dashboard" → Run workflow,仅 main)。每次部署的完整流程:

1. **CI 构建**(GitHub runner,Node 24.21.0 x86_64):`npm ci` → 单测 + typecheck → `npm run build`(prebuild 自动产出 `public/collector/` 采集器安装包)→ `npm run display:build`。
2. **打包**:整个仓库打成 `codex-dashboard-release.tar.gz`,排除 `node_modules`、`.next/cache`、`tests`、`docs` 等;断言 `.next/BUILD_ID`、`public/collector/collector.tar.gz`、`dist-display/index.html` 在包内;生成 sha256。
3. **上传**:经部署密钥 SSH/SCP 到服务器 `/var/tmp/codex-status-deploy/<release-id>/`。
4. **服务器侧安装依赖**:校验 sha256 后解包到 `pm2-releases/<release-id>.extracting`,然后**每次都在服务器完整执行 `npm ci`(经 mihomo 代理 `http://172.22.0.1:7890`,带内存上限),不复用旧 node_modules、不做指纹对比**;依赖树由包内 `package-lock.json` 决定,与 CI 上的安装结果一致。服务器只装依赖,不构建。
5. **激活**:原子 `mv` 成正式 release 目录,执行 `deploy/self-hosted/activate.mjs`——起边缘容器 → 跑数据库迁移 → 重写 PM2 ecosystem → `pm2 startOrReload` + `pm2 save` → 等 `/api/health` 与 display 健康;任一失败则非零退出,线上旧进程不受影响。
6. **公网校验**:CI 最后确认 `https://codex-status.shemu.top/api/health` 与 `/display/` 均 200。

部署所需秘密:GitHub secret `CODEX_TT_DEPLOY_KEY`(部署 SSH 私钥),host key 固定在仓库 `deploy/tt-known_hosts`。

## 1Panel 站点与证书

在 1Panel 创建 `codex-status.shemu.top` 的 HTTPS 站点并配置证书,然后设置两个反向代理:

| 公开路径 | 上游 | 要求 |
| --- | --- | --- |
| `/display/` | `http://127.0.0.1:3101` | 保留原始路径;包含静态资源请求 |
| `/` 及其他路径 | `http://127.0.0.1:3100` | 传递原始 Host、协议和请求路径 |

`/display/` 规则必须先于 `/`。如果 1Panel 的代理路径会删掉前缀,请改用保留 `/display/` 的规则;否则展示页资源会返回 404。完成后访问 `https://codex-status.shemu.top/api/health` 和 `https://codex-status.shemu.top/display/`。展示页默认使用这一 HTTPS API origin;管理员也可在 `/settings?tab=display` 配置当前浏览器使用的其他 HTTPS API 地址。跨域来源需加入 Web 的 `DASHBOARD_DISPLAY_ORIGINS` 配置并重启 Web。

登录和 CSRF 校验严格匹配服务器私有 `private/.env` 中的 `APP_ORIGIN`。域名变更后,必须将它更新为新的精确 HTTPS origin `https://codex-status.shemu.top` 并重启 PM2(`pm2 restart dashboard-web`);该值不能带路径,也不支持通配符或自动信任请求 Host。1Panel 应传递原始 Host 和协议。`COLLECTOR_PUBLIC_ORIGIN` 未配置时会使用 `APP_ORIGIN` 生成采集器安装链接。

## 管理和 Token

服务器私有文件 `private/user-token` 存放唯一全局用户 Token,文件权限为 0640。新生成的 Token 为 8 位易辨认的小写字母和数字。登录管理页面或连接独立展示页时使用同一 Token;持有它的人同时拥有管理权限。不要将其写入 1Panel 公共环境、前端构建配置或代码仓库。旧版 `cdu_` 加 43 位 base64url Token 在仍写入该文件时继续兼容;替换为新 Token 后,旧 Token 和旧管理会话都会失效。轮换时保持原有文件权限。

Kindle 等不方便输入 Token 的设备,可直接打开 `https://codex-status.shemu.top/display/#token=<用户 Token>`。展示页会自动连接,并立即清除地址栏中的 Token;`#` 后的内容不会随 HTTP 请求发送。该链接本身仍包含管理 Token,请只在自己的设备中使用。Token 保存在当前浏览器会话中,关闭会话后可再次打开该链接。

首页与独立展示页使用同一套像素面板样式。首页只显示状态和详情,右上角入口进入 `/settings`;账号、设备及展示连接都在设置页管理。独立展示页没有设置表单,首次访问需使用带 Token 的链接,或先在同一浏览器的设置页保存连接信息。

每台设备继续拥有独立随机 deviceId 与设备 Token;服务端数据库仅保存设备 Token 的 SHA-256 哈希。迁移已有设备时需先恢复原数据库和相应的设备 Token 哈希,不能仅复制全局用户 Token。更换服务 URL 后,采集器可通过现有迁移流程验证旧设备身份并切换上报地址。

`private/.env` 中的 `PROVIDER_CREDENTIAL_KEY` 用于解密数据库中的 DeepSeek/Kimi API Key,必须连同数据库备份长期保存。`private/provider-accounts.json` 和 `private/secrets/` 管理文件配置的 Provider;Web 新增的管理账号由 worker 自动刷新。Codex/Kimi CLI 授权位于宿主机 `runtime-auth/` 目录。

worker 的 Codex 额度读取直接请求 ChatGPT 用量 API(`chatgpt.com/backend-api/wham/usage`),凭据为 `runtime-auth/codex/<account-id>/auth.json`,访问令牌过期时由 worker 自行刷新。worker 经 `private/.env` 的 `WORKER_PROXY`(当前 `http://172.22.0.1:7890`,宿主机 mihomo)出站;可选 `WORKER_NO_PROXY`,默认 `localhost,127.0.0.1`。代理只作用于 worker 进程。

额度历史由 worker 每次成功采集时写入 `quota_snapshots`，查询接口只开放最近 90 天；worker 每天清理 90 天前的记录。历史图在额度详情中按 24 小时、7 天、30 天、90 天查看，长范围使用采样趋势，缺失采样会显示断点。历史依赖 worker 持续运行，worker 停机期间不会生成补点；已清理或从未采集的数据无法恢复。升级时必须让迁移服务先应用 `010-quota-history-index.sql`，再启动 Web 和 worker；不需要回填历史。

### 在看板中添加 Codex 账号

管理员登录后打开"设置 → 额度账号 → 添加账号 → Codex 登录",输入账号名称并开始登录。页面显示 OpenAI 官方验证网址和一次性代码;在新窗口完成 ChatGPT 授权后,worker 会读取额度并把账号加入看板。此流程使用 ChatGPT 套餐的 Codex 登录,凭据只存于 worker 的 `runtime-auth` 目录,网页和数据库不保存 OAuth 令牌。

使用前需在个人 ChatGPT 安全设置或工作区权限中启用设备码登录。若页面提示设备码登录不可用,请检查该开关;也可继续使用"CLI 登录"方式配置文件管理的账号。登录请求约 10 分钟后过期,失败或过期时可重新开始。

### 修改文件配置的 Provider

编辑 `private/provider-accounts.json` 或 `private/secrets/` 后,重启 worker 生效:`pm2 restart dashboard-worker`。

## 日常命令

以下命令在服务器上执行:

```sh
pm2 ls
pm2 logs dashboard-web --lines 100
pm2 logs dashboard-worker --lines 100
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:3101/display/ >/dev/null
docker compose --env-file /opt/codex-status-dashboard/private/.env \
  --env-file /opt/codex-status-dashboard/private/compose-edge.env \
  -f "$(/opt/node-v24.21.0-linux-x64/bin/node -p "require('/etc/codex-status-dashboard/ecosystem.config.cjs').apps[0].cwd")/deploy/compose.self-hosted-edge.yaml" ps
```

本地 CLI 自检只报告策略状态与错误代码(在 active release 目录执行,环境同 worker):

```sh
npm run providers:probe -- --provider codex
```

## 回退

- PM2 层面:旧 release 目录保留在 `pm2-releases/`;把 ecosystem 指回旧 release 再 `pm2 startOrReload` 即可(手工执行激活脚本的第 3-5 步,或直接编辑后 reload)。
- 全量回退到 Docker 栈:旧 `app-release-*` 目录、`deploy/compose.self-hosted.yaml` 与旧镜像保留;停 PM2 两个进程后 `docker start codex-status-dashboard-web-1 codex-status-dashboard-worker-1` 恢复(注意 db 端口映射已变为 127.0.0.1:5432,不冲突)。

## 备份与恢复

备份至少包含 PostgreSQL `database` 卷或一致性 `pg_dump`(经 `127.0.0.1:5432`)、`private/` 目录和 `runtime-auth/` 目录;把加密备份存到服务器之外。`runtime-auth/` 含可登录凭据,与 secret 同级处理。

## 一次性引导记录(2026-09-30 完成,重建服务器时参考)

1. 安装 Node 24 到 `/opt/node-v24.21.0-linux-x64`;全局安装(经代理)`@openai/codex@0.146.0`、`@moonshot-ai/kimi-code@2.0.2` 及 linux-x64 平台包,并生成 `/usr/local/bin/kimi-runtime`(`KIMI_CODE_NO_AUTO_UPDATE=1` 包装)——对齐 `deploy/Dockerfile.provider-runtime`。
2. 从旧 worker 容器/卷迁移 `runtime-auth` 到 `/opt/codex-status-dashboard/runtime-auth/`(0700)。
3. 从旧 web 容器拷出 node_modules 作依赖种子 `/opt/codex-status-dashboard/pm2-releases/.seed/`(首次部署曾用于复用;工作流改为每次 `npm ci` 后该目录不再使用,可删除)。
4. 生成部署 SSH 密钥,公钥入 `authorized_keys`,私钥入 GitHub secret `CODEX_TT_DEPLOY_KEY`;`ssh-keyscan` 生成 `deploy/tt-known_hosts`。
5. 用 `deploy/compose.self-hosted-edge.yaml` 重建 db(新增 127.0.0.1:5432 映射)与 display 容器,确认数据正常后停止旧 web/worker 容器(保留不删)。
