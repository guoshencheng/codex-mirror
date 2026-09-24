#!/usr/bin/env bash
set -euo pipefail

# Run after the dashboard collector has been installed on this device.
ROOT="${COLLECTOR_INSTALL_DIR:-$HOME/.local/share/codex-status-dashboard}"
CONFIG="${COLLECTOR_CONFIG:-$HOME/.config/codex-status-dashboard/config.json}"
if [ ! -f "$CONFIG" ]; then
  echo '请先安装 Codex Status Dashboard 采集端。' >&2
  exit 1
fi
NODE_BIN="${COLLECTOR_NODE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  echo '需要 Node.js 24 或更高版本。' >&2
  exit 1
fi
if [ -n "${COLLECTOR_CLI:-}" ]; then
  CLI="$COLLECTOR_CLI"
else
  CLI="$(find "$ROOT/releases" -mindepth 2 -maxdepth 2 -name cli.js -type f -print 2>/dev/null | while IFS= read -r file; do
    stat -f '%m %N' "$file" 2>/dev/null || stat -c '%Y %n' "$file"
  done | sort -nr | sed -n '1p' | cut -d' ' -f2-)"
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  echo '找不到已安装的采集器 cli.js。' >&2
  exit 1
fi
COLLECTOR_CONFIG="$CONFIG" "$NODE_BIN" "$CLI" install-kimi "$@"
