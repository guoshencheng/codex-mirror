# 修复自托管域名登录来源配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让自托管看板登录接受新域名 `https://codex-status.shemu.top` 发来的请求，并让部署文档与线上配置一致。

**Architecture:** 登录接口从 `APP_ORIGIN` 读取固定可信来源，并要求请求的 `Origin` 精确匹配。Compose 将该值注入 Web 容器，因此备份并修改服务器私有 `.env` 后只需重建 Web 服务；`COLLECTOR_PUBLIC_ORIGIN` 未设置时会自动回退到 `APP_ORIGIN`。

**Tech Stack:** Next.js Route Handler、Node.js、Docker Compose、1Panel OpenResty。

**Spec:** `docs/self-hosted-deployment.md`（自托管部署和公开域名说明）。

## Global Constraints

- 生产登录来源必须是精确的 HTTPS origin：`https://codex-status.shemu.top`。
- 不把服务器私有环境文件或其中的密钥提交到 Git。
- 此次只改部署配置和文档，不改认证代码；不新增或运行测试。
- 只重建 Web 容器，并通过容器环境值、HTTPS 健康端点核对生效情况。

## Review Focus

- 新域名的 `Origin`：容器中的 `APP_ORIGIN` 必须与之完全一致。
- 旧域名的 `Origin`：应继续被固定来源校验拒绝，避免隐式信任任意 Host。
- 新域名 HTTPS：证书验证与健康端点应正常。
- 浏览器 Cookie：域名变更后浏览器会为新域名单独保存会话，需在新域名重新登录。
- 采集端链接：未配置 `COLLECTOR_PUBLIC_ORIGIN` 时，生成链接应随 `APP_ORIGIN` 使用新域名。

---

### Task 1：同步自托管部署文档

**Files:**
- Modify: `docs/self-hosted-deployment.md`
- Create: `docs/superpowers/plans/2026-09-24-fix-self-hosted-login-origin.md`

- [ ] 把该部署文档中的公开域名和访问示例更新为 `codex-status.shemu.top`。
- [ ] 检查本计划与现存认证行为、部署方式一致。

### Task 2：更新生产来源并重建 Web

**Files:**
- Runtime config: `/opt/codex-status-dashboard/private/.env`（服务器私有文件，不入库）
- Compose: `/opt/codex-status-dashboard/current/deploy/compose.self-hosted.yaml`

- [ ] 备份私有 `.env`，仅将 `APP_ORIGIN` 更新为 `https://codex-status.shemu.top`，保留权限及其他值。
- [ ] 用现有 Compose 配置重建 Web 容器。
- [ ] 确认 Web 容器拿到新 `APP_ORIGIN`，并通过新域名的 HTTPS 健康检查。

### Task 3：提交并推送

**Files:**
- Commit: `docs/self-hosted-deployment.md`
- Commit: `docs/superpowers/plans/2026-09-24-fix-self-hosted-login-origin.md`

- [ ] 提交中文部署文档和本计划，并推送当前分支。
