# 部署验收记录

状态截至 2026-09-22。以下仅记录当前仓库/本地环境实际完成的检查；没有 Vercel 项目、托管数据库项目或远程 Provider Runtime 主机，因此没有将合成检查写成线上验收。

| 检查 | 状态 | 证据 / 限制 |
| --- | --- | --- |
| Vercel 配置为 Next.js，未配置额度轮询 Cron 或 standalone 输出 | PASS | 静态部署配置测试 |
| Provider Runtime Compose 不映射端口，配置/secret 为只读挂载，授权使用 named volume | PASS | 静态部署配置测试 |
| Web 数据库池与 Provider Runtime direct URL 使用独立变量 | PASS | Vercel/Compose 配置审查 |
| Health endpoint 不缓存且不回显配置或数据库错误 | PASS | Route Handler 单测 |
| 事件保留清理仅删 30 天前已应用事件，并保留待确认事件、当前 turn 起点和状态表 | PASS | PostgreSQL integration test；同测验证 90 天 quota history 清理且 quota latest 保留 |
| 备份/恢复脚本结构检查 | PASS | shell 语法与静态检查；未对真实数据执行 |
| Docker image 构建及 Compose `config` 解析 | NOT_RUN | 当前开发环境无 Docker CLI |
| Vercel Preview/Production 部署与冷启动 | NOT_RUN | 没有目标 Vercel 项目或域名 |
| 托管 PostgreSQL TLS、pooler 与 direct URL 实际连通 | NOT_RUN | 没有远程数据库项目凭据 |
| 备份恢复至隔离托管 PostgreSQL | NOT_RUN | 未连接远程数据库，也未使用生产数据 |
| Codex CLI 远程授权和重启后 quota probe | NOT_RUN | 没有 Provider Runtime 主机/专用 Codex 账号 |
| DeepSeek 真实 API Key 与余额 probe | NOT_RUN | 没有服务器 secret |
| Kimi Code 精确 pinned version 的 OAuth、持久 server token 和 usage probe | NOT_RUN | Server API 为官方文档标记的 experimental API；需远程账号验证 |
| 设备事件经 Vercel API 到面板及时更新 | NOT_RUN | 需要真实部署和两台已配置设备 |
