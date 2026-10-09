# 会话采集已退役

更新日期：2026-10-10。

Dashboard 不再追踪 Codex/Kimi 会话。Hooks、设备注册、collector 上传服务和对应安装入口已经移除。Provider 额度由服务端查询，不依赖用户设备上的 collector。

已有安装不会被服务端远程卸载。请在曾安装 collector 的设备上停止后台服务、移除受管理的 Hooks 配置。

## 停止后台服务

macOS：

```sh
launchctl bootout "gui/$(id -u)/com.codex-status-dashboard.collector" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.codex-status-dashboard.collector.plist"
```

Linux：

```sh
systemctl --user disable --now codex-status-dashboard.service
rm -f "$HOME/.config/systemd/user/codex-status-dashboard.service"
systemctl --user daemon-reload
```

## 移除 Hooks

Codex 安装器保留了一个仅移除本产品标记项的命令。用当前设备原有安装目录中的 `cli.js` 执行；命令会保留其他用户 Hooks：

```sh
node "$HOME/.local/share/codex-status-dashboard/releases/<版本目录>/cli.js" uninstall
```

Kimi Code 的托管规则位于 `~/.kimi-code/config.toml`，请删除以下标记之间的内容，并保留文件中的其他配置：

```toml
# BEGIN codex-status-dashboard Kimi hooks
...
# END codex-status-dashboard Kimi hooks
```

## 本地队列与配置

旧安装的配置和队列通常位于 `~/.config/codex-status-dashboard/`。停止服务后，这些文件不再被 Dashboard 使用；如果队列中还有待上传事件，可先按本机数据保留策略检查，再决定是否删除。
