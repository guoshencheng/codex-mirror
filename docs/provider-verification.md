# Provider 接口验证记录

日期：2026-09-22。以下区分本地 CLI/协议验证与远程账号实测；未将本机账号用作远程服务凭据。

## 本机运行时信息（不含账号数据）

- Codex CLI：`codex-cli 0.146.0`。`codex app-server --help` 声明默认 stdio transport。协议以临时空 `CODEX_HOME` 生成的 JSON Schema 核对，包含 `initialize`、`initialized`、`account/rateLimits/read`、`account/rateLimits/updated`。
- Kimi Code CLI：`2.0.2`。`kimi web --help` 默认端口 58627，省略 `--host` 绑定 `127.0.0.1`，启用 bearer 鉴权并打印 server token；帮助还提供 `kimi web rotate-token` 来生成持久 server token。仅查询了帮助，未轮换本机 token；实现不使用 `--dangerous-bypass-auth`。
- Kimi Code 官方 Server API 文档声明 `/api/*` 需 bearer token，`GET /api/v1/oauth/usage` 返回 `kind: ok|error`；其 CLI REST/WebSocket 接口标为 experimental，必须在部署端锁定版本并用契约样本校验。
- DeepSeek 官方文档 `GET /user/balance` 返回 `is_available` 和 `balance_infos`，其中金额为十进制字符串并含币种。

## 远程真实账号查询

- Codex 服务端登录、rate limits 实际响应与重启后授权恢复：**NOT_RUN**。尚无目标 Linux 服务器授权环境。
- DeepSeek API Key 实际余额查询：**NOT_RUN**。尚未配置服务器 secret。
- Kimi Code 登录、远程 Runtime 持久 token 初始化、usage 查询与重启续期：**NOT_RUN**。尚未配置服务器授权卷；Provider Runtime 会监管本地 Kimi server 进程并绑定 loopback。

执行命令由 `npm run providers:probe -- --provider <codex|deepseek|kimi-code>` 统一策略 probe 提供。通过判据：进程从服务器发起请求，输出仅包含 providerId、成功/错误代码、指标数和观测时间；重启服务后授权方式已明确且仍可查询。真实账号、token、profile 和响应正文不写入本文件、fixture 或日志。

## 资料

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)
- [Kimi Code Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
