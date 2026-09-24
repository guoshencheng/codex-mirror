# 自托管服务与独立展示端设计

日期：2026-09-23
状态：用户要求直接改造与部署；公开站点和证书由用户随后在 1Panel 配置。

## 目标

将现有 Codex Status Dashboard 部署到 `root@180.184.45.232`，公开域名为 `codex-status.icerock.top`。后端继续提供管理界面与 API；另交付可独立构建和部署的只读展示页面。展示页面在运行时设置 API 地址和用户 Token。当前硬件型号不在本次范围。

## 保留的边界

- 采集器继续使用每设备 Token。数据库只保存 Token 的 SHA-256 哈希；设备 ID 和本地队列绑定、事件顺序及迁移前身份检查保持不变。
- PostgreSQL 继续保存设备、会话、额度和管理数据。Provider CLI 授权目录和 Provider 凭据留在服务器。
- 不占用服务器已有的 80、443、3000 端口，也不修改已有 1Panel 站点。公开站点和证书由用户随后配置。

## 服务划分

服务器上以 Docker Compose 启动 PostgreSQL、Next.js Web/API、Provider Runtime 和静态展示服务。PostgreSQL 不对公网映射；Web/API 与静态展示服务仅映射到 loopback 上的不同端口，供 1Panel OpenResty 以后反向代理。Next.js 的 `/` 和 `/devices` 保留管理功能；静态展示服务提供独立 HTML/CSS/JavaScript 资源。展示页面默认连接 `https://codex-status.icerock.top`，也允许用户在运行时指定其他 HTTPS API origin。

展示页面只读最新快照，每 10 秒轮询，网络中断时保留上次成功快照并显示过期时间。服务端公开一个专门的 Bearer Token 只读快照接口，返回现有 `DashboardDto` 或其版本化子集，响应禁止共享缓存。跨域时只允许显式配置的展示页面 origin；同源部署不需要 CORS。

全局用户 Token 在服务器私有配置文件中生成和保存，不入数据库，也不编入前端资源。管理界面登录验证该 Token，签发短期 HttpOnly 会话 Cookie；独立展示页直接用该 Token 调用只读接口。共享用户 Token 的持有者也能登录管理界面，这是用户选择的单 Token 权限边界。采集器的设备 Token 不受用户 Token 轮换影响。已有管理员数据库表暂留作兼容，不再存储新的用户 Token。登录仍实施限速；有 Cookie 的管理写请求继续校验来源与 CSRF。

Provider Runtime 负责定时刷新配置文件账号和面板新增账号，页面可见性不再决定额度是否更新。独立展示端不触发上游 Provider 查询。

## 部署和迁移

部署目录独立于现有项目，秘密配置不进 Git、不进镜像。启动流程为：生成私有配置、构建镜像、启动数据库、执行迁移、启动服务、在 loopback 上验证健康检查、Token 鉴权、展示页和事件接收。公开 HTTPS 需在用户完成 1Panel 站点与证书后再验收。域名目前经 Cloudflare 转发但 HTTPS 返回 525，源站尚无该域名的 TLS 站点；此状态不应作为应用健康判断。

设备迁移仍按原流程：若采集器 URL 变化，新服务先恢复包含设备 Token 哈希的数据库，安装脚本验证旧 Token 与原设备 ID 对应后才变更 URL。本次不自动重注册已有设备，也不清空本地队列。

## 验收

- 后端内部健康检查、管理员 Token 登录和只读 Bearer 快照请求可用；无 Token 和错误 Token 返回 401。
- 独立展示端可修改 API 地址；网络失败时保留并标注最近成功快照。
- 采集器原有身份和事件流程的回归测试通过。
- 在目标服务器上，容器健康、数据库迁移完成、服务只监听 loopback；已有站点和 3000 端口不受影响。
- 公开 HTTPS 验收在用户完成域名站点和证书配置后执行。
