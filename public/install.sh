#!/usr/bin/env bash
set -euo pipefail
umask 077
SERVER="${COLLECTOR_SERVER_URL:-https://codex-status-dashboard.vercel.app}"
case "$SERVER" in https://*) ;; *) echo 'COLLECTOR_SERVER_URL must use HTTPS.' >&2; exit 1;; esac
ENROLLMENT_GRANT="${COLLECTOR_ENROLLMENT_GRANT:-}"
unset COLLECTOR_ENROLLMENT_GRANT
if [ -n "$ENROLLMENT_GRANT" ] && { [ "${#ENROLLMENT_GRANT}" -ne 43 ] || [[ ! "$ENROLLMENT_GRANT" =~ ^[A-Za-z0-9_-]+$ ]]; }; then
  echo 'Invalid installer grant. Generate a new link from the Dashboard.' >&2
  exit 1
fi
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'Only macOS and Linux are supported.' >&2; exit 1;; esac
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo '请先安装 Node.js 24 或更高版本，然后重新运行安装命令。' >&2
  exit 1
fi
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
INSTALL_ROOT="${COLLECTOR_INSTALL_DIR:-$HOME/.local/share/codex-status-dashboard}"
mkdir -p "$INSTALL_ROOT/releases"
STAGE="$(mktemp -d "$INSTALL_ROOT/releases/install.XXXXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
PACKAGE_NONCE="$(date +%s)-$$"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$SERVER/collector/collector.tar.gz?v=$PACKAGE_NONCE" -o "$STAGE/collector.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$SERVER/collector/collector.sha256?v=$PACKAGE_NONCE" -o "$STAGE/collector.sha256"
node --input-type=module - "$STAGE" <<'JS'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const p=process.argv[2];
const expected=readFileSync(p+'/collector.sha256','utf8').trim();
const actual=createHash('sha256').update(readFileSync(p+'/collector.tar.gz')).digest('hex');
if (!/^[a-f0-9]{64}$/.test(expected)||actual!==expected) throw new Error('下载校验失败，请重试');
JS
# Extract only the three expected regular files, ignoring archive-supplied paths.
for FILE in cli.js setup.js package.json; do
  tar -xOzf "$STAGE/collector.tar.gz" "$FILE" > "$STAGE/$FILE"
done
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund)
node --input-type=module - "$STAGE" <<'JS'
import {createRequire} from 'node:module';
const require=createRequire(process.argv[2]+'/package.json');
const Database=require('better-sqlite3'); const db=new Database(':memory:');db.close();
JS
VERSION="$(cat "$STAGE/collector.sha256")-$(date +%s)"
RELEASE="$INSTALL_ROOT/releases/$VERSION"
mv "$STAGE" "$RELEASE"
trap - EXIT
export COLLECTOR_SERVER_URL="$SERVER"
if [ -n "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" ]; then
  export NODE_USE_ENV_PROXY=1
fi
COLLECTOR_ENROLLMENT_GRANT="$ENROLLMENT_GRANT" node "$RELEASE/setup.js" "$@"
echo '采集端安装完成。'
