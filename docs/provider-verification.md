# Provider 接口验证记录

日期：2026-09-22。以下区分本地 CLI/协议验证与远程账号实测；未将本机账号用作远程服务凭据。

## 本机运行时信息（不含账号数据）

- Codex CLI：`codex-cli 0.146.0`。`codex app-server --help` 声明默认 stdio transport。协议以临时空 `CODEX_HOME` 生成的 JSON Schema 核对，包含 `initialize`、`initialized`、`account/rateLimits/read`、`account/rateLimits/updated`。
- Kimi Code CLI：`2.0.2`。部署镜像使用当前官方 npm 包 `@moonshot-ai/kimi-code@2.0.2`，由它提供 `kimi` 命令。官方命令参考确认 `kimi web --no-open --host 127.0.0.1` 可用；`kimi web` 默认 loopback、端口 58627，并以 bearer token 保护 API。`kimi web rotate-token` 把持久 token 写到 `~/.kimi-code/server.token`。本机仅查询版本和帮助，未轮换本机 token；实现不使用 `--dangerous-bypass-auth`。
- 当前 [Kimi Code Server API 文档](https://moonshotai.github.io/kimi-code/en/reference/server-api.html) 声明 `/api/*` 需 bearer token，`GET /api/v1/oauth/usage` 返回 `kind: ok|error` 和 quota/extraUsage 数据；官方将 CLI REST/WebSocket API 标为 experimental，部署端需锁定版本并校验契约样本。旧 `MoonshotAI/kimi-cli` 仓库已归档，不再用作安装依据。
- DeepSeek 官方文档 `GET /user/balance` 返回 `is_available` 和 `balance_infos`，其中金额为十进制字符串并含币种。

## 远程真实账号查询

- Codex 服务端登录、rate limits 实际响应与重启后授权恢复：**NOT_RUN**。尚无目标 Linux 服务器授权环境。
- DeepSeek API Key 实际余额查询：**NOT_RUN**。尚未配置服务器 secret。
- Kimi Code 登录、远程 Runtime 持久 token 初始化、从受限 secret 文件读取 bearer token、usage 查询与重启续期：**NOT_RUN**。尚未配置服务器授权卷；Provider Runtime 会监管本地 Kimi server 进程并绑定 loopback。目标主机需验证精确版本对 `KIMI_CODE_HOME`/`HOME` 的使用、`server.token` 权限与 token 轮换后客户端可见性；不把 token 放到环境变量或日志。

执行命令由 `npm run providers:probe -- --provider <codex|deepseek|kimi-code>` 统一策略 probe 提供。通过判据：进程从服务器发起请求，输出仅包含 providerId、成功/错误代码、指标数和观测时间；重启服务后授权方式已明确且仍可查询。真实账号、token、profile 和响应正文不写入本文件、fixture 或日志。

## 资料

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)
- [Kimi Code CLI 安装](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [Kimi Code CLI 命令参考](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)
- [Kimi Code Server API（当前文档）](https://moonshotai.github.io/kimi-code/en/reference/server-api.html)
