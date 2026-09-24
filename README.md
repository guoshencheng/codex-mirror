# Codex Status Dashboard

远程 Codex 状态看板：Next.js 提供管理页面和 API，`display/` 是可独立部署的只读展示页面；Provider 额度由服务端刷新，设备执行状态由采集器上报。

首页 `/` 展示只读像素面板；`/settings` 使用 Ant Design 管理额度账号、采集设备和独立展示连接。独立 `/display/` 复用首页面板样式，仅显示状态与详情。

自托管部署与 1Panel 站点接入见 [部署说明](docs/self-hosted-deployment.md)。

实施计划：`docs/superpowers/plans/2026-09-22-codex-status-dashboard.md`
